import type { CompletionHandler, SessionCompletionContext } from "./handler-types.js"
import type { LoopOutcome, LoopOutcomeResult } from "../loops/domain-types.js"
import { extractPRUrl } from "../ci/ci-babysit.js"
import { createLogger } from "../logger.js"

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

export interface LoopTelegramNotifier {
  sendMessage(html: string, threadId?: number): Promise<{ ok: boolean; messageId: number | null }>
}

export class LoopCompletionHandler implements CompletionHandler {
  readonly name = "LoopCompletionHandler"

  constructor(
    private readonly schedulerProvider: LoopSchedulerProvider,
    private readonly telegram: LoopTelegramNotifier,
  ) {}

  async handle(ctx: SessionCompletionContext): Promise<void> {
    const { topicSession, meta, state } = ctx
    if (!topicSession.loopId) return

    const scheduler = this.schedulerProvider.get()
    if (!scheduler) return

    const loopId = topicSession.loopId

    const prUrl = this.extractPR(ctx)
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

    ctx.handled = true
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
      await this.telegram.sendMessage(html)
    } catch (err) {
      log.error({ err, loopId }, "failed to send loop error alert")
    }
  }
}
