import type { DispatcherContext } from "../orchestration/dispatcher-context.js"
import type { TopicSession } from "../domain/session-types.js"
import type { QualityReport } from "./quality-gates.js"
import { runQualityGates } from "./quality-gates.js"
import {
  waitForCI,
  getFailedCheckLogs,
  buildCIFixPrompt,
  buildQualityGateFixPrompt,
  buildMergeConflictPrompt,
  checkPRMergeability,
} from "./ci-babysit.js"
import {
  formatCIWatching,
  formatCIFailed,
  formatCIFixing,
  formatCIPassed,
  formatCIGaveUp,
  formatCIConflicts,
  formatCIResolvingConflicts,
  formatCINoChecks,
} from "../telegram/format.js"
import { captureException } from "../sentry.js"
import { loggers } from "../logger.js"

const log = loggers.dispatcher

export interface PendingBabysitEntry {
  childSession: TopicSession
  prUrl: string
  qualityReport?: QualityReport
}

/**
 * CIBabysitter — extracted from Dispatcher.
 *
 * Owns PR babysitting, CI monitoring, merge-conflict resolution,
 * and deferred babysit queuing for split children.
 */
export class CIBabysitter {
  readonly pendingBabysitPRs = new Map<string, PendingBabysitEntry[]>()
  private readonly ctx: DispatcherContext

  constructor(ctx: DispatcherContext) {
    this.ctx = ctx
  }

  /**
   * Queue a child session's PR for deferred babysitting (used by split children).
   */
  queueDeferredBabysit(parentThreadId: string, entry: PendingBabysitEntry): void {
    const queue = this.pendingBabysitPRs.get(parentThreadId) ?? []
    queue.push(entry)
    this.pendingBabysitPRs.set(parentThreadId, queue)
  }

  /**
   * Run all deferred babysit entries for a parent session in parallel.
   */
  async runDeferredBabysit(parentThreadId: string): Promise<void> {
    const entries = this.pendingBabysitPRs.get(parentThreadId)
    if (!entries || entries.length === 0) return
    this.pendingBabysitPRs.delete(parentThreadId)

    await Promise.allSettled(
      entries.map(({ childSession, prUrl, qualityReport }) =>
        this.babysitPR(childSession, prUrl, qualityReport).catch((err) => {
          log.error({ err, prUrl }, "deferred babysitPR error")
          captureException(err, { operation: "deferredBabysitPR", prUrl })
        }),
      ),
    )
  }

  /**
   * Watch a PR's CI checks, resolve merge conflicts, and spawn CI-fix agents
   * until checks pass or retries are exhausted.
   */
  async babysitPR(topicSession: TopicSession, prUrl: string, initialQualityReport?: QualityReport): Promise<void> {
    const ac = new AbortController()
    this.ctx.abortControllers.set(topicSession.threadId, ac)
    const signal = ac.signal
    try {
      await this._babysitPR(topicSession, prUrl, signal, initialQualityReport)
    } finally {
      this.ctx.abortControllers.delete(topicSession.threadId)
    }
  }

  private async _babysitPR(topicSession: TopicSession, prUrl: string, signal: AbortSignal, initialQualityReport?: QualityReport): Promise<void> {
    await this.ctx.refreshGitToken()
    const maxRetries = this.ctx.config.ci.maxRetries
    let localReport: QualityReport | undefined = initialQualityReport && !initialQualityReport.allPassed
      ? initialQualityReport
      : undefined

    await this.ctx.telegram.sendMessage(
      formatCIWatching(topicSession.slug, prUrl),
      topicSession.threadId,
    )

    log.info({ prUrl, maxRetries }, "watching CI for PR")

    // Check for merge conflicts before polling CI
    let mergeState = await checkPRMergeability(prUrl, topicSession.cwd)
    if (mergeState === "UNKNOWN") {
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      mergeState = await checkPRMergeability(prUrl, topicSession.cwd)
    }

    // Auto-resolve merge conflicts if detected
    for (let conflictAttempt = 1; conflictAttempt <= maxRetries && mergeState === "CONFLICTING"; conflictAttempt++) {
      if (signal.aborted) return
      await this.ctx.telegram.sendMessage(
        formatCIResolvingConflicts(topicSession.slug, prUrl, conflictAttempt, maxRetries),
        topicSession.threadId,
      )

      log.info({ prUrl, conflictAttempt, maxRetries }, "spawning merge conflict resolution session")

      const conflictPrompt = buildMergeConflictPrompt(prUrl, conflictAttempt, maxRetries)
      topicSession.mode = "ci-fix"
      this.ctx.pushToConversation(topicSession, { role: "user", text: conflictPrompt })

      await new Promise<void>((resolve) => {
        this.ctx.spawnCIFixAgent(topicSession, conflictPrompt, () => resolve())
      })

      log.info({ prUrl, conflictAttempt, maxRetries }, "merge conflict resolution session completed")

      // Re-check mergeability after fix attempt
      mergeState = await checkPRMergeability(prUrl, topicSession.cwd)
      if (mergeState === "UNKNOWN") {
        await new Promise((resolve) => setTimeout(resolve, 5_000))
        mergeState = await checkPRMergeability(prUrl, topicSession.cwd)
      }

      if (mergeState === "CONFLICTING") {
        if (conflictAttempt < maxRetries) {
          log.warn({ prUrl, conflictAttempt }, "PR still has merge conflicts, retrying")
        } else {
          await this.ctx.telegram.sendMessage(
            formatCIConflicts(topicSession.slug, prUrl),
            topicSession.threadId,
          )
          log.warn({ prUrl, maxRetries }, "PR still has merge conflicts after max attempts, aborting")
          topicSession.mode = "task"
          return
        }
      }
    }

    if (mergeState !== "MERGEABLE") {
      log.warn({ prUrl }, "PR mergeability unknown, proceeding with CI watch")
    }

    if (signal.aborted) return
    const result = await waitForCI(prUrl, topicSession.cwd, this.ctx.config.ci, signal)
    if (signal.aborted) return

    if (result.passed && localReport == null) {
      await this.ctx.telegram.sendMessage(
        formatCIPassed(topicSession.slug, prUrl),
        topicSession.threadId,
      )
      log.info({ prUrl }, "CI passed")
      return
    }

    if (result.timedOut && result.checks.length === 0 && localReport == null) {
      await this.ctx.telegram.sendMessage(
        formatCINoChecks(topicSession.slug, prUrl),
        topicSession.threadId,
      )
      log.info({ prUrl }, "no CI checks found, skipping babysit")
      return
    }

    const failedChecks = result.checks.filter((c) => c.bucket === "fail")
    const hasRemoteFailures = failedChecks.length > 0

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal.aborted) return
      const failedGateNames = localReport != null
        ? localReport.results.filter((r) => !r.passed).map((r) => r.gate)
        : []
      const allFailedNames = [
        ...failedChecks.map((c) => c.name),
        ...failedGateNames.map((g) => `local:${g}`),
      ]

      await this.ctx.telegram.sendMessage(
        formatCIFailed(topicSession.slug, allFailedNames, attempt, maxRetries),
        topicSession.threadId,
      )

      let fixPrompt: string
      if (hasRemoteFailures) {
        const failureDetails = await getFailedCheckLogs(prUrl, topicSession.cwd)
        fixPrompt = buildCIFixPrompt(prUrl, failedChecks, failureDetails, attempt, maxRetries)
        if (localReport != null) {
          fixPrompt += "\n\n" + buildQualityGateFixPrompt(prUrl, localReport, attempt, maxRetries)
        }
      } else {
        fixPrompt = buildQualityGateFixPrompt(prUrl, localReport!, attempt, maxRetries)
      }

      await this.ctx.telegram.sendMessage(
        formatCIFixing(topicSession.slug, attempt, maxRetries),
        topicSession.threadId,
      )

      log.info({ prUrl, attempt, maxRetries }, "spawning CI fix session")

      topicSession.mode = "ci-fix"
      this.ctx.pushToConversation(topicSession, { role: "user", text: fixPrompt })

      await new Promise<void>((resolve) => {
        this.ctx.spawnCIFixAgent(topicSession, fixPrompt, () => resolve())
      })

      log.info({ prUrl, attempt, maxRetries }, "CI fix session completed")

      // Re-run local quality gates after fix attempt
      let localFixed = true
      if (localReport != null) {
        try {
          localReport = runQualityGates(topicSession.cwd)
          localFixed = localReport.allPassed
          if (!localFixed) {
            log.warn({ prUrl, attempt }, "local quality gates still failing after fix attempt")
          } else {
            localReport = undefined
          }
        } catch (err) {
          log.error({ err, prUrl }, "quality gates re-check error")
        }
      }

      // Re-check for merge conflicts before polling CI again
      const retryMergeState = await checkPRMergeability(prUrl, topicSession.cwd)
      if (retryMergeState === "CONFLICTING") {
        await this.ctx.telegram.sendMessage(
          formatCIConflicts(topicSession.slug, prUrl),
          topicSession.threadId,
        )
        log.warn({ prUrl, attempt }, "PR has merge conflicts after fix attempt, aborting")
        topicSession.mode = "task"
        return
      }

      if (signal.aborted) return
      const recheck = await waitForCI(prUrl, topicSession.cwd, this.ctx.config.ci, signal)
      if (signal.aborted) return

      if (recheck.passed && localFixed) {
        await this.ctx.telegram.sendMessage(
          formatCIPassed(topicSession.slug, prUrl),
          topicSession.threadId,
        )
        log.info({ prUrl, attempt }, "CI passed after fix attempt")
        topicSession.mode = "task"
        return
      }

      const newFailed = recheck.checks.filter((c) => c.bucket === "fail")
      if (newFailed.length > failedChecks.length) {
        log.warn({ prUrl, from: failedChecks.length, to: newFailed.length }, "CI failures grew, aborting")
        break
      }
    }

    await this.ctx.telegram.sendMessage(
      formatCIGaveUp(topicSession.slug, maxRetries),
      topicSession.threadId,
    )
    topicSession.mode = "task"
  }

  /**
   * Run inline CI check for a DAG child. Returns true if CI passed (or was fixed).
   */
  async babysitDagChildCI(childSession: TopicSession, prUrl: string): Promise<boolean> {
    const ac = new AbortController()
    this.ctx.abortControllers.set(childSession.threadId, ac)
    try {
      return await this._babysitDagChildCI(childSession, prUrl, ac.signal)
    } finally {
      this.ctx.abortControllers.delete(childSession.threadId)
    }
  }

  private async _babysitDagChildCI(childSession: TopicSession, prUrl: string, signal: AbortSignal): Promise<boolean> {
    await this.ctx.refreshGitToken()
    const result = await waitForCI(prUrl, childSession.cwd, this.ctx.config.ci, signal)
    if (signal.aborted) return false

    if (result.passed) {
      await this.ctx.telegram.sendMessage(
        formatCIPassed(childSession.slug, prUrl),
        childSession.threadId,
      )
      return true
    }

    if (result.timedOut && result.checks.length === 0) {
      await this.ctx.telegram.sendMessage(
        formatCINoChecks(childSession.slug, prUrl),
        childSession.threadId,
      )
      return true // No checks = treat as passed
    }

    const failedChecks = result.checks.filter((c) => c.bucket === "fail")
    if (failedChecks.length === 0) return true

    // Attempt CI fix
    const maxRetries = this.ctx.config.ci.maxRetries
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal.aborted) return false
      await this.ctx.telegram.sendMessage(
        formatCIFailed(childSession.slug, failedChecks.map((c) => c.name), attempt, maxRetries),
        childSession.threadId,
      )

      const failureDetails = await getFailedCheckLogs(prUrl, childSession.cwd)
      const fixPrompt = buildCIFixPrompt(prUrl, failedChecks, failureDetails, attempt, maxRetries)

      await this.ctx.telegram.sendMessage(
        formatCIFixing(childSession.slug, attempt, maxRetries),
        childSession.threadId,
      )

      childSession.mode = "ci-fix"
      this.ctx.pushToConversation(childSession, { role: "user", text: fixPrompt })

      await new Promise<void>((resolve) => {
        this.ctx.spawnCIFixAgent(childSession, fixPrompt, () => resolve())
      })

      if (signal.aborted) return false
      const recheck = await waitForCI(prUrl, childSession.cwd, this.ctx.config.ci, signal)
      if (signal.aborted) return false
      if (recheck.passed) {
        await this.ctx.telegram.sendMessage(
          formatCIPassed(childSession.slug, prUrl),
          childSession.threadId,
        )
        childSession.mode = "task"
        return true
      }
    }

    await this.ctx.telegram.sendMessage(
      formatCIGaveUp(childSession.slug, maxRetries),
      childSession.threadId,
    )
    childSession.mode = "task"
    return false
  }
}
