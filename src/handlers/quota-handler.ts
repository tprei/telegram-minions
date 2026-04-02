import type { CompletionHandler, SessionCompletionContext } from "./handler-types.js"
import type { Observer } from "../telegram/observer.js"
import { writeSessionLog } from "../session/session-log.js"

export interface QuotaEventStore {
  get(threadId: number): { rawMessage: string } | undefined
  delete(threadId: number): boolean
}

export interface QuotaSleepHandler {
  handleQuotaSleep(topicSession: import("../types.js").TopicSession, rawMessage: string): void
}

export class QuotaHandler implements CompletionHandler {
  readonly name = "QuotaHandler"

  constructor(
    private readonly observer: Observer,
    private readonly quotaEvents: QuotaEventStore,
    private readonly quotaSleepHandler: QuotaSleepHandler,
  ) {}

  async handle(ctx: SessionCompletionContext): Promise<void> {
    const { topicSession, meta, state, durationMs } = ctx
    const quotaEvent = this.quotaEvents.get(topicSession.threadId)

    if (quotaEvent && state === "quota_exhausted") {
      this.quotaEvents.delete(topicSession.threadId)
      this.observer.onSessionComplete(meta, "errored", durationMs).catch(() => {})
      writeSessionLog(topicSession, meta, "errored", durationMs)
      this.quotaSleepHandler.handleQuotaSleep(topicSession, quotaEvent.rawMessage)
      ctx.handled = true
      return
    }

    this.quotaEvents.delete(topicSession.threadId)

    if (state === "quota_exhausted") {
      ctx.handled = true
    }
  }
}
