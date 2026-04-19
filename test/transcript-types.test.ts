import { describe, it, expect, expectTypeOf } from "vitest"
import {
  TRANSCRIPT_TRUNCATION_BUDGET,
  isTranscriptEventOfType,
  type AssistantTextEvent,
  type StatusEvent,
  type ThinkingEvent,
  type ToolCallEvent,
  type ToolCallSummary,
  type ToolResultEvent,
  type ToolResultPayload,
  type TranscriptEvent,
  type TranscriptEventType,
  type TranscriptSnapshot,
  type TurnCompletedEvent,
  type TurnStartedEvent,
  type UserMessageEvent,
} from "../src/transcript/types.js"

function baseFields(overrides: Partial<{ seq: number; id: string; sessionId: string; turn: number; timestamp: number }> = {}) {
  return {
    seq: 0,
    id: "evt_1",
    sessionId: "slow-knoll",
    turn: 0,
    timestamp: 1_700_000_000_000,
    ...overrides,
  }
}

describe("TranscriptEvent", () => {
  it("accepts a user_message event", () => {
    const evt: UserMessageEvent = {
      ...baseFields(),
      type: "user_message",
      text: "hello",
      images: ["data:image/png;base64,AAA"],
    }
    expect(evt.type).toBe("user_message")
    expect(evt.images).toHaveLength(1)
  })

  it("accepts a turn_started event with a trigger", () => {
    const evt: TurnStartedEvent = {
      ...baseFields({ seq: 1, id: "evt_2" }),
      type: "turn_started",
      trigger: "reply_injected",
    }
    expect(evt.trigger).toBe("reply_injected")
  })

  it("accepts a turn_completed event with totals", () => {
    const evt: TurnCompletedEvent = {
      ...baseFields({ seq: 2, id: "evt_3" }),
      type: "turn_completed",
      totalTokens: 1234,
      totalCostUsd: 0.01,
      durationMs: 5000,
      errored: false,
    }
    expect(evt.totalTokens).toBe(1234)
    expect(evt.errored).toBe(false)
  })

  it("accepts assistant_text deltas with final flag", () => {
    const delta: AssistantTextEvent = {
      ...baseFields({ seq: 3, id: "evt_4" }),
      type: "assistant_text",
      blockId: "block_a",
      text: "Hel",
      final: false,
    }
    const final: AssistantTextEvent = {
      ...baseFields({ seq: 4, id: "evt_5" }),
      type: "assistant_text",
      blockId: "block_a",
      text: "Hello world",
      final: true,
    }
    expect(delta.final).toBe(false)
    expect(final.final).toBe(true)
    expect(delta.blockId).toBe(final.blockId)
  })

  it("accepts thinking events with an optional signature", () => {
    const evt: ThinkingEvent = {
      ...baseFields({ seq: 5, id: "evt_6" }),
      type: "thinking",
      blockId: "think_a",
      text: "Reasoning…",
      final: true,
      signature: "sig_xyz",
    }
    expect(evt.signature).toBe("sig_xyz")
  })

  it("accepts a tool_call event with a classified ToolCallSummary", () => {
    const call: ToolCallSummary = {
      toolUseId: "tool_1",
      name: "Bash",
      kind: "bash",
      title: "Running command",
      subtitle: "npm test",
      input: { command: "npm test" },
    }
    const evt: ToolCallEvent = {
      ...baseFields({ seq: 6, id: "evt_7" }),
      type: "tool_call",
      call,
    }
    expect(evt.call.kind).toBe("bash")
    expect(evt.call.parentToolUseId).toBeUndefined()
  })

  it("carries parentToolUseId for nested Task/subagent calls", () => {
    const call: ToolCallSummary = {
      toolUseId: "tool_inner",
      parentToolUseId: "tool_outer",
      name: "Read",
      kind: "read",
      title: "Read file",
      input: { path: "README.md" },
    }
    expect(call.parentToolUseId).toBe("tool_outer")
  })

  it("accepts a tool_result event with truncation metadata", () => {
    const result: ToolResultPayload = {
      status: "ok",
      text: "first 1024 bytes…",
      truncated: true,
      originalBytes: 10 * 1024,
      format: "text",
      meta: { exitCode: 0 },
    }
    const evt: ToolResultEvent = {
      ...baseFields({ seq: 7, id: "evt_8" }),
      type: "tool_result",
      toolUseId: "tool_1",
      result,
    }
    expect(evt.result.truncated).toBe(true)
    expect(evt.result.originalBytes).toBe(10 * 1024)
  })

  it("accepts an error tool_result", () => {
    const evt: ToolResultEvent = {
      ...baseFields({ seq: 8, id: "evt_9" }),
      type: "tool_result",
      toolUseId: "tool_1",
      result: { status: "error", error: "ENOENT" },
    }
    expect(evt.result.status).toBe("error")
    expect(evt.result.error).toBe("ENOENT")
  })

  it("accepts a status event with severity and kind", () => {
    const evt: StatusEvent = {
      ...baseFields({ seq: 9, id: "evt_10" }),
      type: "status",
      severity: "warn",
      kind: "quota_sleep",
      message: "Sleeping until quota resets",
      data: { resumeAt: 1_700_000_060_000 },
    }
    expect(evt.severity).toBe("warn")
    expect(evt.kind).toBe("quota_sleep")
  })
})

describe("isTranscriptEventOfType", () => {
  const sample: TranscriptEvent = {
    ...baseFields(),
    type: "assistant_text",
    blockId: "b",
    text: "hi",
    final: true,
  }

  it("narrows the event when the type matches", () => {
    if (isTranscriptEventOfType(sample, "assistant_text")) {
      expectTypeOf(sample).toEqualTypeOf<AssistantTextEvent>()
      expect(sample.blockId).toBe("b")
    } else {
      throw new Error("expected narrowing to succeed")
    }
  })

  it("returns false for a non-matching type", () => {
    expect(isTranscriptEventOfType(sample, "tool_call")).toBe(false)
  })
})

describe("TranscriptEventType", () => {
  it("enumerates every variant in the union", () => {
    const types: TranscriptEventType[] = [
      "user_message",
      "turn_started",
      "turn_completed",
      "assistant_text",
      "thinking",
      "tool_call",
      "tool_result",
      "status",
    ]
    expect(new Set(types).size).toBe(types.length)
  })
})

describe("TRANSCRIPT_TRUNCATION_BUDGET", () => {
  it("exposes the planning-thread defaults", () => {
    expect(TRANSCRIPT_TRUNCATION_BUDGET.fileBytes).toBe(32 * 1024)
    expect(TRANSCRIPT_TRUNCATION_BUDGET.bashBytes).toBe(64 * 1024)
    expect(TRANSCRIPT_TRUNCATION_BUDGET.totalEventBytes).toBe(256 * 1024)
  })

  it("keeps per-tool budgets below the total event budget", () => {
    expect(TRANSCRIPT_TRUNCATION_BUDGET.fileBytes).toBeLessThan(
      TRANSCRIPT_TRUNCATION_BUDGET.totalEventBytes,
    )
    expect(TRANSCRIPT_TRUNCATION_BUDGET.bashBytes).toBeLessThan(
      TRANSCRIPT_TRUNCATION_BUDGET.totalEventBytes,
    )
  })
})

describe("TranscriptSnapshot", () => {
  it("models an empty replay envelope", () => {
    const snap: TranscriptSnapshot = {
      session: { sessionId: "slow-knoll", startedAt: 1_700_000_000_000 },
      events: [],
      highWaterMark: -1,
    }
    expect(snap.events).toHaveLength(0)
    expect(snap.highWaterMark).toBe(-1)
  })

  it("tracks the highest seq in the envelope", () => {
    const events: TranscriptEvent[] = [
      { ...baseFields({ seq: 0, id: "e0" }), type: "turn_started", trigger: "user_message" },
      { ...baseFields({ seq: 1, id: "e1" }), type: "assistant_text", blockId: "b", text: "hi", final: true },
    ]
    const snap: TranscriptSnapshot = {
      session: { sessionId: "slow-knoll", startedAt: 1_700_000_000_000, active: true },
      events,
      highWaterMark: 1,
    }
    expect(snap.highWaterMark).toBe(events[events.length - 1].seq)
  })
})
