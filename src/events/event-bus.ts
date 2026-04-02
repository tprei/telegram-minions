import { createLogger } from "../logger.js"
import type { DomainEventMap, DomainEventType, AnyDomainEvent } from "./domain-events.js"

const log = createLogger({ component: "event-bus" })

export type EventHandler<E> = (event: E) => void | Promise<void>

type HandlerEntry = {
  type: DomainEventType | "*"
  handler: EventHandler<AnyDomainEvent>
  once: boolean
}

/**
 * Synchronous, in-process event bus for domain events.
 *
 * Handlers for a single event type are dispatched sequentially in
 * registration order. Async handlers are awaited before the next
 * handler runs, preserving ordering guarantees that session state
 * transitions depend on.
 *
 * Wildcard subscribers (`onAny(fn)`) receive every event and run
 * in registration order alongside type-specific handlers.
 */
export class EventBus {
  private handlers: HandlerEntry[] = []
  private emitting = false

  /**
   * Subscribe to a specific event type.
   * Returns an unsubscribe function.
   */
  on<T extends DomainEventType>(
    type: T,
    handler: EventHandler<DomainEventMap[T]>,
  ): () => void {
    const entry: HandlerEntry = {
      type,
      handler: handler as EventHandler<AnyDomainEvent>,
      once: false,
    }
    this.handlers.push(entry)
    return () => this.off(entry)
  }

  /**
   * Subscribe to a specific event type for a single emission.
   * The handler is automatically removed after it fires once.
   * Returns an unsubscribe function.
   */
  once<T extends DomainEventType>(
    type: T,
    handler: EventHandler<DomainEventMap[T]>,
  ): () => void {
    const entry: HandlerEntry = {
      type,
      handler: handler as EventHandler<AnyDomainEvent>,
      once: true,
    }
    this.handlers.push(entry)
    return () => this.off(entry)
  }

  /**
   * Subscribe to all event types via wildcard.
   * Wildcard handlers run after type-specific handlers.
   * Returns an unsubscribe function.
   */
  onAny(handler: EventHandler<AnyDomainEvent>): () => void {
    const entry: HandlerEntry = {
      type: "*",
      handler,
      once: false,
    }
    this.handlers.push(entry)
    return () => this.off(entry)
  }

  /**
   * Emit a domain event. Handlers are invoked sequentially.
   * Async handlers are awaited before the next handler runs.
   *
   * If a handler throws, the error is logged and remaining handlers
   * still execute (fail-open to avoid one broken subscriber blocking
   * the pipeline).
   */
  async emit<T extends DomainEventType>(event: DomainEventMap[T]): Promise<void> {
    this.emitting = true
    try {
      const toRemove: HandlerEntry[] = []

      for (const entry of [...this.handlers]) {
        if (entry.type !== event.type && entry.type !== "*") continue
        try {
          await entry.handler(event)
        } catch (err) {
          log.error({ err, eventType: event.type }, "event handler threw")
        }
        if (entry.once) {
          toRemove.push(entry)
        }
      }

      for (const entry of toRemove) {
        this.off(entry)
      }
    } finally {
      this.emitting = false
    }
  }

  /** Number of registered handlers (useful for testing). */
  get listenerCount(): number {
    return this.handlers.length
  }

  /** Number of handlers for a specific event type. */
  listenerCountFor(type: DomainEventType | "*"): number {
    return this.handlers.filter((h) => h.type === type).length
  }

  /** Remove all handlers. */
  clear(): void {
    this.handlers = []
  }

  private off(entry: HandlerEntry): void {
    const idx = this.handlers.indexOf(entry)
    if (idx !== -1) {
      this.handlers.splice(idx, 1)
    }
  }
}
