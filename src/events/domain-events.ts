import type { SessionDoneState, SessionMeta, SessionMode } from "../domain/session-types.js"
/** Base shape shared by every domain event. */
export interface DomainEvent<T extends string = string> {
  readonly type: T
  readonly timestamp: number
}

// ---------------------------------------------------------------------------
// Session lifecycle events
// ---------------------------------------------------------------------------

export interface SessionSpawnedEvent extends DomainEvent<"session.spawned"> {
  readonly sessionId: string
  readonly threadId: string
  readonly slug: string
  readonly repo: string
  readonly mode: SessionMode
}

export interface SessionCompletedEvent extends DomainEvent<"session.completed"> {
  readonly meta: SessionMeta
  readonly state: SessionDoneState
  readonly prUrl?: string
  readonly branch?: string
}

export interface SessionErroredEvent extends DomainEvent<"session.errored"> {
  readonly meta: SessionMeta
  readonly error?: string
}

export interface SessionInterruptedEvent extends DomainEvent<"session.interrupted"> {
  readonly sessionId: string
  readonly threadId: string
}

export interface SessionTimeoutEvent extends DomainEvent<"session.timeout"> {
  readonly sessionId: string
  readonly threadId: string
  readonly kind: "duration" | "inactivity"
}

// ---------------------------------------------------------------------------
// DAG events
// ---------------------------------------------------------------------------

export interface DagCreatedEvent extends DomainEvent<"dag.created"> {
  readonly dagId: string
  readonly parentThreadId: string
  readonly nodeCount: number
}

export interface DagNodeReadyEvent extends DomainEvent<"dag.node_ready"> {
  readonly dagId: string
  readonly nodeId: string
  readonly title: string
}

export interface DagNodeStartedEvent extends DomainEvent<"dag.node_started"> {
  readonly dagId: string
  readonly nodeId: string
  readonly threadId: string
  readonly sessionId: string
}

export interface DagNodeCompletedEvent extends DomainEvent<"dag.node_completed"> {
  readonly dagId: string
  readonly nodeId: string
  readonly prUrl?: string
  readonly branch?: string
}

export interface DagNodeFailedEvent extends DomainEvent<"dag.node_failed"> {
  readonly dagId: string
  readonly nodeId: string
  readonly error?: string
  readonly skippedDependents: string[]
}

export interface DagCompletedEvent extends DomainEvent<"dag.completed"> {
  readonly dagId: string
  readonly parentThreadId: string
}

// ---------------------------------------------------------------------------
// CI events
// ---------------------------------------------------------------------------

export interface CiWatchingEvent extends DomainEvent<"ci.watching"> {
  readonly prUrl: string
  readonly threadId: string
}

export interface CiPassedEvent extends DomainEvent<"ci.passed"> {
  readonly prUrl: string
  readonly threadId: string
}

export interface CiFailedEvent extends DomainEvent<"ci.failed"> {
  readonly prUrl: string
  readonly threadId: string
  readonly attempt: number
  readonly maxAttempts: number
}

export interface CiFixStartedEvent extends DomainEvent<"ci.fix_started"> {
  readonly prUrl: string
  readonly threadId: string
  readonly attempt: number
}

export interface CiGaveUpEvent extends DomainEvent<"ci.gave_up"> {
  readonly prUrl: string
  readonly threadId: string
  readonly reason: string
}

// ---------------------------------------------------------------------------
// Split events
// ---------------------------------------------------------------------------

export interface SplitStartedEvent extends DomainEvent<"split.started"> {
  readonly parentThreadId: string
  readonly itemCount: number
}

export interface SplitChildSpawnedEvent extends DomainEvent<"split.child_spawned"> {
  readonly parentThreadId: string
  readonly childThreadId: string
  readonly label: string
}

export interface SplitAllDoneEvent extends DomainEvent<"split.all_done"> {
  readonly parentThreadId: string
  readonly childCount: number
}

// ---------------------------------------------------------------------------
// Quota events
// ---------------------------------------------------------------------------

export interface QuotaExhaustedEvent extends DomainEvent<"quota.exhausted"> {
  readonly sessionId: string
  readonly threadId: string
}

export interface QuotaSleepStartedEvent extends DomainEvent<"quota.sleep_started"> {
  readonly sessionId: string
  readonly threadId: string
  readonly resumeAt: number
}

// ---------------------------------------------------------------------------
// Ship pipeline events
// ---------------------------------------------------------------------------

export interface ShipPhaseStartedEvent extends DomainEvent<"ship.phase_started"> {
  readonly threadId: string
  readonly phase: string
}

export interface ShipPhaseCompletedEvent extends DomainEvent<"ship.phase_completed"> {
  readonly threadId: string
  readonly phase: string
}

export interface ShipPipelineCompletedEvent extends DomainEvent<"ship.pipeline_completed"> {
  readonly threadId: string
}

// ---------------------------------------------------------------------------
// Union of all domain events
// ---------------------------------------------------------------------------

export type DomainEventMap = {
  "session.spawned": SessionSpawnedEvent
  "session.completed": SessionCompletedEvent
  "session.errored": SessionErroredEvent
  "session.interrupted": SessionInterruptedEvent
  "session.timeout": SessionTimeoutEvent
  "dag.created": DagCreatedEvent
  "dag.node_ready": DagNodeReadyEvent
  "dag.node_started": DagNodeStartedEvent
  "dag.node_completed": DagNodeCompletedEvent
  "dag.node_failed": DagNodeFailedEvent
  "dag.completed": DagCompletedEvent
  "ci.watching": CiWatchingEvent
  "ci.passed": CiPassedEvent
  "ci.failed": CiFailedEvent
  "ci.fix_started": CiFixStartedEvent
  "ci.gave_up": CiGaveUpEvent
  "split.started": SplitStartedEvent
  "split.child_spawned": SplitChildSpawnedEvent
  "split.all_done": SplitAllDoneEvent
  "quota.exhausted": QuotaExhaustedEvent
  "quota.sleep_started": QuotaSleepStartedEvent
  "ship.phase_started": ShipPhaseStartedEvent
  "ship.phase_completed": ShipPhaseCompletedEvent
  "ship.pipeline_completed": ShipPipelineCompletedEvent
}

export type DomainEventType = keyof DomainEventMap
export type AnyDomainEvent = DomainEventMap[DomainEventType]
