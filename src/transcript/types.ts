/**
 * Transcript event types — the channel-agnostic shape of an agent session
 * as a structured stream that frontends (PWA, future clients) can render
 * with clean formatting, similar to conductor.build.
 *
 * These are richer than the raw Goose/Claude stream events:
 * - Tool calls are classified (kind) and summarised (title/subtitle) so the
 *   UI can pick the right renderer without reimplementing provider quirks.
 * - Tool results carry truncation metadata and a format hint.
 * - Assistant text and thinking are emitted as deltas with a `final` flag
 *   so clients may stream incrementally or wait for the whole block.
 * - Every event has a monotonic `seq` per session and a stable `id` so
 *   reconnecting clients can catch up via `?after=<seq>` without dedup
 *   logic on the server.
 */

/** Classification of a tool call for UI rendering. */
export type ToolKind =
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "search"
  | "glob"
  | "web_fetch"
  | "web_search"
  | "browser"
  | "task"
  | "todo"
  | "notebook"
  | "mcp"
  | "other"

export type ToolResultStatus = "ok" | "error" | "pending"

/** Preferred renderer hint for a tool result's textual payload. */
export type ToolResultFormat = "text" | "markdown" | "diff" | "json" | "image"

/** Severity of an inline status banner. */
export type StatusSeverity = "info" | "warn" | "error"

/** Reason the current turn started. */
export type TurnTrigger =
  | "user_message"
  | "agent_continuation"
  | "command"
  | "reply_injected"
  | "resume"

/**
 * Structured representation of a tool call. The `input` is the raw argument
 * object as passed to the tool; `title`/`subtitle` are classifier-produced
 * labels (e.g. "Running npm test" / "in /workspace/app").
 */
export interface ToolCallSummary {
  /** Stable identifier for this tool invocation (e.g. Anthropic tool_use id). */
  toolUseId: string
  /** Raw tool name as provided by the agent. */
  name: string
  /** Normalised classification for UI rendering. */
  kind: ToolKind
  /** Short headline label for the call (e.g. "Edit file"). */
  title: string
  /** Optional one-line subtitle (e.g. the target path). */
  subtitle?: string
  /** Raw input arguments. */
  input: Record<string, unknown>
  /** Parent tool-use id for nested calls (Task/subagent). */
  parentToolUseId?: string
}

/**
 * Structured representation of a tool result. Large payloads are truncated
 * upstream — `truncated` and `originalBytes` let the UI show a "view full"
 * affordance while keeping event size bounded.
 */
export interface ToolResultPayload {
  status: ToolResultStatus
  /** Textual payload for display. */
  text?: string
  /** True when `text` was truncated to fit the event budget. */
  truncated?: boolean
  /** Original size in bytes before any truncation. */
  originalBytes?: number
  /** Renderer hint. Defaults to "text" when omitted. */
  format?: ToolResultFormat
  /** Structured extras (exit code, cwd, file mode, …). */
  meta?: Record<string, unknown>
  /** Error message when `status === "error"`. */
  error?: string
  /** Optional image attachments (paths or data URIs). */
  images?: string[]
}

/** Fields shared by every transcript event. */
export interface TranscriptEventBase {
  /** Monotonic sequence number within the session. */
  seq: number
  /** Stable event identifier (UUID or deterministic hash). */
  id: string
  /** Session slug — cross-connector canonical id. */
  sessionId: string
  /** Zero-based turn index. A turn spans one trigger → final response. */
  turn: number
  /** Wall-clock timestamp in milliseconds. */
  timestamp: number
}

/** A user message at the start of (or injected into) a turn. */
export interface UserMessageEvent extends TranscriptEventBase {
  type: "user_message"
  text: string
  images?: string[]
}

/** Marks the beginning of a turn. Useful for splitting the UI into bubbles. */
export interface TurnStartedEvent extends TranscriptEventBase {
  type: "turn_started"
  trigger: TurnTrigger
}

/**
 * Marks the end of a turn (agent idle / complete). `totalTokens`/`costUsd`
 * are cumulative session totals, not per-turn, matching the provider's
 * report. `durationMs` is per-turn.
 */
export interface TurnCompletedEvent extends TranscriptEventBase {
  type: "turn_completed"
  totalTokens?: number
  totalCostUsd?: number
  durationMs?: number
  /** True when the turn ended because the agent errored. */
  errored?: boolean
}

/**
 * Assistant text output. Emitted either once per block (`final: true` with
 * full text) or as a series of deltas followed by a terminal `final: true`.
 * `blockId` groups deltas belonging to the same text block.
 */
export interface AssistantTextEvent extends TranscriptEventBase {
  type: "assistant_text"
  blockId: string
  /** Text content — a delta when `final` is false, the full block when true. */
  text: string
  final: boolean
}

/**
 * Extended ("thinking") output from the model. Same delta semantics as
 * `assistant_text`. `signature` is the provider-supplied thinking signature
 * when available.
 */
export interface ThinkingEvent extends TranscriptEventBase {
  type: "thinking"
  blockId: string
  text: string
  final: boolean
  signature?: string
}

/** A tool invocation by the agent. */
export interface ToolCallEvent extends TranscriptEventBase {
  type: "tool_call"
  call: ToolCallSummary
}

/** The result of a previously-emitted tool call. Correlate via `toolUseId`. */
export interface ToolResultEvent extends TranscriptEventBase {
  type: "tool_result"
  toolUseId: string
  result: ToolResultPayload
}

/**
 * Inline status banner. Covers the kinds of messages that the Telegram
 * connector currently appends to the conversation via `postStatus`:
 * quota waits, concurrent-session caps, CI retries, etc.
 *
 * `kind` is a stable short code (e.g. "quota_sleep", "reply_injected")
 * that the UI can switch on for icons/colors without parsing `message`.
 */
export interface StatusEvent extends TranscriptEventBase {
  type: "status"
  severity: StatusSeverity
  kind: string
  message: string
  data?: Record<string, unknown>
}

/** The discriminated union of every event that may appear in a transcript. */
export type TranscriptEvent =
  | UserMessageEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | AssistantTextEvent
  | ThinkingEvent
  | ToolCallEvent
  | ToolResultEvent
  | StatusEvent

export type TranscriptEventType = TranscriptEvent["type"]

/** Lightweight session-level metadata carried alongside transcript streams. */
export interface TranscriptSessionInfo {
  sessionId: string
  /** Session slug / human-readable name, for display. */
  topicName?: string
  /** Repository identifier (e.g. "org/repo"). */
  repo?: string
  /** Session mode (task, plan, review, …). */
  mode?: string
  /** Wall-clock start time in ms. */
  startedAt: number
  /** Cumulative totals, updated as turns complete. */
  totalTokens?: number
  totalCostUsd?: number
  numTurns?: number
  /** True while the agent is mid-turn. */
  active?: boolean
  /** URL of the transcript SSE endpoint. */
  transcriptUrl?: string
}

/** Snapshot envelope returned by the transcript REST endpoint. */
export interface TranscriptSnapshot {
  session: TranscriptSessionInfo
  /** All events up to and including `highWaterMark`. */
  events: TranscriptEvent[]
  /** The highest `seq` represented in `events` (-1 if empty). */
  highWaterMark: number
}

/**
 * Budget used when truncating tool-result payloads. Exposed as a constant
 * so builders, the API server, and tests all agree on the contract.
 *
 * Defaults chosen from the planning thread: file reads up to 32 KB, bash
 * output up to 64 KB, total per event capped at 256 KB.
 */
export const TRANSCRIPT_TRUNCATION_BUDGET = {
  fileBytes: 32 * 1024,
  bashBytes: 64 * 1024,
  totalEventBytes: 256 * 1024,
} as const

export type TranscriptTruncationBudget = typeof TRANSCRIPT_TRUNCATION_BUDGET

/** Narrowing helper: true when `event` is of the given `type`. */
export function isTranscriptEventOfType<T extends TranscriptEventType>(
  event: TranscriptEvent,
  type: T,
): event is Extract<TranscriptEvent, { type: T }> {
  return event.type === type
}
