import { describe, it, expect, afterEach } from "vitest"
import { HttpConnector } from "../src/connectors/http-connector.js"
import { EngineEventBus } from "../src/engine/events.js"
import type { MinionEngine } from "../src/engine/engine.js"
import type { SseEvent } from "../src/api-server.js"
import type { TranscriptEvent } from "../src/transcript/types.js"

/**
 * HttpConnector is registered with the engine via `engine.use(connector)` and
 * fans engine events out to PWA clients via its internal StateBroadcaster.
 * These tests exercise only the `transcript_event` subscription — we stub
 * MinionEngine down to the surface `doAttach` touches, so they stay fast and
 * independent of the real engine wiring.
 */

function makeEngineStub(events: EngineEventBus): MinionEngine {
  return {
    events,
    getTopicSessions: () => new Map(),
    getSessions: () => new Map(),
    getDags: () => new Map(),
    getSessionState: () => undefined,
    apiSendReply: async () => {},
    apiStopSession: () => {},
    apiCloseSession: async () => {},
    handleIncomingText: async () => {},
    createSession: async () => ({ slug: "stub", threadId: 0 }),
    createSessionVariants: async () => [],
  } as unknown as MinionEngine
}

describe("HttpConnector — transcript_event fan-out", () => {
  const connectors: HttpConnector[] = []

  afterEach(() => {
    for (const c of connectors) c.detach()
    connectors.length = 0
  })

  async function attach(events: EngineEventBus): Promise<HttpConnector> {
    const connector = new HttpConnector({
      port: 0,
      uiDistPath: "/nonexistent",
    })
    connectors.push(connector)
    await connector.attach(makeEngineStub(events))
    return connector
  }

  it("broadcasts a transcript_event SseEvent when the engine emits one", async () => {
    const events = new EngineEventBus()
    const connector = await attach(events)

    const received: SseEvent[] = []
    connector.broadcaster.on("event", (e: SseEvent) => { received.push(e) })

    const inner: TranscriptEvent = {
      seq: 7,
      id: "evt_abc",
      sessionId: "happy-otter",
      turn: 2,
      timestamp: 1_700_000_000_000,
      type: "assistant_text",
      blockId: "b1",
      text: "hello",
      final: true,
    }
    await events.emit({ type: "transcript_event", sessionId: "happy-otter", event: inner })

    expect(received).toHaveLength(1)
    const sse = received[0]
    expect(sse?.type).toBe("transcript_event")
    if (sse?.type !== "transcript_event") throw new Error("unreachable")
    expect(sse.sessionId).toBe("happy-otter")
    expect(sse.event).toBe(inner)
    expect(sse.event.type).toBe("assistant_text")
    expect(sse.event.seq).toBe(7)
  })

  it("passes through every TranscriptEvent variant untouched", async () => {
    const events = new EngineEventBus()
    const connector = await attach(events)

    const received: SseEvent[] = []
    connector.broadcaster.on("event", (e: SseEvent) => { received.push(e) })

    const base = { sessionId: "s1", turn: 0, timestamp: 0 }
    const samples: TranscriptEvent[] = [
      { ...base, seq: 0, id: "e0", type: "turn_started", trigger: "user_message" },
      { ...base, seq: 1, id: "e1", type: "user_message", text: "hi" },
      { ...base, seq: 2, id: "e2", type: "thinking", blockId: "t", text: "...", final: true },
      {
        ...base,
        seq: 3,
        id: "e3",
        type: "tool_call",
        call: {
          toolUseId: "tu_1",
          name: "Bash",
          kind: "bash",
          title: "Running ls",
          input: { command: "ls" },
        },
      },
      {
        ...base,
        seq: 4,
        id: "e4",
        type: "tool_result",
        toolUseId: "tu_1",
        result: { status: "ok", text: "file.txt\n" },
      },
      {
        ...base,
        seq: 5,
        id: "e5",
        type: "status",
        severity: "warn",
        kind: "quota_sleep",
        message: "sleeping",
      },
      { ...base, seq: 6, id: "e6", type: "turn_completed", durationMs: 1234 },
    ]

    for (const evt of samples) {
      await events.emit({ type: "transcript_event", sessionId: "s1", event: evt })
    }

    expect(received).toHaveLength(samples.length)
    for (let i = 0; i < samples.length; i++) {
      const sse = received[i]
      if (sse?.type !== "transcript_event") throw new Error(`expected transcript_event at ${i}`)
      expect(sse.event).toBe(samples[i])
    }
  })

  it("stops fanning out after detach()", async () => {
    const events = new EngineEventBus()
    const connector = await attach(events)

    const received: SseEvent[] = []
    connector.broadcaster.on("event", (e: SseEvent) => { received.push(e) })

    connector.detach()

    const inner: TranscriptEvent = {
      seq: 0,
      id: "e0",
      sessionId: "s1",
      turn: 0,
      timestamp: 0,
      type: "assistant_text",
      blockId: "b",
      text: "after detach",
      final: true,
    }
    await events.emit({ type: "transcript_event", sessionId: "s1", event: inner })

    expect(received).toHaveLength(0)
  })
})
