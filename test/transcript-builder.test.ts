import { describe, it, expect } from "vitest"
import { TranscriptBuilder } from "../src/transcript/transcript-builder.js"
import type { GooseStreamEvent } from "../src/domain/goose-types.js"
import type {
  AssistantTextEvent,
  StatusEvent,
  ThinkingEvent,
  ToolCallEvent,
  ToolResultEvent,
  TranscriptEvent,
  TurnCompletedEvent,
  TurnStartedEvent,
  UserMessageEvent,
} from "../src/transcript/types.js"

function makeBuilder(sessionId = "slow-knoll") {
  let t = 1_700_000_000_000
  let n = 0
  return new TranscriptBuilder({
    sessionId,
    now: () => {
      t += 1
      return t
    },
    idGen: () => `id_${n++}`,
  })
}

function textMsg(text: string): GooseStreamEvent {
  return {
    type: "message",
    message: {
      role: "assistant",
      created: 0,
      content: [{ type: "text", text }],
    },
  }
}

function toolRequest(id: string, name: string, args: Record<string, unknown>): GooseStreamEvent {
  return {
    type: "message",
    message: {
      role: "assistant",
      created: 0,
      content: [
        {
          type: "toolRequest",
          id,
          toolCall: { name, arguments: args },
        },
      ],
    },
  }
}

function toolResponse(id: string, result: unknown): GooseStreamEvent {
  return {
    type: "message",
    message: {
      role: "user",
      created: 0,
      content: [{ type: "toolResponse", id, toolResult: result }],
    },
  }
}

function byType<T extends TranscriptEvent["type"]>(
  events: TranscriptEvent[],
  type: T,
): Extract<TranscriptEvent, { type: T }>[] {
  return events.filter((e): e is Extract<TranscriptEvent, { type: T }> => e.type === type)
}

describe("TranscriptBuilder — turn lifecycle", () => {
  it("startTurn → text → completeTurn emits the right sequence", () => {
    const b = makeBuilder()
    const started = b.startTurn("user_message") as TurnStartedEvent[]
    expect(started).toHaveLength(1)
    expect(started[0].type).toBe("turn_started")
    expect(started[0].trigger).toBe("user_message")
    expect(started[0].turn).toBe(0)
    expect(started[0].seq).toBe(0)

    const text = b.handleEvent(textMsg("Hello "))
    expect(text).toHaveLength(1)
    expect(text[0].type).toBe("assistant_text")
    expect((text[0] as AssistantTextEvent).final).toBe(false)

    const completed = b.completeTurn({ totalTokens: 42, totalCostUsd: 0.001 })
    expect(completed).toHaveLength(2)
    expect(completed[0].type).toBe("assistant_text")
    expect((completed[0] as AssistantTextEvent).final).toBe(true)
    expect((completed[0] as AssistantTextEvent).text).toBe("Hello ")
    expect(completed[1].type).toBe("turn_completed")
    const turnDone = completed[1] as TurnCompletedEvent
    expect(turnDone.totalTokens).toBe(42)
    expect(turnDone.totalCostUsd).toBe(0.001)
    expect(turnDone.durationMs).toBeGreaterThanOrEqual(0)
    expect(b.isTurnActive).toBe(false)
  })

  it("increments turn index across consecutive turns", () => {
    const b = makeBuilder()
    b.startTurn("user_message")
    b.completeTurn()
    const second = b.startTurn("reply_injected") as TurnStartedEvent[]
    expect(second[0].turn).toBe(1)
    expect(second[0].trigger).toBe("reply_injected")
  })

  it("startTurn auto-completes a pending turn", () => {
    const b = makeBuilder()
    b.startTurn("user_message")
    b.handleEvent(textMsg("partial"))
    const events = b.startTurn("reply_injected")
    const types = events.map((e) => e.type)
    expect(types).toEqual(["assistant_text", "turn_completed", "turn_started"])
    expect((events[0] as AssistantTextEvent).final).toBe(true)
    expect((events[2] as TurnStartedEvent).trigger).toBe("reply_injected")
  })

  it("completeTurn is a no-op when no turn is active", () => {
    const b = makeBuilder()
    expect(b.completeTurn()).toEqual([])
  })
})

describe("TranscriptBuilder — user message mirroring", () => {
  it("auto-starts a user_message turn and emits user_message", () => {
    const b = makeBuilder()
    const out = b.userMessage("hi there", ["data:image/png;base64,AAA"])
    expect(out.map((e) => e.type)).toEqual(["turn_started", "user_message"])
    expect((out[0] as TurnStartedEvent).trigger).toBe("user_message")
    expect((out[1] as UserMessageEvent).text).toBe("hi there")
    expect((out[1] as UserMessageEvent).images).toEqual(["data:image/png;base64,AAA"])
  })

  it("does not start a new turn when one is already open", () => {
    const b = makeBuilder()
    b.startTurn("user_message")
    const out = b.userMessage("mid-turn")
    expect(out.map((e) => e.type)).toEqual(["user_message"])
  })
})

describe("TranscriptBuilder — streaming text", () => {
  it("emits deltas for each text chunk and a final on flush", () => {
    const b = makeBuilder()
    b.startTurn("user_message")
    const e1 = b.handleEvent(textMsg("Hel")) as AssistantTextEvent[]
    const e2 = b.handleEvent(textMsg("lo")) as AssistantTextEvent[]
    expect(e1[0].final).toBe(false)
    expect(e2[0].final).toBe(false)
    expect(e1[0].blockId).toBe(e2[0].blockId)
    const completed = b.completeTurn()
    const final = completed.find((e) => e.type === "assistant_text") as AssistantTextEvent
    expect(final.final).toBe(true)
    expect(final.text).toBe("Hello")
    expect(final.blockId).toBe(e1[0].blockId)
  })

  it("skips empty text chunks but keeps the block open", () => {
    const b = makeBuilder()
    b.startTurn("user_message")
    const empty = b.handleEvent(textMsg(""))
    expect(empty).toHaveLength(0)
    const chunk = b.handleEvent(textMsg("real")) as AssistantTextEvent[]
    expect(chunk).toHaveLength(1)
  })

  it("starts a new text block after a tool call interrupts", () => {
    const b = makeBuilder()
    b.startTurn("user_message")
    const first = b.handleEvent(textMsg("before")) as AssistantTextEvent[]
    b.handleEvent(toolRequest("t1", "Bash", { command: "ls" }))
    const second = b.handleEvent(textMsg("after")) as AssistantTextEvent[]
    expect(second[0].blockId).not.toBe(first[0].blockId)
  })
})

describe("TranscriptBuilder — thinking", () => {
  it("buffers thinking chunks as deltas and finalizes on flush", () => {
    const b = makeBuilder()
    b.startTurn("user_message")
    b.handleEvent({
      type: "message",
      message: {
        role: "assistant",
        created: 0,
        content: [{ type: "thinking", thinking: "Let me ", signature: "sig" }],
      },
    })
    b.handleEvent({
      type: "message",
      message: {
        role: "assistant",
        created: 0,
        content: [{ type: "thinking", thinking: "think…", signature: "sig" }],
      },
    })
    const completed = b.completeTurn()
    const think = completed.find((e) => e.type === "thinking") as ThinkingEvent
    expect(think.text).toBe("Let me think…")
    expect(think.final).toBe(true)
  })

  it("flushes active text when thinking interrupts", () => {
    const b = makeBuilder()
    b.startTurn("user_message")
    const text = b.handleEvent(textMsg("some text")) as AssistantTextEvent[]
    const events = b.handleEvent({
      type: "message",
      message: {
        role: "assistant",
        created: 0,
        content: [{ type: "thinking", thinking: "hmm", signature: "sig" }],
      },
    })
    const types = events.map((e) => e.type)
    expect(types[0]).toBe("assistant_text")
    expect((events[0] as AssistantTextEvent).final).toBe(true)
    expect((events[0] as AssistantTextEvent).blockId).toBe(text[0].blockId)
    expect(types[1]).toBe("thinking")
  })
})

describe("TranscriptBuilder — tool calls", () => {
  it("classifies and emits a tool_call event", () => {
    const b = makeBuilder()
    b.startTurn("user_message")
    const events = b.handleEvent(toolRequest("t1", "Bash", { command: "npm test" }))
    const call = byType(events, "tool_call")[0] as ToolCallEvent
    expect(call.call.kind).toBe("bash")
    expect(call.call.subtitle).toBe("npm test")
    expect(call.call.toolUseId).toBe("t1")
  })

  it("pairs a tool_call with a later tool_result via toolUseId", () => {
    const b = makeBuilder()
    b.startTurn("user_message")
    b.handleEvent(toolRequest("t1", "Read", { path: "README.md" }))
    const events = b.handleEvent(toolResponse("t1", "contents of readme"))
    const result = byType(events, "tool_result")[0] as ToolResultEvent
    expect(result.toolUseId).toBe("t1")
    expect(result.result.status).toBe("ok")
    expect(result.result.text).toBe("contents of readme")
  })

  it("applies the bash byte budget when the pending call is Bash", () => {
    const b = makeBuilder()
    b.startTurn("user_message")
    b.handleEvent(toolRequest("t1", "Bash", { command: "cat big.log" }))
    const big = "x".repeat(80 * 1024)
    const events = b.handleEvent(toolResponse("t1", big))
    const result = byType(events, "tool_result")[0] as ToolResultEvent
    expect(result.result.truncated).toBe(true)
    expect(result.result.originalBytes).toBe(80 * 1024)
  })

  it("handles a toolResponse without a matching call (falls back to default budget)", () => {
    const b = makeBuilder()
    b.startTurn("user_message")
    const events = b.handleEvent(toolResponse("orphan", "payload"))
    const result = byType(events, "tool_result")[0] as ToolResultEvent
    expect(result.toolUseId).toBe("orphan")
    expect(result.result.text).toBe("payload")
  })

  it("flushes buffered text before a tool call", () => {
    const b = makeBuilder()
    b.startTurn("user_message")
    b.handleEvent(textMsg("intro "))
    const events = b.handleEvent(toolRequest("t1", "Bash", { command: "ls" }))
    expect(events.map((e) => e.type)).toEqual(["assistant_text", "tool_call"])
    expect((events[0] as AssistantTextEvent).final).toBe(true)
    expect((events[0] as AssistantTextEvent).text).toBe("intro ")
  })

  it("emits a status event when toolCall carries an error", () => {
    const b = makeBuilder()
    b.startTurn("user_message")
    const events = b.handleEvent({
      type: "message",
      message: {
        role: "assistant",
        created: 0,
        content: [{ type: "toolRequest", id: "bad", toolCall: { error: "bad args" } }],
      },
    })
    const status = byType(events, "status")[0] as StatusEvent
    expect(status.kind).toBe("tool_call_error")
    expect(status.severity).toBe("error")
    expect(status.message).toBe("bad args")
    expect(status.data).toEqual({ toolUseId: "bad" })
  })
})

describe("TranscriptBuilder — status & error events", () => {
  it("emits standalone status events with custom data", () => {
    const b = makeBuilder()
    const evt = b.status("quota_sleep", "Sleeping until quota resets", {
      severity: "warn",
      data: { resumeAt: 123 },
    })
    expect(evt.kind).toBe("quota_sleep")
    expect(evt.severity).toBe("warn")
    expect(evt.data).toEqual({ resumeAt: 123 })
  })

  it("maps quota_exhausted stream events to warn status", () => {
    const b = makeBuilder()
    const events = b.handleEvent({
      type: "quota_exhausted",
      resetAt: 999,
      rawMessage: "hit the limit",
    })
    const status = events[0] as StatusEvent
    expect(status.type).toBe("status")
    expect(status.kind).toBe("quota_exhausted")
    expect(status.severity).toBe("warn")
    expect(status.data).toEqual({ resetAt: 999 })
  })

  it("error mid-turn completes the turn with errored:true", () => {
    const b = makeBuilder()
    b.startTurn("user_message")
    b.handleEvent(textMsg("partial"))
    const events = b.handleEvent({ type: "error", error: "boom" })
    const done = events.find((e) => e.type === "turn_completed") as TurnCompletedEvent
    expect(done.errored).toBe(true)
    expect(b.isTurnActive).toBe(false)
  })

  it("error with no active turn produces a status event", () => {
    const b = makeBuilder()
    const events = b.handleEvent({ type: "error", error: "boom" })
    const status = events[0] as StatusEvent
    expect(status.type).toBe("status")
    expect(status.kind).toBe("session_error")
    expect(status.severity).toBe("error")
  })
})

describe("TranscriptBuilder — complete event", () => {
  it("maps a complete stream event to turn_completed with totals", () => {
    const b = makeBuilder()
    b.startTurn("user_message")
    b.handleEvent(textMsg("final"))
    const events = b.handleEvent({
      type: "complete",
      total_tokens: 100,
      total_cost_usd: 0.5,
      num_turns: 1,
    })
    const done = events.find((e) => e.type === "turn_completed") as TurnCompletedEvent
    expect(done.totalTokens).toBe(100)
    expect(done.totalCostUsd).toBe(0.5)
  })

  it("ignores idle and notification stream events", () => {
    const b = makeBuilder()
    b.startTurn("user_message")
    expect(b.handleEvent({ type: "idle" })).toEqual([])
    expect(
      b.handleEvent({ type: "notification", extensionId: "x", message: "y" }),
    ).toEqual([])
    expect(b.isTurnActive).toBe(true)
  })
})

describe("TranscriptBuilder — invariants", () => {
  it("produces strictly monotonic seq numbers", () => {
    const b = makeBuilder()
    const all: TranscriptEvent[] = []
    all.push(...b.userMessage("hi"))
    all.push(...b.handleEvent(textMsg("reply ")))
    all.push(...b.handleEvent(toolRequest("t1", "Bash", { command: "ls" })))
    all.push(...b.handleEvent(toolResponse("t1", "ok")))
    all.push(...b.handleEvent(textMsg("done")))
    all.push(...b.completeTurn({ totalTokens: 1 }))
    for (let i = 1; i < all.length; i++) {
      expect(all[i].seq).toBe(all[i - 1].seq + 1)
    }
  })

  it("stamps every event with the session id", () => {
    const b = makeBuilder("crisp-dune")
    const events = [
      ...b.userMessage("hi"),
      ...b.handleEvent(textMsg("ok")),
      ...b.completeTurn(),
    ]
    for (const evt of events) expect(evt.sessionId).toBe("crisp-dune")
  })

  it("auto-starts a turn when an assistant message arrives first", () => {
    const b = makeBuilder()
    const events = b.handleEvent(textMsg("bare"))
    expect(events[0].type).toBe("turn_started")
    expect((events[0] as TurnStartedEvent).trigger).toBe("agent_continuation")
    expect(events[1].type).toBe("assistant_text")
  })

  it("auto-starts a turn when an orphan toolResponse arrives first", () => {
    const b = makeBuilder()
    const events = b.handleEvent(toolResponse("t1", "payload"))
    expect(events[0].type).toBe("turn_started")
    expect(events[events.length - 1].type).toBe("tool_result")
  })

  it("exposes nextSeq and currentTurn for consumers", () => {
    const b = makeBuilder()
    expect(b.nextSeq).toBe(0)
    expect(b.currentTurn).toBe(0)
    b.userMessage("hi")
    expect(b.nextSeq).toBeGreaterThan(0)
    b.completeTurn()
    b.startTurn("reply_injected")
    expect(b.currentTurn).toBe(1)
  })
})
