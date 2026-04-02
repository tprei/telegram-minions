import type { SessionMeta, SessionDoneState, TopicSession } from "../types.js"
import type { QualityReport } from "../ci/quality-gates.js"

/**
 * Shared context passed through the session completion handler chain.
 *
 * Handlers run sequentially in registration order. Early-exit handlers
 * (QuotaHandler, ShipAdvanceHandler) set `handled = true` to skip the
 * remaining handlers in the chain.
 *
 * Mutable fields (`qualityReport`, `prUrl`, `handled`) allow upstream
 * handlers to communicate results to downstream handlers without coupling.
 */
export interface SessionCompletionContext {
  readonly topicSession: TopicSession
  readonly meta: SessionMeta
  readonly state: SessionDoneState
  readonly sessionId: string
  readonly durationMs: number
  /** Set by QualityGateHandler for downstream consumers (CIBabysitHandler). */
  qualityReport?: QualityReport
  /** Set by task completion flow — extracted PR URL from conversation. */
  prUrl?: string | null
  /** Set by early-exit handlers to skip remaining handlers. */
  handled: boolean
}

/**
 * A single-responsibility handler for one aspect of session completion.
 *
 * Each handler receives narrow dependencies at construction time
 * (not the full DispatcherContext) and implements this interface.
 */
export interface CompletionHandler {
  readonly name: string
  handle(ctx: SessionCompletionContext): Promise<void>
}
