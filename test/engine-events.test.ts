import { describe, it, expect } from "vitest"
import { EngineEventBus, type EngineEvent } from "../src/engine/events.js"
import type { TopicSession } from "../src/domain/session-types.js"
import type { TranscriptEvent, TranscriptEventType } from "../src/transcript/types.js"

function makeTopicSession(slug = "happy-otter"): TopicSession {
  return {
    threadId: 1,
    slug,
    repo: "test-repo",
    cwd: "/tmp/test",
    createdAt: 1,
    lastActivityAt: 1,
    conversation: [],
    childThreadIds: [],
  } as unknown as TopicSession
}

function makeTranscriptBase(
  overrides: Partial<{ seq: number; id: string; sessionId: string; turn: number; timestamp: number }> = {},
) {
  return {
    seq: overrides.seq ?? 0,
    id: overrides.id ?? "evt_0",
    sessionId: overrides.sessionId ?? "happy-otter",
    turn: overrides.turn ?? 0,
    timestamp: overrides.timestamp ?? 1_700_000_000_000,
  }
}

describe("EngineEventBus", () => {
  it("invokes the handler for matching event types", async () => {
    const bus = new EngineEventBus()
    const seen: EngineEvent[] = []
    bus.on("session_created", (e) => { seen.push(e) })
    await bus.emit({ type: "session_created", session: makeTopicSession() })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.type).toBe("session_created")
  })

  it("ignores events of a different type", async () => {
    const bus = new EngineEventBus()
    const seen: EngineEvent[] = []
    bus.on("session_created", (e) => { seen.push(e) })
    await bus.emit({ type: "session_deleted", sessionId: "x" })
    expect(seen).toHaveLength(0)
  })

  it("routes every event to wildcard subscribers", async () => {
    const bus = new EngineEventBus()
    const seen: EngineEvent[] = []
    bus.onAny((e) => { seen.push(e) })
    await bus.emit({ type: "session_created", session: makeTopicSession() })
    await bus.emit({ type: "session_deleted", sessionId: "gone" })
    expect(seen.map((e) => e.type)).toEqual(["session_created", "session_deleted"])
  })

  it("awaits async handlers in registration order", async () => {
    const bus = new EngineEventBus()
    const order: string[] = []
    bus.on("assistant_text", async () => {
      await new Promise((r) => setTimeout(r, 5))
      order.push("first")
    })
    bus.on("assistant_text", () => { order.push("second") })
    await bus.emit({ type: "assistant_text", sessionId: "s", text: "hi", timestamp: 0 })
    expect(order).toEqual(["first", "second"])
  })

  it("continues dispatch when a handler throws", async () => {
    const bus = new EngineEventBus()
    const seen: string[] = []
    bus.on("session_updated", () => { throw new Error("boom") })
    bus.on("session_updated", () => { seen.push("survived") })
    await bus.emit({ type: "session_updated", session: makeTopicSession() })
    expect(seen).toEqual(["survived"])
  })

  it("unsubscribes via the returned disposer", async () => {
    const bus = new EngineEventBus()
    const seen: string[] = []
    const unsubscribe = bus.on("dag_created", () => { seen.push("hit") })
    unsubscribe()
    await bus.emit({ type: "dag_created", dag: { dagId: "d1", nodes: [] } as never })
    expect(seen).toEqual([])
  })

  it("dispatches transcript_event envelopes with the inner TranscriptEvent", async () => {
    const bus = new EngineEventBus()
    const seen: Array<Extract<EngineEvent, { type: "transcript_event" }>> = []
    bus.on("transcript_event", (e) => { seen.push(e) })
    const inner: TranscriptEvent = {
      seq: 0,
      id: "evt_1",
      sessionId: "happy-otter",
      turn: 0,
      timestamp: 1_700_000_000_000,
      type: "assistant_text",
      blockId: "b",
      text: "hi",
      final: true,
    }
    await bus.emit({ type: "transcript_event", sessionId: "happy-otter", event: inner })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.sessionId).toBe("happy-otter")
    expect(seen[0]?.event.type).toBe("assistant_text")
    expect(seen[0]?.event.seq).toBe(0)
  })
})

describe("EngineEventBus — transcript_event variant", () => {
  it("does not route transcript_event to handlers registered for other types", async () => {
    const bus = new EngineEventBus()
    const seenAssistantText: EngineEvent[] = []
    const seenTranscript: EngineEvent[] = []
    bus.on("assistant_text", (e) => { seenAssistantText.push(e) })
    bus.on("transcript_event", (e) => { seenTranscript.push(e) })

    const inner: TranscriptEvent = {
      ...makeTranscriptBase(),
      type: "assistant_text",
      blockId: "b1",
      text: "hello",
      final: true,
    }
    await bus.emit({ type: "transcript_event", sessionId: "happy-otter", event: inner })

    expect(seenAssistantText).toHaveLength(0)
    expect(seenTranscript).toHaveLength(1)
  })

  it("routes transcript_event envelopes to wildcard subscribers", async () => {
    const bus = new EngineEventBus()
    const seen: EngineEvent[] = []
    bus.onAny((e) => { seen.push(e) })

    const inner: TranscriptEvent = {
      ...makeTranscriptBase({ seq: 3, id: "evt_3" }),
      type: "turn_started",
      trigger: "user_message",
    }
    await bus.emit({ type: "transcript_event", sessionId: "happy-otter", event: inner })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.type).toBe("transcript_event")
    const envelope = seen[0] as Extract<EngineEvent, { type: "transcript_event" }>
    expect(envelope.event.type).toBe("turn_started")
    expect(envelope.event.seq).toBe(3)
  })

  it("preserves every inner TranscriptEvent variant unchanged", async () => {
    const bus = new EngineEventBus()
    const received: TranscriptEvent[] = []
    bus.on("transcript_event", (e) => { received.push(e.event) })

    const events: TranscriptEvent[] = [
      { ...makeTranscriptBase({ seq: 0, id: "e0" }), type: "user_message", text: "do the thing", images: ["img1.png"] },
      { ...makeTranscriptBase({ seq: 1, id: "e1" }), type: "turn_started", trigger: "user_message" },
      { ...makeTranscriptBase({ seq: 2, id: "e2" }), type: "assistant_text", blockId: "b1", text: "ok ", final: false },
      { ...makeTranscriptBase({ seq: 3, id: "e3" }), type: "assistant_text", blockId: "b1", text: "ok then", final: true },
      { ...makeTranscriptBase({ seq: 4, id: "e4" }), type: "thinking", blockId: "t1", text: "hmm", final: true, signature: "sig" },
      {
        ...makeTranscriptBase({ seq: 5, id: "e5" }),
        type: "tool_call",
        call: {
          toolUseId: "tu_1",
          name: "Bash",
          kind: "bash",
          title: "Run ls",
          subtitle: "in /workspace",
          input: { command: "ls" },
        },
      },
      {
        ...makeTranscriptBase({ seq: 6, id: "e6" }),
        type: "tool_result",
        toolUseId: "tu_1",
        result: { status: "ok", text: "file1\nfile2", format: "text", meta: { exitCode: 0 } },
      },
      {
        ...makeTranscriptBase({ seq: 7, id: "e7" }),
        type: "status",
        severity: "warn",
        kind: "quota_sleep",
        message: "Waiting 30s for quota window",
        data: { waitMs: 30_000 },
      },
      {
        ...makeTranscriptBase({ seq: 8, id: "e8" }),
        type: "turn_completed",
        totalTokens: 1234,
        totalCostUsd: 0.0123,
        durationMs: 4567,
        errored: false,
      },
    ]

    for (const inner of events) {
      await bus.emit({ type: "transcript_event", sessionId: inner.sessionId, event: inner })
    }

    expect(received).toHaveLength(events.length)
    expect(received.map((e) => e.type)).toEqual([
      "user_message",
      "turn_started",
      "assistant_text",
      "assistant_text",
      "thinking",
      "tool_call",
      "tool_result",
      "status",
      "turn_completed",
    ] satisfies TranscriptEventType[])

    // Object identity is preserved — the bus does not clone/repackage inner payloads.
    for (let i = 0; i < events.length; i++) {
      expect(received[i]).toBe(events[i])
    }
  })

  it("preserves monotonic seq ordering for transcript_event emission", async () => {
    const bus = new EngineEventBus()
    const seqs: number[] = []
    bus.on("transcript_event", (e) => { seqs.push(e.event.seq) })

    for (let seq = 0; seq < 5; seq++) {
      const inner: TranscriptEvent = {
        ...makeTranscriptBase({ seq, id: `e${seq}` }),
        type: "assistant_text",
        blockId: "b",
        text: `chunk-${seq}`,
        final: seq === 4,
      }
      await bus.emit({ type: "transcript_event", sessionId: "happy-otter", event: inner })
    }

    expect(seqs).toEqual([0, 1, 2, 3, 4])
  })

  it("interleaves transcript_event with other engine events on wildcard subscribers", async () => {
    const bus = new EngineEventBus()
    const types: string[] = []
    bus.onAny((e) => { types.push(e.type) })

    await bus.emit({ type: "session_created", session: makeTopicSession() })
    await bus.emit({
      type: "transcript_event",
      sessionId: "happy-otter",
      event: { ...makeTranscriptBase(), type: "turn_started", trigger: "user_message" },
    })
    await bus.emit({ type: "assistant_activity", sessionId: "happy-otter", activity: "thinking", timestamp: 1 })
    await bus.emit({
      type: "transcript_event",
      sessionId: "happy-otter",
      event: { ...makeTranscriptBase({ seq: 1, id: "e1" }), type: "turn_completed" },
    })
    await bus.emit({ type: "session_deleted", sessionId: "happy-otter" })

    expect(types).toEqual([
      "session_created",
      "transcript_event",
      "assistant_activity",
      "transcript_event",
      "session_deleted",
    ])
  })

  it("continues dispatching transcript_event to later handlers when an earlier handler throws", async () => {
    const bus = new EngineEventBus()
    const survivors: string[] = []
    bus.on("transcript_event", () => { throw new Error("boom") })
    bus.on("transcript_event", (e) => { survivors.push(e.event.id) })

    const inner: TranscriptEvent = {
      ...makeTranscriptBase({ id: "evt_survivor" }),
      type: "status",
      severity: "info",
      kind: "note",
      message: "ping",
    }
    await bus.emit({ type: "transcript_event", sessionId: "happy-otter", event: inner })

    expect(survivors).toEqual(["evt_survivor"])
  })

  it("unsubscribes transcript_event handlers via the returned disposer", async () => {
    const bus = new EngineEventBus()
    const hits: number[] = []
    const unsubscribe = bus.on("transcript_event", (e) => { hits.push(e.event.seq) })

    await bus.emit({
      type: "transcript_event",
      sessionId: "happy-otter",
      event: { ...makeTranscriptBase({ seq: 10, id: "e10" }), type: "turn_started", trigger: "command" },
    })
    unsubscribe()
    await bus.emit({
      type: "transcript_event",
      sessionId: "happy-otter",
      event: { ...makeTranscriptBase({ seq: 11, id: "e11" }), type: "turn_started", trigger: "command" },
    })

    expect(hits).toEqual([10])
  })

  it("counts transcript_event listeners separately from other event types", () => {
    const bus = new EngineEventBus()
    bus.on("transcript_event", () => {})
    bus.on("transcript_event", () => {})
    bus.on("session_created", () => {})
    bus.onAny(() => {})

    expect(bus.listenerCount).toBe(4)
    expect(bus.listenerCountFor("transcript_event")).toBe(2)
    expect(bus.listenerCountFor("session_created")).toBe(1)
    expect(bus.listenerCountFor("*")).toBe(1)
    expect(bus.listenerCountFor("assistant_text")).toBe(0)
  })

  it("clears transcript_event handlers along with the rest of the bus", async () => {
    const bus = new EngineEventBus()
    const seen: string[] = []
    bus.on("transcript_event", (e) => { seen.push(e.event.id) })
    bus.onAny((e) => { seen.push(`any:${e.type}`) })

    bus.clear()
    expect(bus.listenerCount).toBe(0)

    await bus.emit({
      type: "transcript_event",
      sessionId: "happy-otter",
      event: { ...makeTranscriptBase({ id: "post-clear" }), type: "turn_started", trigger: "resume" },
    })

    expect(seen).toEqual([])
  })

  it("supports multiple concurrent sessions on the same bus", async () => {
    const bus = new EngineEventBus()
    const bySession: Record<string, number[]> = {}
    bus.on("transcript_event", (e) => {
      const bucket = bySession[e.sessionId] ?? (bySession[e.sessionId] = [])
      bucket.push(e.event.seq)
    })

    await bus.emit({
      type: "transcript_event",
      sessionId: "happy-otter",
      event: { ...makeTranscriptBase({ sessionId: "happy-otter", seq: 0, id: "a0" }), type: "turn_started", trigger: "user_message" },
    })
    await bus.emit({
      type: "transcript_event",
      sessionId: "brave-lynx",
      event: { ...makeTranscriptBase({ sessionId: "brave-lynx", seq: 0, id: "b0" }), type: "turn_started", trigger: "user_message" },
    })
    await bus.emit({
      type: "transcript_event",
      sessionId: "happy-otter",
      event: { ...makeTranscriptBase({ sessionId: "happy-otter", seq: 1, id: "a1" }), type: "turn_completed" },
    })

    expect(bySession).toEqual({ "happy-otter": [0, 1], "brave-lynx": [0] })
  })

  it("awaits async transcript_event handlers in registration order", async () => {
    const bus = new EngineEventBus()
    const order: string[] = []
    bus.on("transcript_event", async () => {
      await new Promise((r) => setTimeout(r, 5))
      order.push("slow")
    })
    bus.on("transcript_event", () => { order.push("fast") })

    const inner: TranscriptEvent = {
      ...makeTranscriptBase(),
      type: "assistant_text",
      blockId: "b",
      text: "hi",
      final: true,
    }
    await bus.emit({ type: "transcript_event", sessionId: "happy-otter", event: inner })

    expect(order).toEqual(["slow", "fast"])
  })

  it("carries tool_call input and classification through the envelope unchanged", async () => {
    const bus = new EngineEventBus()
    let received: TranscriptEvent | undefined
    bus.on("transcript_event", (e) => { received = e.event })

    const inner: TranscriptEvent = {
      ...makeTranscriptBase({ seq: 2, id: "tc1" }),
      type: "tool_call",
      call: {
        toolUseId: "tu_42",
        name: "Edit",
        kind: "edit",
        title: "Edit file",
        subtitle: "src/foo.ts",
        input: { path: "src/foo.ts", old_string: "a", new_string: "b" },
        parentToolUseId: "parent_1",
      },
    }
    await bus.emit({ type: "transcript_event", sessionId: "happy-otter", event: inner })

    expect(received?.type).toBe("tool_call")
    if (received?.type === "tool_call") {
      expect(received.call.kind).toBe("edit")
      expect(received.call.toolUseId).toBe("tu_42")
      expect(received.call.parentToolUseId).toBe("parent_1")
      expect(received.call.input).toEqual({ path: "src/foo.ts", old_string: "a", new_string: "b" })
    }
  })

  it("carries tool_result truncation metadata through the envelope unchanged", async () => {
    const bus = new EngineEventBus()
    let received: TranscriptEvent | undefined
    bus.on("transcript_event", (e) => { received = e.event })

    const inner: TranscriptEvent = {
      ...makeTranscriptBase({ seq: 3, id: "tr1" }),
      type: "tool_result",
      toolUseId: "tu_42",
      result: {
        status: "ok",
        text: "line1\nline2",
        truncated: true,
        originalBytes: 131_072,
        format: "diff",
        meta: { exitCode: 0, cwd: "/workspace" },
      },
    }
    await bus.emit({ type: "transcript_event", sessionId: "happy-otter", event: inner })

    expect(received?.type).toBe("tool_result")
    if (received?.type === "tool_result") {
      expect(received.toolUseId).toBe("tu_42")
      expect(received.result.truncated).toBe(true)
      expect(received.result.originalBytes).toBe(131_072)
      expect(received.result.format).toBe("diff")
      expect(received.result.meta?.cwd).toBe("/workspace")
    }
  })

  it("does not mutate the envelope sessionId when it differs from the inner event", async () => {
    // The engine is the source of truth for the envelope sessionId; the inner
    // event's sessionId is informational. Handlers should see both verbatim.
    const bus = new EngineEventBus()
    let envelope: Extract<EngineEvent, { type: "transcript_event" }> | undefined
    bus.on("transcript_event", (e) => { envelope = e })

    const inner: TranscriptEvent = {
      ...makeTranscriptBase({ sessionId: "inner-session" }),
      type: "turn_started",
      trigger: "reply_injected",
    }
    await bus.emit({ type: "transcript_event", sessionId: "outer-session", event: inner })

    expect(envelope?.sessionId).toBe("outer-session")
    expect(envelope?.event.sessionId).toBe("inner-session")
  })
})
