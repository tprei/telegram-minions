import type { ChatPlatform } from "../provider/chat-platform.js"
import type { Observer } from "../telegram/observer.js"
import type { TopicSession } from "../domain/session-types.js"
import type { CompletionHandler, SessionCompletionContext } from "./handler-types.js"
import {
  formatThinkComplete,
  formatReviewComplete,
  formatDagReviewComplete,
  formatPlanComplete,
} from "../telegram/format.js"
import { writeSessionLog } from "../session/session-log.js"
import { loggers } from "../logger.js"

export interface PinnedMessages {
  updateTopicTitle(topicSession: TopicSession, stateEmoji: string): Promise<void>
}

const CONVERSATIONAL_MODES = new Set(["think", "review", "dag-review", "plan"])

const MODE_FORMATTERS: Record<string, (slug: string) => string> = {
  think: formatThinkComplete,
  review: formatReviewComplete,
  "dag-review": formatDagReviewComplete,
  plan: formatPlanComplete,
}

export class ModeCompletionHandler implements CompletionHandler {
  readonly name = "ModeCompletionHandler"

  constructor(
    private readonly platform: ChatPlatform,
    private readonly observer: Observer,
    private readonly pinnedMessages: PinnedMessages,
  ) {}

  async handle(ctx: SessionCompletionContext): Promise<void> {
    const { topicSession, meta, state, durationMs, sessionId } = ctx

    if (CONVERSATIONAL_MODES.has(topicSession.mode)) {
      this.pinnedMessages.updateTopicTitle(topicSession, "💬").catch(() => {})
      this.observer.onSessionComplete(meta, state, durationMs).catch((err) => {
        loggers.observer.error({ err, sessionId }, "onSessionComplete error")
      })
      const formatter = MODE_FORMATTERS[topicSession.mode]
      if (formatter) {
        this.platform.chat.sendMessage(
          formatter(topicSession.slug),
          String(topicSession.threadId),
        ).catch(() => {})
      }
      writeSessionLog(topicSession, meta, state, durationMs)
      ctx.handled = true
      return
    }

    if (state === "errored") {
      topicSession.lastState = "errored"
      this.pinnedMessages.updateTopicTitle(topicSession, "❌").catch(() => {})
      this.observer.onSessionComplete(meta, state, durationMs).catch((err) => {
        loggers.observer.error({ err, sessionId }, "onSessionComplete error")
      })
      writeSessionLog(topicSession, meta, state, durationMs)
      ctx.handled = true
    }
  }
}
