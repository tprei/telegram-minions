import { describe, it, expect } from "vitest"
import { EngineEventBus, type EngineEvent } from "../src/engine/events.js"
import type { TopicSession } from "../src/domain/session-types.js"

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
})
