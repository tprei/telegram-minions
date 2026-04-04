import type { TelegramClient } from "../telegram/telegram.js"
import type { Observer } from "../telegram/observer.js"
import type { TopicSession } from "../domain/session-types.js"
import type { CompletionHandler, SessionCompletionContext } from "./handler-types.js"
import { writeSessionLog } from "../session/session-log.js"
import { loggers } from "../logger.js"

export interface ShipPipeline {
  handleShipAdvance(topicSession: TopicSession): Promise<void>
}

export interface PinnedMessages {
  updateTopicTitle(topicSession: TopicSession, stateEmoji: string): Promise<void>
}

export interface ArtifactCleaner {
  cleanBuildArtifacts(cwd: string): void
}

export interface SessionPersister {
  persistTopicSessions(): Promise<void>
}

const SHIP_MODES = new Set(["ship-think", "ship-plan", "ship-verify"])

export class ShipAdvanceHandler implements CompletionHandler {
  readonly name = "ShipAdvanceHandler"

  constructor(
    private readonly telegram: TelegramClient,
    private readonly observer: Observer,
    private readonly shipPipeline: ShipPipeline,
    private readonly pinnedMessages: PinnedMessages,
    private readonly artifactCleaner: ArtifactCleaner,
    private readonly sessionPersister: SessionPersister,
  ) {}

  async handle(ctx: SessionCompletionContext): Promise<void> {
    const { topicSession, meta, state, durationMs } = ctx

    if (!topicSession.autoAdvance || !SHIP_MODES.has(topicSession.mode)) return

    ctx.handled = true

    if (state === "completed") {
      try {
        await this.observer.flushAndComplete(meta, state, durationMs)
      } catch (err) {
        loggers.ship.warn({ err, slug: topicSession.slug }, "flushAndComplete failed, continuing with ship advance")
      }
      writeSessionLog(topicSession, meta, state, durationMs)
      try {
        await this.shipPipeline.handleShipAdvance(topicSession)
      } catch (err) {
        loggers.ship.error({ err, slug: topicSession.slug }, "ship advance error")
        this.telegram.sendMessage(
          `❌ Ship pipeline error during ${topicSession.autoAdvance!.phase} phase: ${err instanceof Error ? err.message : String(err)}`,
          topicSession.threadId,
        ).catch(() => {})
      }
    } else {
      this.pinnedMessages.updateTopicTitle(topicSession, "⚠️").catch(() => {})
      this.observer.onSessionComplete(meta, state, durationMs).catch(() => {})
      const phase = topicSession.autoAdvance.phase
      this.telegram.sendMessage(
        `⚠️ Ship pipeline paused: ${topicSession.mode} phase errored during <b>${phase}</b>.\n\nRecovery options:\n• /retry — re-run the current phase\n• /dag — retry DAG extraction\n• /execute — run as a single task\n• /split — split into parallel sub-tasks\n• /close — abandon this ship`,
        topicSession.threadId,
      ).catch(() => {})
      writeSessionLog(topicSession, meta, state, durationMs)
    }

    this.sessionPersister.persistTopicSessions().catch(() => {})
    this.artifactCleaner.cleanBuildArtifacts(topicSession.cwd)
  }
}
