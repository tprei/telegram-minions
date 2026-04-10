import { describe, it, expect, vi } from "vitest"
import { EventBus } from "../../src/events/event-bus.js"
import type { SessionSpawnedEvent, CiPassedEvent } from "../../src/events/domain-events.js"

function makeSpawnedEvent(overrides?: Partial<SessionSpawnedEvent>): SessionSpawnedEvent {
  return {
    type: "session.spawned",
    timestamp: Date.now(),
    sessionId: "s1",
    threadId: 1,
    slug: "test",
    repo: "org/repo",
    mode: "task",
    ...overrides,
  }
}

function makeCiPassedEvent(): CiPassedEvent {
  return { type: "ci.passed", timestamp: Date.now(), prUrl: "https://pr", threadId: 2 }
}

describe("EventBus", () => {
  it("delivers events to matching handlers", async () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.on("session.spawned", handler)

    const event = makeSpawnedEvent()
    await bus.emit(event)

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(event)
  })

  it("does not deliver events to non-matching handlers", async () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.on("ci.passed", handler)

    await bus.emit(makeSpawnedEvent())

    expect(handler).not.toHaveBeenCalled()
  })

  it("unsubscribes via returned function", async () => {
    const bus = new EventBus()
    const handler = vi.fn()
    const unsub = bus.on("session.spawned", handler)

    unsub()
    await bus.emit(makeSpawnedEvent())

    expect(handler).not.toHaveBeenCalled()
    expect(bus.listenerCount).toBe(0)
  })

  it("once handler fires exactly once then is removed", async () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.once("session.spawned", handler)

    await bus.emit(makeSpawnedEvent())
    await bus.emit(makeSpawnedEvent())

    expect(handler).toHaveBeenCalledOnce()
    expect(bus.listenerCount).toBe(0)
  })

  it("once handler can be unsubscribed before firing", async () => {
    const bus = new EventBus()
    const handler = vi.fn()
    const unsub = bus.once("session.spawned", handler)

    unsub()
    await bus.emit(makeSpawnedEvent())

    expect(handler).not.toHaveBeenCalled()
  })

  it("wildcard handler receives all event types", async () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.onAny(handler)

    const spawned = makeSpawnedEvent()
    const ciPassed = makeCiPassedEvent()
    await bus.emit(spawned)
    await bus.emit(ciPassed)

    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenCalledWith(spawned)
    expect(handler).toHaveBeenCalledWith(ciPassed)
  })

  it("handlers run in registration order", async () => {
    const bus = new EventBus()
    const order: number[] = []
    bus.on("session.spawned", () => { order.push(1) })
    bus.on("session.spawned", () => { order.push(2) })
    bus.onAny(() => { order.push(3) })

    await bus.emit(makeSpawnedEvent())

    expect(order).toEqual([1, 2, 3])
  })

  it("async handlers are awaited sequentially", async () => {
    const bus = new EventBus()
    const order: number[] = []
    bus.on("session.spawned", async () => {
      await new Promise((r) => setTimeout(r, 10))
      order.push(1)
    })
    bus.on("session.spawned", () => { order.push(2) })

    await bus.emit(makeSpawnedEvent())

    expect(order).toEqual([1, 2])
  })

  it("handler error does not block subsequent handlers", async () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.on("session.spawned", () => { throw new Error("boom") })
    bus.on("session.spawned", handler)

    await bus.emit(makeSpawnedEvent())

    expect(handler).toHaveBeenCalledOnce()
  })

  it("listenerCount and listenerCountFor track handlers", () => {
    const bus = new EventBus()
    bus.on("session.spawned", () => {})
    bus.on("session.spawned", () => {})
    bus.on("ci.passed", () => {})
    bus.onAny(() => {})

    expect(bus.listenerCount).toBe(4)
    expect(bus.listenerCountFor("session.spawned")).toBe(2)
    expect(bus.listenerCountFor("ci.passed")).toBe(1)
    expect(bus.listenerCountFor("*")).toBe(1)
  })

  it("clear removes all handlers", () => {
    const bus = new EventBus()
    bus.on("session.spawned", () => {})
    bus.onAny(() => {})

    bus.clear()

    expect(bus.listenerCount).toBe(0)
  })
})
