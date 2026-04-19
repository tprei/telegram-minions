import { describe, it, expect } from "vitest"
import * as pkg from "../src/index.js"
import {
  TRANSCRIPT_TRUNCATION_BUDGET,
  TranscriptBuilder,
  TranscriptStore,
  buildToolCallSummary,
  buildToolResultPayload,
  classifyTool,
  isTranscriptEventOfType,
  parseMcpName,
} from "../src/index.js"
import type {
  AssistantTextEvent,
  StatusEvent,
  StatusSeverity,
  ThinkingEvent,
  ToolCallEvent,
  ToolCallSummary,
  ToolKind,
  ToolResultEvent,
  ToolResultFormat,
  ToolResultPayload,
  ToolResultStatus,
  TranscriptEvent,
  TranscriptEventBase,
  TranscriptEventType,
  TranscriptSessionInfo,
  TranscriptSnapshot,
  TranscriptTruncationBudget,
  TurnCompletedEvent,
  TurnStartedEvent,
  TurnTrigger,
  UserMessageEvent,
  BuildToolCallSummaryOptions,
  BuildToolResultOptions,
  ClassifiedTool,
  CompleteTurnOptions,
  StatusOptions,
  TranscriptBuilderOptions,
} from "../src/index.js"

describe("top-level index — transcript exports", () => {
  it("re-exports runtime functions and classes", () => {
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

  it("exposes the same bindings via namespace import", () => {
    expect(pkg.TranscriptBuilder).toBe(TranscriptBuilder)
    expect(pkg.TranscriptStore).toBe(TranscriptStore)
    expect(pkg.classifyTool).toBe(classifyTool)
    expect(pkg.buildToolCallSummary).toBe(buildToolCallSummary)
    expect(pkg.buildToolResultPayload).toBe(buildToolResultPayload)
    expect(pkg.parseMcpName).toBe(parseMcpName)
    expect(pkg.isTranscriptEventOfType).toBe(isTranscriptEventOfType)
    expect(pkg.TRANSCRIPT_TRUNCATION_BUDGET).toBe(TRANSCRIPT_TRUNCATION_BUDGET)
  })

  it("matches identity with the transcript module barrel", async () => {
    const barrel = await import("../src/transcript/index.js")
    expect(pkg.TranscriptBuilder).toBe(barrel.TranscriptBuilder)
    expect(pkg.TranscriptStore).toBe(barrel.TranscriptStore)
    expect(pkg.classifyTool).toBe(barrel.classifyTool)
    expect(pkg.buildToolCallSummary).toBe(barrel.buildToolCallSummary)
    expect(pkg.buildToolResultPayload).toBe(barrel.buildToolResultPayload)
    expect(pkg.parseMcpName).toBe(barrel.parseMcpName)
    expect(pkg.isTranscriptEventOfType).toBe(barrel.isTranscriptEventOfType)
    expect(pkg.TRANSCRIPT_TRUNCATION_BUDGET).toBe(barrel.TRANSCRIPT_TRUNCATION_BUDGET)
  })

  it("re-exports event payload types with structural equivalence", () => {
    const base: TranscriptEventBase = {
      seq: 0,
      id: "e0",
      sessionId: "slow-knoll",
      turn: 0,
      timestamp: 1_700_000_000_000,
    }
    const user: UserMessageEvent = { ...base, type: "user_message", text: "hi" }
    const started: TurnStartedEvent = { ...base, seq: 1, type: "turn_started", trigger: "user_message" }
    const completed: TurnCompletedEvent = { ...base, seq: 2, type: "turn_completed" }
    const text: AssistantTextEvent = {
      ...base,
      seq: 3,
      type: "assistant_text",
      blockId: "b",
      text: "x",
      final: true,
    }
    const thinking: ThinkingEvent = {
      ...base,
      seq: 4,
      type: "thinking",
      blockId: "t",
      text: "t",
      final: true,
    }
    const summary: ToolCallSummary = {
      toolUseId: "tu",
      name: "Bash",
      kind: "bash" satisfies ToolKind,
      title: "Run command",
      input: {},
    }
    const call: ToolCallEvent = { ...base, seq: 5, type: "tool_call", call: summary }
    const payload: ToolResultPayload = {
      status: "ok" satisfies ToolResultStatus,
      format: "text" satisfies ToolResultFormat,
    }
    const result: ToolResultEvent = {
      ...base,
      seq: 6,
      type: "tool_result",
      toolUseId: "tu",
      result: payload,
    }
    const status: StatusEvent = {
      ...base,
      seq: 7,
      type: "status",
      severity: "info" satisfies StatusSeverity,
      kind: "quota_sleep",
      message: "sleeping",
    }
    const trigger: TurnTrigger = "reply_injected"
    const all: TranscriptEvent[] = [user, started, completed, text, thinking, call, result, status]
    const types: TranscriptEventType[] = all.map((e) => e.type)
    expect(types).toEqual([
      "user_message",
      "turn_started",
      "turn_completed",
      "assistant_text",
      "thinking",
      "tool_call",
      "tool_result",
      "status",
    ])
    expect(trigger).toBe("reply_injected")
  })

  it("re-exports session metadata and snapshot envelopes", () => {
    const session: TranscriptSessionInfo = {
      sessionId: "slow-knoll",
      startedAt: 1_700_000_000_000,
    }
    const snapshot: TranscriptSnapshot = { session, events: [], highWaterMark: -1 }
    expect(snapshot.session.sessionId).toBe("slow-knoll")
    const budget: TranscriptTruncationBudget = TRANSCRIPT_TRUNCATION_BUDGET
    expect(budget.fileBytes).toBeGreaterThan(0)
  })

  it("re-exports option and classifier helper types", () => {
    const builderOpts: TranscriptBuilderOptions = { sessionId: "s" }
    const completeOpts: CompleteTurnOptions = { totalTokens: 1 }
    const statusOpts: StatusOptions = { severity: "warn" }
    const callOpts: BuildToolCallSummaryOptions = { parentToolUseId: "p" }
    const resultOpts: BuildToolResultOptions = { toolName: "Bash" }
    expect(builderOpts.sessionId).toBe("s")
    expect(completeOpts.totalTokens).toBe(1)
    expect(statusOpts.severity).toBe("warn")
    expect(callOpts.parentToolUseId).toBe("p")
    expect(resultOpts.toolName).toBe("Bash")
    const classified: ClassifiedTool = classifyTool("Bash", { command: "ls" })
    expect(classified.kind).toBe("bash")
    expect(classified.title).toBe("Run command")
    expect(classified.subtitle).toBe("ls")
  })

  it("integrates builder, classifier, and store through the top-level exports", async () => {
    const os = await import("node:os")
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "index-transcript-"))

    try {
      const store = new TranscriptStore(dir)
      let n = 0
      const builder = new TranscriptBuilder({
        sessionId: "slow-knoll",
        now: () => 1_700_000_000_000,
        idGen: () => `id-${++n}`,
      })

      for (const e of builder.userMessage("hi")) await store.append("slow-knoll", e)
      const completion = builder.handleEvent({ type: "complete", total_tokens: 7 })
      for (const e of completion) await store.append("slow-knoll", e)
      await store.flush()

      const events = store.get("slow-knoll")
      expect(events.map((e) => e.type)).toEqual([
        "turn_started",
        "user_message",
        "turn_completed",
      ])
      expect(events.every((e) => isTranscriptEventOfType(e, e.type))).toBe(true)
      expect(store.highWaterMark("slow-knoll")).toBe(events[events.length - 1].seq)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
