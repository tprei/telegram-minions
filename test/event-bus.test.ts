import { describe, it, expect, vi, beforeEach } from "vitest"
import { EventBus } from "../src/events/event-bus.js"
import type { SessionCompletedEvent, DagNodeReadyEvent, AnyDomainEvent } from "../src/events/domain-events.js"

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}))

function makeSessionCompleted(overrides: Partial<SessionCompletedEvent> = {}): SessionCompletedEvent {
  return {
    type: "session.completed",
    timestamp: Date.now(),
    meta: {
      sessionId: "s-1",
      threadId: 100,
      topicName: "test",
      repo: "org/repo",
      cwd: "/tmp/repo",
      startedAt: Date.now(),
      mode: "task",
    },
    state: "completed",
    ...overrides,
  }
}

function makeDagNodeReady(overrides: Partial<DagNodeReadyEvent> = {}): DagNodeReadyEvent {
  return {
    type: "dag.node_ready",
    timestamp: Date.now(),
    dagId: "dag-1",
    nodeId: "node-1",
    title: "Refactor auth",
    ...overrides,
  }
}

describe("EventBus", () => {
  let bus: EventBus

  beforeEach(() => {
    bus = new EventBus()
  })

  describe("on() and emit()", () => {
    it("delivers events to matching handlers", async () => {
      const handler = vi.fn()
      bus.on("session.completed", handler)

      const event = makeSessionCompleted()
      await bus.emit(event)

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith(event)
    })

    it("does not deliver events to non-matching handlers", async () => {
      const handler = vi.fn()
      bus.on("dag.node_ready", handler)

      await bus.emit(makeSessionCompleted())

      expect(handler).not.toHaveBeenCalled()
    })

    it("supports multiple handlers for the same event type", async () => {
      const h1 = vi.fn()
      const h2 = vi.fn()
      bus.on("session.completed", h1)
      bus.on("session.completed", h2)

      await bus.emit(makeSessionCompleted())

      expect(h1).toHaveBeenCalledOnce()
      expect(h2).toHaveBeenCalledOnce()
    })

    it("invokes handlers in registration order", async () => {
      const order: number[] = []
      bus.on("session.completed", () => { order.push(1) })
      bus.on("session.completed", () => { order.push(2) })
      bus.on("session.completed", () => { order.push(3) })

      await bus.emit(makeSessionCompleted())

      expect(order).toEqual([1, 2, 3])
    })

    it("awaits async handlers sequentially", async () => {
      const order: number[] = []
      bus.on("session.completed", async () => {
        await new Promise((r) => setTimeout(r, 10))
        order.push(1)
      })
      bus.on("session.completed", () => {
        order.push(2)
      })

      await bus.emit(makeSessionCompleted())

      expect(order).toEqual([1, 2])
    })
  })

  describe("once()", () => {
    it("fires the handler only once", async () => {
      const handler = vi.fn()
      bus.once("session.completed", handler)

      await bus.emit(makeSessionCompleted())
      await bus.emit(makeSessionCompleted())

      expect(handler).toHaveBeenCalledOnce()
    })

    it("removes the handler after first invocation", async () => {
      const handler = vi.fn()
      bus.once("session.completed", handler)

      expect(bus.listenerCount).toBe(1)
      await bus.emit(makeSessionCompleted())
      expect(bus.listenerCount).toBe(0)
    })
  })

  describe("onAny() wildcard", () => {
    it("receives all event types", async () => {
      const handler = vi.fn()
      bus.onAny(handler)

      const e1 = makeSessionCompleted()
      const e2 = makeDagNodeReady()
      await bus.emit(e1)
      await bus.emit(e2)

      expect(handler).toHaveBeenCalledTimes(2)
      expect(handler).toHaveBeenCalledWith(e1)
      expect(handler).toHaveBeenCalledWith(e2)
    })

    it("runs in registration order alongside type-specific handlers", async () => {
      const order: string[] = []
      bus.onAny(() => { order.push("wildcard") })
      bus.on("session.completed", () => { order.push("specific") })

      await bus.emit(makeSessionCompleted())

      expect(order).toEqual(["wildcard", "specific"])
    })
  })

  describe("unsubscribe", () => {
    it("on() returns an unsubscribe function", async () => {
      const handler = vi.fn()
      const unsub = bus.on("session.completed", handler)

      unsub()
      await bus.emit(makeSessionCompleted())

      expect(handler).not.toHaveBeenCalled()
    })

    it("once() returns an unsubscribe function that works before emit", async () => {
      const handler = vi.fn()
      const unsub = bus.once("session.completed", handler)

      unsub()
      await bus.emit(makeSessionCompleted())

      expect(handler).not.toHaveBeenCalled()
    })

    it("unsubscribing twice is safe", () => {
      const unsub = bus.on("session.completed", vi.fn())
      unsub()
      expect(() => unsub()).not.toThrow()
    })
  })

  describe("error isolation", () => {
    it("continues dispatching when a handler throws", async () => {
      const h1 = vi.fn(() => { throw new Error("boom") })
      const h2 = vi.fn()
      bus.on("session.completed", h1)
      bus.on("session.completed", h2)

      await bus.emit(makeSessionCompleted())

      expect(h1).toHaveBeenCalledOnce()
      expect(h2).toHaveBeenCalledOnce()
    })

    it("continues dispatching when an async handler rejects", async () => {
      const h1 = vi.fn(async () => { throw new Error("async boom") })
      const h2 = vi.fn()
      bus.on("session.completed", h1)
      bus.on("session.completed", h2)

      await bus.emit(makeSessionCompleted())

      expect(h1).toHaveBeenCalledOnce()
      expect(h2).toHaveBeenCalledOnce()
    })
  })

  describe("clear()", () => {
    it("removes all handlers", async () => {
      bus.on("session.completed", vi.fn())
      bus.on("dag.node_ready", vi.fn())
      bus.onAny(vi.fn())

      expect(bus.listenerCount).toBe(3)
      bus.clear()
      expect(bus.listenerCount).toBe(0)
    })
  })

  describe("listenerCount", () => {
    it("tracks total handler count", () => {
      expect(bus.listenerCount).toBe(0)
      bus.on("session.completed", vi.fn())
      expect(bus.listenerCount).toBe(1)
      const unsub = bus.on("dag.node_ready", vi.fn())
      expect(bus.listenerCount).toBe(2)
      unsub()
      expect(bus.listenerCount).toBe(1)
    })

    it("listenerCountFor returns count for a specific type", () => {
      bus.on("session.completed", vi.fn())
      bus.on("session.completed", vi.fn())
      bus.on("dag.node_ready", vi.fn())

      expect(bus.listenerCountFor("session.completed")).toBe(2)
      expect(bus.listenerCountFor("dag.node_ready")).toBe(1)
      expect(bus.listenerCountFor("ci.passed")).toBe(0)
    })
  })

  describe("type safety", () => {
    it("preserves event payload types in handlers", async () => {
      const captured: { prUrl?: string; branch?: string } = {}

      bus.on("session.completed", (event) => {
        captured.prUrl = event.prUrl
        captured.branch = event.branch
      })

      await bus.emit(makeSessionCompleted({ prUrl: "https://github.com/org/repo/pull/1", branch: "feat/auth" }))

      expect(captured.prUrl).toBe("https://github.com/org/repo/pull/1")
      expect(captured.branch).toBe("feat/auth")
    })

    it("different event types carry different payloads", async () => {
      const dagPayloads: string[] = []

      bus.on("dag.node_ready", (event) => {
        dagPayloads.push(event.nodeId)
      })

      await bus.emit(makeDagNodeReady({ nodeId: "n-42" }))

      expect(dagPayloads).toEqual(["n-42"])
    })
  })

  describe("emit with no handlers", () => {
    it("does not throw when no handlers are registered", async () => {
      await expect(bus.emit(makeSessionCompleted())).resolves.toBeUndefined()
    })
  })

  describe("handler registration during emit", () => {
    it("does not invoke handlers added during dispatch of the same event", async () => {
      const lateHandler = vi.fn()
      bus.on("session.completed", () => {
        bus.on("session.completed", lateHandler)
      })

      await bus.emit(makeSessionCompleted())

      expect(lateHandler).not.toHaveBeenCalled()
      expect(bus.listenerCount).toBe(2)
    })
  })

  describe("handler removal during emit", () => {
    it("handles unsubscription of a later handler during dispatch", async () => {
      const h2 = vi.fn()
      let unsub2: () => void
      bus.on("session.completed", () => {
        unsub2()
      })
      unsub2 = bus.on("session.completed", h2)

      await bus.emit(makeSessionCompleted())

      // h2 still runs because we snapshot handlers at emit start
      expect(h2).toHaveBeenCalledOnce()
    })
  })
})
