import { describe, it, expect, vi, beforeEach } from "vitest"
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
  let bus: EventBus

  beforeEach(() => {
    bus = new EventBus()
  })

  it("delivers events to matching handlers", async () => {
    const handler = vi.fn()
    bus.on("session.spawned", handler)

    const event = makeSpawnedEvent()
    await bus.emit(event)

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(event)
  })

  it("does not deliver events to non-matching handlers", async () => {
    const handler = vi.fn()
    bus.on("ci.passed", handler)

    await bus.emit(makeSpawnedEvent())

    expect(handler).not.toHaveBeenCalled()
  })

  it("unsubscribes via the returned function", async () => {
    const handler = vi.fn()
    const unsub = bus.on("session.spawned", handler)

    unsub()
    await bus.emit(makeSpawnedEvent())

    expect(handler).not.toHaveBeenCalled()
    expect(bus.listenerCount).toBe(0)
  })

  it("once() fires handler exactly once then removes it", async () => {
    const handler = vi.fn()
    bus.once("session.spawned", handler)

    await bus.emit(makeSpawnedEvent())
    await bus.emit(makeSpawnedEvent())

    expect(handler).toHaveBeenCalledOnce()
    expect(bus.listenerCount).toBe(0)
  })

  it("once() can be unsubscribed before firing", async () => {
    const handler = vi.fn()
    const unsub = bus.once("session.spawned", handler)

    unsub()
    await bus.emit(makeSpawnedEvent())

    expect(handler).not.toHaveBeenCalled()
  })

  it("onAny() receives all event types", async () => {
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

  it("invokes handlers in registration order", async () => {
    const order: number[] = []
    bus.on("session.spawned", () => { order.push(1) })
    bus.onAny(() => { order.push(2) })
    bus.on("session.spawned", () => { order.push(3) })

    await bus.emit(makeSpawnedEvent())

    expect(order).toEqual([1, 2, 3])
  })

  it("continues executing remaining handlers when one throws", async () => {
    const after = vi.fn()
    bus.on("session.spawned", () => { throw new Error("boom") })
    bus.on("session.spawned", after)

    await bus.emit(makeSpawnedEvent())

    expect(after).toHaveBeenCalledOnce()
  })

  it("listenerCount reflects current handler count", () => {
    expect(bus.listenerCount).toBe(0)

    const unsub1 = bus.on("session.spawned", () => {})
    bus.on("ci.passed", () => {})
    expect(bus.listenerCount).toBe(2)

    unsub1()
    expect(bus.listenerCount).toBe(1)
  })

  it("listenerCountFor returns count for a specific type", () => {
    bus.on("session.spawned", () => {})
    bus.on("session.spawned", () => {})
    bus.on("ci.passed", () => {})
    bus.onAny(() => {})

    expect(bus.listenerCountFor("session.spawned")).toBe(2)
    expect(bus.listenerCountFor("ci.passed")).toBe(1)
    expect(bus.listenerCountFor("*")).toBe(1)
  })

  it("clear() removes all handlers", () => {
    bus.on("session.spawned", () => {})
    bus.onAny(() => {})
    expect(bus.listenerCount).toBe(2)

    bus.clear()
    expect(bus.listenerCount).toBe(0)
  })

  it("handles async handlers sequentially", async () => {
    const order: number[] = []
    bus.on("session.spawned", async () => {
      await new Promise((r) => setTimeout(r, 10))
      order.push(1)
    })
    bus.on("session.spawned", () => { order.push(2) })

    await bus.emit(makeSpawnedEvent())

    expect(order).toEqual([1, 2])
  })
})
