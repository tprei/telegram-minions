import type { ChatPlatform } from "../provider/chat-platform.js"
import type { Observer } from "../telegram/observer.js"
import type { TopicSession } from "../domain/session-types.js"
import type { CompletionHandler, SessionCompletionContext } from "./handler-types.js"
import { formatTaskComplete } from "../telegram/format.js"
import { writeSessionLog } from "../session/session-log.js"
import { loggers } from "../logger.js"

export interface ArtifactCleaner {
  cleanBuildArtifacts(cwd: string): void
}

export interface PinnedMessages {
  updateTopicTitle(topicSession: TopicSession, stateEmoji: string): Promise<void>
}

/**
 * Orchestrates the task-mode completion flow:
 * 1. Sets lastState and updates topic title
 * 2. Flushes observer and sends completion message
 * 3. Delegates to the remaining chain (quality gates, digest, CI babysit)
 * 4. Writes session log
 * 5. Cleans build artifacts
 *
 * This handler only fires for `state === "completed"` when mode is NOT
 * conversational (think/review/plan) and NOT ship-mode.
 */
export class TaskCompletionHandler implements CompletionHandler {
  readonly name = "TaskCompletionHandler"

  constructor(
    private readonly platform: ChatPlatform,
    private readonly observer: Observer,
    private readonly pinnedMessages: PinnedMessages,
    private readonly artifactCleaner: ArtifactCleaner,
    private readonly innerHandlers: CompletionHandler[],
  ) {}

  async handle(ctx: SessionCompletionContext): Promise<void> {
    if (ctx.state !== "completed") return

    const { topicSession, meta, state, durationMs, sessionId } = ctx

    topicSession.lastState = "completed"
    this.pinnedMessages.updateTopicTitle(topicSession, "✅").catch(() => {})

    try {
      await this.observer.flushAndComplete(meta, state, durationMs)

      await this.platform.chat.sendMessage(
        formatTaskComplete(topicSession.slug, durationMs, meta.totalTokens),
        String(topicSession.threadId),
      )

      // Run inner handlers (quality gates, digest, CI babysit) sequentially
      for (const handler of this.innerHandlers) {
        await handler.handle(ctx)
      }

      writeSessionLog(topicSession, meta, state, durationMs, ctx.qualityReport)
    } catch (err) {
      loggers.observer.error({ err, sessionId }, "flushAndComplete error")
    } finally {
      this.artifactCleaner.cleanBuildArtifacts(topicSession.cwd)
    }

    ctx.handled = true
  }
}
