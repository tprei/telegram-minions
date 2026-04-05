import type { EventBus } from "../events/event-bus.js"
import type { SessionCompletedEvent } from "../events/domain-events.js"
import type { TopicSession } from "../domain/session-types.js"
import type { CompletionHandler, SessionCompletionContext } from "./handler-types.js"
import { createLogger } from "../logger.js"

const log = createLogger({ component: "completion-handler-chain" })

export interface TopicSessionProvider {
  get(threadId: number): TopicSession | undefined
}

export interface SessionRemover {
  delete(threadId: number): boolean
}

export interface SessionBroadcaster {
  broadcastSession(session: TopicSession, eventType: "session_created" | "session_updated", sessionState?: import("../domain/session-types.js").SessionDoneState): void
}

export interface PinnedSummaryUpdater {
  updatePinnedSummary(): void
}

export interface SessionPersister {
  persistTopicSessions(): Promise<void>
}

export interface ReplyQueueManager {
  getQueue(threadId: number): { clearDelivered(): Promise<void> } | undefined
}

/**
 * Orchestrates session completion by running registered handlers
 * sequentially in registration order.
 *
 * Subscribes to `session.completed` on the EventBus, enriches the event
 * into a `SessionCompletionContext`, and dispatches through the chain.
 *
 * Handlers that set `ctx.handled = true` cause the chain to stop early
 * (used by QuotaHandler and ShipAdvanceHandler for their dedicated flows).
 */
export class CompletionHandlerChain {
  private handlers: CompletionHandler[] = []
  private postChainHandlers: CompletionHandler[] = []

  constructor(
    private readonly topicSessions: TopicSessionProvider,
    private readonly sessions: SessionRemover,
    private readonly broadcaster: SessionBroadcaster,
    private readonly pinnedSummary: PinnedSummaryUpdater,
    private readonly sessionPersister: SessionPersister,
    private readonly replyQueues: ReplyQueueManager,
  ) {}

  register(handler: CompletionHandler): this {
    this.handlers.push(handler)
    return this
  }

  /** Register a handler that always runs after the chain, regardless of ctx.handled. */
  registerPostChain(handler: CompletionHandler): this {
    this.postChainHandlers.push(handler)
    return this
  }

  subscribe(bus: EventBus): () => void {
    return bus.on("session.completed", (event) => this.onSessionCompleted(event))
  }

  async run(ctx: SessionCompletionContext): Promise<void> {
    for (const handler of this.handlers) {
      if (ctx.handled) break
      try {
        await handler.handle(ctx)
      } catch (err) {
        log.error({ err, handler: handler.name, slug: ctx.topicSession.slug }, "completion handler threw")
      }
    }
  }

  private async onSessionCompleted(event: SessionCompletedEvent): Promise<void> {
    const topicSession = this.topicSessions.get(event.meta.threadId)
    if (!topicSession) {
      log.warn({ threadId: event.meta.threadId }, "session.completed for unknown topic")
      return
    }

    if (topicSession.activeSessionId !== event.meta.sessionId) return

    const durationMs = Date.now() - event.meta.startedAt

    // Core bookkeeping (always runs before handlers)
    this.sessions.delete(topicSession.threadId)
    topicSession.activeSessionId = undefined
    topicSession.lastActivityAt = Date.now()
    this.broadcaster.broadcastSession(topicSession, "session_updated", event.state)
    this.pinnedSummary.updatePinnedSummary()

    const ctx: SessionCompletionContext = {
      topicSession,
      meta: event.meta,
      state: event.state,
      sessionId: event.meta.sessionId,
      durationMs,
      handled: false,
    }

    await this.run(ctx)

    // Post-chain handlers (always run regardless of ctx.handled)
    for (const handler of this.postChainHandlers) {
      try {
        await handler.handle(ctx)
      } catch (err) {
        log.error({ err, handler: handler.name, slug: ctx.topicSession.slug }, "post-chain handler threw")
      }
    }

    // Post-chain bookkeeping (always runs after handlers)
    this.sessionPersister.persistTopicSessions().catch(() => {})

    const queue = this.replyQueues.getQueue(topicSession.threadId)
    if (queue) {
      queue.clearDelivered().catch((err) => {
        log.warn({ err, slug: topicSession.slug }, "failed to clear delivered replies")
      })
    }
  }
}
