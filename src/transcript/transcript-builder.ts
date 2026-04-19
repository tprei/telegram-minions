import type {
  GooseMessage,
  GooseStreamEvent,
  GooseToolRequestContent,
  GooseToolResponseContent,
} from "../domain/goose-types.js"
import {
  isTextContent,
  isToolRequestContent,
  isToolResponseContent,
} from "../domain/goose-types.js"
import { buildToolCallSummary, buildToolResultPayload } from "./tool-classifier.js"
import type {
  AssistantTextEvent,
  StatusEvent,
  StatusSeverity,
  ThinkingEvent,
  ToolCallEvent,
  ToolKind,
  ToolResultEvent,
  TranscriptEvent,
  TranscriptEventBase,
  TurnCompletedEvent,
  TurnStartedEvent,
  TurnTrigger,
  UserMessageEvent,
} from "./types.js"

/**
 * Translates a GooseStreamEvent stream into structured TranscriptEvents.
 *
 * The builder is deliberately stateful — it tracks turn boundaries, pairs
 * tool calls with their responses, and buffers streaming text/thinking into
 * block-identified deltas. Callers typically:
 *
 *   1. `userMessage(text)` when the user sends input
 *   2. `handleEvent(goose)` for each upstream stream event
 *   3. `status(...)` for engine-level banners (quota waits, CI retries, …)
 *   4. `completeTurn(...)` / let `handleEvent({type:"complete", …})` close the turn
 *
 * All emit methods return the list of transcript events produced, so the
 * caller can immediately fan them out to subscribers. The builder never
 * throws on malformed input — unknown content block types are skipped.
 */

export interface TranscriptBuilderOptions {
  sessionId: string
  /** Override the wall-clock source (tests). */
  now?: () => number
  /** Override the event/block id generator (tests). */
  idGen?: () => string
}

export interface CompleteTurnOptions {
  totalTokens?: number
  totalCostUsd?: number
  errored?: boolean
}

export interface StatusOptions {
  severity?: StatusSeverity
  data?: Record<string, unknown>
}

interface ActiveBlock {
  blockId: string
  text: string
}

interface PendingToolCall {
  name: string
  kind: ToolKind
}

interface GooseThinkingBlock {
  type: "thinking"
  thinking: string
  signature?: string
}

function isThinkingContent(block: { type: string }): block is GooseThinkingBlock {
  return block.type === "thinking"
}

export class TranscriptBuilder {
  private readonly sessionId: string
  private readonly now: () => number
  private readonly idGen: () => string
  private seq = 0
  private turn = -1
  private turnActive = false
  private turnStartedAt: number | null = null
  private activeText: ActiveBlock | null = null
  private activeThinking: ActiveBlock | null = null
  private readonly pending = new Map<string, PendingToolCall>()

  constructor(opts: TranscriptBuilderOptions) {
    this.sessionId = opts.sessionId
    this.now = opts.now ?? (() => Date.now())
    this.idGen = opts.idGen ?? (() => crypto.randomUUID())
  }

  /** Current monotonic sequence counter (the seq of the *next* emitted event). */
  get nextSeq(): number {
    return this.seq
  }

  /** Zero-based index of the current (or most recent) turn. 0 until the first turn starts. */
  get currentTurn(): number {
    return Math.max(this.turn, 0)
  }

  /** True while a turn is open (between `turn_started` and `turn_completed`). */
  get isTurnActive(): boolean {
    return this.turnActive
  }

  /** Start a new turn. Completes the current turn first if one is active. */
  startTurn(trigger: TurnTrigger): TranscriptEvent[] {
    const out: TranscriptEvent[] = []
    if (this.turnActive) out.push(...this.completeTurn())
    this.turn += 1
    this.turnActive = true
    this.turnStartedAt = this.now()
    const evt: TurnStartedEvent = {
      ...this.baseFields(),
      type: "turn_started",
      trigger,
    }
    out.push(evt)
    return out
  }

  /**
   * Mirror a user-side message into the transcript. Auto-starts a turn with
   * the `user_message` trigger when none is active.
   */
  userMessage(text: string, images?: string[]): TranscriptEvent[] {
    const out: TranscriptEvent[] = []
    if (!this.turnActive) out.push(...this.startTurn("user_message"))
    const evt: UserMessageEvent = {
      ...this.baseFields(),
      type: "user_message",
      text,
    }
    if (images && images.length > 0) evt.images = [...images]
    out.push(evt)
    return out
  }

  /** Emit a standalone status banner event. Does not affect turn state. */
  status(kind: string, message: string, opts: StatusOptions = {}): StatusEvent {
    const evt: StatusEvent = {
      ...this.baseFields(),
      type: "status",
      severity: opts.severity ?? "info",
      kind,
      message,
    }
    if (opts.data) evt.data = { ...opts.data }
    return evt
  }

  /** Close the current turn, flushing any buffered text/thinking first. */
  completeTurn(opts: CompleteTurnOptions = {}): TranscriptEvent[] {
    if (!this.turnActive) return []
    const out: TranscriptEvent[] = []
    out.push(...this.flushActiveBlocks())
    const evt: TurnCompletedEvent = {
      ...this.baseFields(),
      type: "turn_completed",
    }
    if (opts.totalTokens !== undefined) evt.totalTokens = opts.totalTokens
    if (opts.totalCostUsd !== undefined) evt.totalCostUsd = opts.totalCostUsd
    if (opts.errored !== undefined) evt.errored = opts.errored
    if (this.turnStartedAt != null) {
      evt.durationMs = Math.max(0, this.now() - this.turnStartedAt)
    }
    out.push(evt)
    this.turnActive = false
    this.turnStartedAt = null
    return out
  }

  /** Process a single GooseStreamEvent and emit the resulting transcript events. */
  handleEvent(event: GooseStreamEvent): TranscriptEvent[] {
    switch (event.type) {
      case "message":
        return this.handleMessage(event.message)
      case "complete":
        return this.completeTurn({
          totalTokens: event.total_tokens ?? undefined,
          totalCostUsd: event.total_cost_usd ?? undefined,
        })
      case "error":
        return this.handleError(event.error)
      case "quota_exhausted": {
        const data: Record<string, unknown> = {}
        if (event.resetAt !== undefined) data.resetAt = event.resetAt
        return [
          this.status("quota_exhausted", event.rawMessage, {
            severity: "warn",
            data: Object.keys(data).length > 0 ? data : undefined,
          }),
        ]
      }
      case "idle":
      case "notification":
        return []
    }
  }

  private handleError(error: string): TranscriptEvent[] {
    if (this.turnActive) return this.completeTurn({ errored: true })
    return [this.status("session_error", error, { severity: "error" })]
  }

  private handleMessage(message: GooseMessage): TranscriptEvent[] {
    const out: TranscriptEvent[] = []
    for (const block of message.content) {
      if (isToolResponseContent(block)) {
        out.push(...this.handleToolResponse(block))
        continue
      }
      if (message.role !== "assistant") continue
      if (!this.turnActive) out.push(...this.startTurn("agent_continuation"))

      if (isTextContent(block)) {
        out.push(...this.appendText(block.text))
        continue
      }
      if (isThinkingContent(block)) {
        out.push(...this.appendThinking(block.thinking, block.signature))
        continue
      }
      if (isToolRequestContent(block)) {
        out.push(...this.handleToolRequest(block))
        continue
      }
      // Other content types (systemNotification, notification, …) — ignored.
    }
    return out
  }

  private appendText(chunk: string): TranscriptEvent[] {
    const out: TranscriptEvent[] = []
    if (this.activeThinking) {
      const flushed = this.flushActiveThinking()
      if (flushed) out.push(flushed)
    }
    if (!this.activeText) this.activeText = { blockId: this.idGen(), text: "" }
    if (chunk.length === 0) return out
    this.activeText.text += chunk
    const evt: AssistantTextEvent = {
      ...this.baseFields(),
      type: "assistant_text",
      blockId: this.activeText.blockId,
      text: chunk,
      final: false,
    }
    out.push(evt)
    return out
  }

  private appendThinking(chunk: string, signature: string | undefined): TranscriptEvent[] {
    const out: TranscriptEvent[] = []
    if (this.activeText) {
      const flushed = this.flushActiveText()
      if (flushed) out.push(flushed)
    }
    if (!this.activeThinking) this.activeThinking = { blockId: this.idGen(), text: "" }
    if (chunk.length === 0) return out
    this.activeThinking.text += chunk
    const evt: ThinkingEvent = {
      ...this.baseFields(),
      type: "thinking",
      blockId: this.activeThinking.blockId,
      text: chunk,
      final: false,
    }
    if (signature) evt.signature = signature
    out.push(evt)
    return out
  }

  private handleToolRequest(block: GooseToolRequestContent): TranscriptEvent[] {
    const out: TranscriptEvent[] = []
    out.push(...this.flushActiveBlocks())

    if ("error" in block.toolCall) {
      const evt: StatusEvent = {
        ...this.baseFields(),
        type: "status",
        severity: "error",
        kind: "tool_call_error",
        message: block.toolCall.error,
        data: { toolUseId: block.id },
      }
      out.push(evt)
      return out
    }

    const summary = buildToolCallSummary(
      block.id,
      block.toolCall.name,
      block.toolCall.arguments,
    )
    this.pending.set(block.id, { name: summary.name, kind: summary.kind })
    const evt: ToolCallEvent = {
      ...this.baseFields(),
      type: "tool_call",
      call: summary,
    }
    out.push(evt)
    return out
  }

  private handleToolResponse(block: GooseToolResponseContent): TranscriptEvent[] {
    const out: TranscriptEvent[] = []
    if (!this.turnActive) out.push(...this.startTurn("agent_continuation"))
    out.push(...this.flushActiveBlocks())
    const pending = this.pending.get(block.id)
    const result = buildToolResultPayload(block.toolResult, {
      toolName: pending?.name,
    })
    this.pending.delete(block.id)
    const evt: ToolResultEvent = {
      ...this.baseFields(),
      type: "tool_result",
      toolUseId: block.id,
      result,
    }
    out.push(evt)
    return out
  }

  private flushActiveText(): AssistantTextEvent | null {
    if (!this.activeText) return null
    const block = this.activeText
    this.activeText = null
    return {
      ...this.baseFields(),
      type: "assistant_text",
      blockId: block.blockId,
      text: block.text,
      final: true,
    }
  }

  private flushActiveThinking(): ThinkingEvent | null {
    if (!this.activeThinking) return null
    const block = this.activeThinking
    this.activeThinking = null
    return {
      ...this.baseFields(),
      type: "thinking",
      blockId: block.blockId,
      text: block.text,
      final: true,
    }
  }

  private flushActiveBlocks(): TranscriptEvent[] {
    const out: TranscriptEvent[] = []
    const th = this.flushActiveThinking()
    if (th) out.push(th)
    const tx = this.flushActiveText()
    if (tx) out.push(tx)
    return out
  }

  private baseFields(): TranscriptEventBase {
    return {
      seq: this.seq++,
      id: this.idGen(),
      sessionId: this.sessionId,
      turn: this.turn < 0 ? 0 : this.turn,
      timestamp: this.now(),
    }
  }
}
