import { describe, it, expect, expectTypeOf } from "vitest"
import * as transcript from "../src/transcript/index.js"
import type {
  AssistantTextEvent,
  StatusEvent,
  ThinkingEvent,
  ToolCallEvent,
  ToolCallSummary,
  ToolResultEvent,
  ToolResultPayload,
  TranscriptEvent,
  TranscriptEventType,
  TranscriptSessionInfo,
  TranscriptSnapshot,
  TurnCompletedEvent,
  TurnStartedEvent,
  UserMessageEvent,
} from "../src/transcript/index.js"
import {
  TRANSCRIPT_TRUNCATION_BUDGET,
  TranscriptBuilder,
  TranscriptStore,
  buildToolCallSummary,
  buildToolResultPayload,
  classifyTool,
  isTranscriptEventOfType,
  parseMcpName,
} from "../src/transcript/index.js"

describe("transcript module index", () => {
  it("re-exports the runtime surface", () => {
    expect(TranscriptBuilder).toBeTypeOf("function")
    expect(TranscriptStore).toBeTypeOf("function")
    expect(classifyTool).toBeTypeOf("function")
    expect(buildToolCallSummary).toBeTypeOf("function")
    expect(buildToolResultPayload).toBeTypeOf("function")
    expect(parseMcpName).toBeTypeOf("function")
    expect(isTranscriptEventOfType).toBeTypeOf("function")
    expect(TRANSCRIPT_TRUNCATION_BUDGET).toMatchObject({
      fileBytes: expect.any(Number),
      bashBytes: expect.any(Number),
      totalEventBytes: expect.any(Number),
    })
  })

  it("surfaces the same bindings via the namespace import", () => {
    expect(transcript.TranscriptBuilder).toBe(TranscriptBuilder)
    expect(transcript.TranscriptStore).toBe(TranscriptStore)
    expect(transcript.classifyTool).toBe(classifyTool)
    expect(transcript.buildToolCallSummary).toBe(buildToolCallSummary)
    expect(transcript.buildToolResultPayload).toBe(buildToolResultPayload)
    expect(transcript.parseMcpName).toBe(parseMcpName)
    expect(transcript.isTranscriptEventOfType).toBe(isTranscriptEventOfType)
    expect(transcript.TRANSCRIPT_TRUNCATION_BUDGET).toBe(TRANSCRIPT_TRUNCATION_BUDGET)
  })

  it("re-exports the event type union and discriminants", () => {
    const builder = new TranscriptBuilder({
      sessionId: "slow-knoll",
      now: () => 1,
      idGen: () => "id",
    })
    const events = builder.userMessage("hello")
    const first = events[0]
    expectTypeOf(first).toEqualTypeOf<TranscriptEvent>()
    if (isTranscriptEventOfType(first, "turn_started")) {
      expectTypeOf(first).toEqualTypeOf<TurnStartedEvent>()
    }
    const eventTypes: TranscriptEventType[] = [
      "user_message",
      "turn_started",
      "turn_completed",
      "assistant_text",
      "thinking",
      "tool_call",
      "tool_result",
      "status",
    ]
    expect(eventTypes).toHaveLength(8)
  })

  it("re-exports event payload types with structural equivalence", () => {
    const user: UserMessageEvent = {
      seq: 0,
      id: "e0",
      sessionId: "s",
      turn: 0,
      timestamp: 1,
      type: "user_message",
      text: "hi",
    }
    const started: TurnStartedEvent = { ...user, seq: 1, type: "turn_started", trigger: "user_message" }
    const completed: TurnCompletedEvent = { ...user, seq: 2, type: "turn_completed" }
    const text: AssistantTextEvent = { ...user, seq: 3, type: "assistant_text", blockId: "b", text: "x", final: true }
    const thinking: ThinkingEvent = { ...user, seq: 4, type: "thinking", blockId: "t", text: "t", final: true }
    const callSummary: ToolCallSummary = {
      toolUseId: "tu",
      name: "Bash",
      kind: "bash",
      title: "Run command",
      input: {},
    }
    const call: ToolCallEvent = { ...user, seq: 5, type: "tool_call", call: callSummary }
    const resultPayload: ToolResultPayload = { status: "ok" }
    const result: ToolResultEvent = { ...user, seq: 6, type: "tool_result", toolUseId: "tu", result: resultPayload }
    const status: StatusEvent = {
      ...user,
      seq: 7,
      type: "status",
      severity: "info",
      kind: "quota_sleep",
      message: "sleeping",
    }
    const all: TranscriptEvent[] = [user, started, completed, text, thinking, call, result, status]
    expect(all.map((e) => e.type)).toEqual([
      "user_message",
      "turn_started",
      "turn_completed",
      "assistant_text",
      "thinking",
      "tool_call",
      "tool_result",
      "status",
    ])
  })

  it("re-exports session metadata and snapshot envelopes", () => {
    const session: TranscriptSessionInfo = { sessionId: "s", startedAt: 1 }
    const snapshot: TranscriptSnapshot = { session, events: [], highWaterMark: -1 }
    expect(snapshot.session.sessionId).toBe("s")
    expect(snapshot.highWaterMark).toBe(-1)
  })

  it("wires the classifier, builder, and store together end-to-end", async () => {
    const tmpRoot = await import("node:os").then((os) => os.tmpdir())
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const dir = await fs.mkdtemp(path.join(tmpRoot, "transcript-index-"))

    try {
      const store = new TranscriptStore(dir)
      const builder = new TranscriptBuilder({
        sessionId: "slow-knoll",
        now: () => 1_700_000_000_000,
        idGen: (() => {
          let n = 0
          return () => `id-${++n}`
        })(),
      })

      for (const e of builder.userMessage("hi there")) await store.append("slow-knoll", e)
      for (const e of builder.handleEvent({ type: "complete", total_tokens: 42 })) {
        await store.append("slow-knoll", e)
      }
      await store.flush()

      const events = store.get("slow-knoll")
      expect(events.map((e) => e.type)).toEqual(["turn_started", "user_message", "turn_completed"])
      expect(store.highWaterMark("slow-knoll")).toBe(events[events.length - 1].seq)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
