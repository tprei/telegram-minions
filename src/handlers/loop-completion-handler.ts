import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { CompletionHandler, SessionCompletionContext } from "./handler-types.js"
import type { LoopOutcome, LoopOutcomeResult } from "../loops/domain-types.js"
import type { ChatPlatform } from "../provider/chat-platform.js"
import { extractPRUrl, findPRByBranch } from "../ci/ci-babysit.js"
import { createLogger } from "../logger.js"

const execFileAsync = promisify(execFile)

const log = createLogger({ component: "loop-completion-handler" })

const CONSECUTIVE_ERROR_ALERT_THRESHOLD = 3

export interface LoopOutcomeRecorder {
  recordOutcome(loopId: string, outcome: LoopOutcome): void
  getStates(): Map<string, import("../loops/domain-types.js").LoopState>
  getDefinitions(): Map<string, import("../loops/domain-types.js").LoopDefinition>
}

export interface LoopSchedulerProvider {
  get(): LoopOutcomeRecorder | null
}

export interface LoopThreadCleaner {
  removeWorkspace(topicSession: import("../domain/session-types.js").WorkspaceRef): Promise<void>
  deleteTopicSession(threadId: number): void
  broadcastSessionDeleted(slug: string): void
}

export class LoopCompletionHandler implements CompletionHandler {
  readonly name = "LoopCompletionHandler"

  constructor(
    private readonly schedulerProvider: LoopSchedulerProvider,
    private readonly platform: ChatPlatform,
    private readonly cleaner: LoopThreadCleaner,
  ) {}

  async handle(ctx: SessionCompletionContext): Promise<void> {
    const { topicSession, meta, state } = ctx
    if (!topicSession.loopId) return

    const scheduler = this.schedulerProvider.get()
    if (!scheduler) return

    const loopId = topicSession.loopId

    let prUrl = this.extractPR(ctx)

    // If the session completed without a PR, check for unpushed changes and create one
    if (!prUrl && state === "completed") {
      prUrl = await this.ensurePR(topicSession.cwd, topicSession.slug).catch((err) => {
        log.error({ err, loopId, threadId: topicSession.threadId }, "ensurePR failed")
        return null
      })
    }

    const result = this.mapOutcomeResult(state, prUrl)

    const outcome: LoopOutcome = {
      runNumber: this.getNextRunNumber(scheduler, loopId),
      startedAt: meta.startedAt,
      finishedAt: Date.now(),
      result,
      prUrl: prUrl ?? undefined,
      error: state === "errored" ? "session errored" : undefined,
      threadId: topicSession.threadId,
    }

    scheduler.recordOutcome(loopId, outcome)
    log.info({ loopId, result, prUrl, threadId: topicSession.threadId }, "loop completion handled")

    if (result === "errored" || result === "quota_exhausted") {
      await this.checkConsecutiveErrors(scheduler, loopId)
    }

    // Auto-close the loop thread — outcome is recorded in scheduler state
    this.closeThread(topicSession).catch((err) => {
      log.error({ err, loopId, threadId: topicSession.threadId }, "failed to auto-close loop thread")
    })

    ctx.handled = true
  }

  private async closeThread(topicSession: SessionCompletionContext["topicSession"]): Promise<void> {
    const threadId = topicSession.threadId
    this.cleaner.deleteTopicSession(threadId)
    this.cleaner.broadcastSessionDeleted(topicSession.slug)
    await this.platform.threads.deleteThread(String(threadId))
    await this.cleaner.removeWorkspace(topicSession)
    log.info({ slug: topicSession.slug, threadId }, "auto-closed loop thread")
  }

  /**
   * If the agent made commits but didn't push or open a PR, do it now
   * so the work isn't lost when the worktree is cleaned up.
   */
  private async ensurePR(cwd: string, slug: string): Promise<string | null> {
    // Check if there are commits ahead of the remote tracking branch
    const branch = (await execFileAsync("git", ["branch", "--show-current"], { cwd })).stdout.trim()
    if (!branch) return null

    // Check if the branch has an upstream; if not, it was never pushed
    let hasUpstream = true
    try {
      await execFileAsync("git", ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], { cwd })
    } catch {
      hasUpstream = false
    }

    // Count unpushed commits (or all commits if no upstream)
    let unpushedCount: number
    if (hasUpstream) {
      const result = await execFileAsync("git", ["rev-list", "--count", `${branch}@{upstream}..HEAD`], { cwd })
      unpushedCount = parseInt(result.stdout.trim(), 10)
    } else {
      // No upstream — count commits since the branch diverged from main/master
      const result = await execFileAsync("git", ["rev-list", "--count", "HEAD", "--not", "--remotes"], { cwd })
      unpushedCount = parseInt(result.stdout.trim(), 10)
    }

    if (unpushedCount === 0) return null

    log.info({ branch, unpushedCount, slug }, "loop session has unpushed commits — pushing and creating PR")

    // Push the branch
    await execFileAsync("git", ["push", "-u", "origin", branch], { cwd })

    // Check if a PR already exists for this branch
    const existingPr = await findPRByBranch(branch, cwd)
    if (existingPr) return existingPr

    // Get the first commit message to use as PR title
    const firstCommitMsg = (
      await execFileAsync("git", ["log", "--reverse", "--format=%s", `origin/HEAD..${branch}`], { cwd })
        .catch(() => execFileAsync("git", ["log", "-1", "--format=%s"], { cwd }))
    ).stdout.trim().split("\n")[0]

    const title = `[minions] ${firstCommitMsg || slug}`

    const prResult = await execFileAsync(
      "gh",
      ["pr", "create", "--title", title, "--body", `Automated loop PR from session \`${slug}\`.`, "--head", branch],
      { cwd },
    )
    const prUrl = prResult.stdout.trim()
    log.info({ prUrl, branch, slug }, "created PR for loop session")
    return prUrl || null
  }

  private extractPR(ctx: SessionCompletionContext): string | null {
    if (ctx.prUrl) return ctx.prUrl
    if (ctx.topicSession.prUrl) return ctx.topicSession.prUrl

    for (let i = ctx.topicSession.conversation.length - 1; i >= 0; i--) {
      const msg = ctx.topicSession.conversation[i]
      if (msg.role === "assistant") {
        const url = extractPRUrl(msg.text)
        if (url) return url
      }
    }
    return null
  }

  private mapOutcomeResult(state: string, prUrl: string | null): LoopOutcomeResult {
    if (state === "quota_exhausted") return "quota_exhausted"
    if (state === "errored") return "errored"
    if (prUrl) return "pr_opened"
    return "no_findings"
  }

  private getNextRunNumber(scheduler: LoopOutcomeRecorder, loopId: string): number {
    const state = scheduler.getStates().get(loopId)
    return (state?.totalRuns ?? 0) + 1
  }

  private async checkConsecutiveErrors(scheduler: LoopOutcomeRecorder, loopId: string): Promise<void> {
    const state = scheduler.getStates().get(loopId)
    if (!state) return

    const failures = state.consecutiveFailures
    if (failures < CONSECUTIVE_ERROR_ALERT_THRESHOLD) return

    const def = scheduler.getDefinitions().get(loopId)
    const name = def?.name ?? loopId
    const maxFailures = def?.maxConsecutiveFailures ?? 5
    const disabled = !state.enabled

    const recentErrors = state.outcomes
      .filter((o) => o.result === "errored" || o.result === "quota_exhausted")
      .slice(-CONSECUTIVE_ERROR_ALERT_THRESHOLD)

    const errorSummary = recentErrors
      .map((o, i) => `  ${i + 1}. <code>${o.result}</code> — run #${o.runNumber}${o.error ? ` (${o.error})` : ""}`)
      .join("\n")

    const statusLine = disabled
      ? `🚫 <b>Auto-disabled</b> after ${failures}/${maxFailures} consecutive failures.`
      : `⚠️ ${failures} consecutive failures (auto-disables at ${maxFailures}).`

    const html = [
      `🔄 <b>Loop alert: ${name}</b>`,
      "",
      statusLine,
      "",
      "<b>Recent errors:</b>",
      errorSummary,
    ].join("\n")

    try {
      await this.platform.chat.sendMessage(html)
    } catch (err) {
      log.error({ err, loopId }, "failed to send loop error alert")
    }
  }
}
