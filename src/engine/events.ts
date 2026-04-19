import type { TopicSession, SessionDoneState } from "../domain/session-types.js"
import type { DagGraph } from "../dag/dag.js"
import type { TranscriptEvent } from "../transcript/types.js"
import { createLogger } from "../logger.js"

const log = createLogger({ component: "engine-events" })

/**
 * EngineEvent — the channel-agnostic event stream emitted by MinionEngine.
 *
 * Each connector (TelegramConnector, HttpConnector, future Slack/CLI) subscribes
 * to these events and translates them into its own channel's semantics.
 *
 * Payload shape: domain objects (TopicSession, DagGraph) rather than API DTOs.
 * Connectors are responsible for serialization.
 *
 * Identity: sessionId is the session slug (TopicSession.slug), which is the
 * canonical cross-connector identifier post-Phase-3. The numeric threadId
 * remains on TopicSession for Telegram compatibility during the transition.
 */
export type EngineEvent =
  | { type: "session_created"; session: TopicSession }
  | { type: "session_updated"; session: TopicSession; sessionState?: SessionDoneState }
  | { type: "session_deleted"; sessionId: string }
  | { type: "dag_created"; dag: DagGraph }
  | { type: "dag_updated"; dag: DagGraph }
  | { type: "dag_deleted"; dagId: string }
  | { type: "assistant_text"; sessionId: string; text: string; timestamp: number }
  | { type: "assistant_activity"; sessionId: string; activity: string; timestamp: number }
  | { type: "screenshot_captured"; sessionId: string; path: string; timestamp: number }
  | { type: "session_needs_attention"; sessionId: string; reason: string }
  | { type: "transcript_event"; sessionId: string; event: TranscriptEvent }

export type EngineEventType = EngineEvent["type"]

export type EngineEventHandler<T extends EngineEventType = EngineEventType> = (
  event: Extract<EngineEvent, { type: T }>,
) => void | Promise<void>

type WildcardHandler = (event: EngineEvent) => void | Promise<void>

type HandlerEntry = {
  type: EngineEventType | "*"
  handler: WildcardHandler
}

/**
 * EngineEventBus — channel-agnostic typed event bus for the engine.
 *
 * Handlers are dispatched sequentially in registration order. Async handlers
 * are awaited before the next handler runs. A thrown handler logs and
 * continues (fail-open), matching the existing domain EventBus contract.
 */
export class EngineEventBus {
  private handlers: HandlerEntry[] = []

  on<T extends EngineEventType>(type: T, handler: EngineEventHandler<T>): () => void {
    const entry: HandlerEntry = { type, handler: handler as WildcardHandler }
    this.handlers.push(entry)
    return () => this.off(entry)
  }

  onAny(handler: WildcardHandler): () => void {
    const entry: HandlerEntry = { type: "*", handler }
    this.handlers.push(entry)
    return () => this.off(entry)
  }

  async emit(event: EngineEvent): Promise<void> {
    for (const entry of [...this.handlers]) {
      if (entry.type !== event.type && entry.type !== "*") continue
      try {
        await entry.handler(event)
      } catch (err) {
        log.error({ err, eventType: event.type }, "engine event handler threw")
      }
    }
  }

  get listenerCount(): number {
    return this.handlers.length
  }

  listenerCountFor(type: EngineEventType | "*"): number {
    return this.handlers.filter((h) => h.type === type).length
  }

  clear(): void {
    this.handlers = []
  }

  private off(entry: HandlerEntry): void {
    const idx = this.handlers.indexOf(entry)
    if (idx !== -1) this.handlers.splice(idx, 1)
  }
}
