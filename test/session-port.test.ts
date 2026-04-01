import { describe, it, expect } from "vitest"
import type { SessionPort, SessionMeta, SessionState } from "../src/types.js"

/** Minimal stub implementing SessionPort for compile-time and runtime verification */
class StubSessionPort implements SessionPort {
  readonly meta: SessionMeta
  private state: SessionState = "spawning"
  private replies: Array<{ text: string; images?: string[] }> = []
  private completionResolve: ((result: "completed" | "errored") => void) | null = null
  private completionPromise: Promise<"completed" | "errored">

  constructor(meta: SessionMeta) {
    this.meta = meta
    this.completionPromise = new Promise((resolve) => {
      this.completionResolve = resolve
    })
  }

  start(): void {
    this.state = "working"
  }

  injectReply(text: string, images?: string[]): boolean {
    this.replies.push({ text, images })
    return true
  }

  waitForCompletion(): Promise<"completed" | "errored"> {
    return this.completionPromise
  }

  isClosed(): boolean {
    return this.state === "completed" || this.state === "errored"
  }

  getState(): SessionState {
    return this.state
  }

  isActive(): boolean {
    return this.state === "spawning" || this.state === "working"
  }

  interrupt(): void {
    this.state = "errored"
    this.completionResolve?.("errored")
  }

  async kill(): Promise<void> {
    this.state = "errored"
    this.completionResolve?.("errored")
  }

  // Test helpers
  complete(result: "completed" | "errored"): void {
    this.state = result
    this.completionResolve?.(result)
  }

  getReplies(): Array<{ text: string; images?: string[] }> {
    return this.replies
  }
}

function makeMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return {
    sessionId: "test-session-1",
    threadId: 100,
    topicName: "test-topic",
    repo: "org/repo",
    cwd: "/tmp/test",
    startedAt: Date.now(),
    mode: "task",
    ...overrides,
  }
}

describe("SessionPort interface", () => {
  it("stub satisfies the interface contract at compile time", () => {
    const port: SessionPort = new StubSessionPort(makeMeta())
    expect(port).toBeDefined()
  })

  it("exposes readonly meta", () => {
    const meta = makeMeta({ sessionId: "abc" })
    const port: SessionPort = new StubSessionPort(meta)
    expect(port.meta.sessionId).toBe("abc")
  })

  it("starts in spawning state, transitions to working on start()", () => {
    const port = new StubSessionPort(makeMeta())
    expect(port.getState()).toBe("spawning")
    expect(port.isActive()).toBe(true)
    expect(port.isClosed()).toBe(false)

    port.start("do something")
    expect(port.getState()).toBe("working")
    expect(port.isActive()).toBe(true)
    expect(port.isClosed()).toBe(false)
  })

  it("queues replies FIFO via injectReply()", () => {
    const port = new StubSessionPort(makeMeta())
    port.start("task")

    port.injectReply("first reply")
    port.injectReply("second reply", ["/tmp/img.png"])
    port.injectReply("third reply")

    const replies = port.getReplies()
    expect(replies).toHaveLength(3)
    expect(replies[0]).toEqual({ text: "first reply", images: undefined })
    expect(replies[1]).toEqual({ text: "second reply", images: ["/tmp/img.png"] })
    expect(replies[2]).toEqual({ text: "third reply", images: undefined })
  })

  it("waitForCompletion() resolves when session completes", async () => {
    const port = new StubSessionPort(makeMeta())
    port.start("task")

    const completionPromise = port.waitForCompletion()
    port.complete("completed")

    const result = await completionPromise
    expect(result).toBe("completed")
    expect(port.isClosed()).toBe(true)
    expect(port.isActive()).toBe(false)
  })

  it("waitForCompletion() resolves with errored on failure", async () => {
    const port = new StubSessionPort(makeMeta())
    port.start("task")

    const completionPromise = port.waitForCompletion()
    port.complete("errored")

    const result = await completionPromise
    expect(result).toBe("errored")
    expect(port.isClosed()).toBe(true)
  })

  it("interrupt() stops the session", () => {
    const port = new StubSessionPort(makeMeta())
    port.start("task")
    expect(port.isActive()).toBe(true)

    port.interrupt()
    expect(port.isActive()).toBe(false)
    expect(port.isClosed()).toBe(true)
  })

  it("kill() returns a promise that resolves", async () => {
    const port = new StubSessionPort(makeMeta())
    port.start("task")

    await port.kill()
    expect(port.isClosed()).toBe(true)
  })

  it("allows injectReply before start (queues for later)", () => {
    const port = new StubSessionPort(makeMeta())
    port.injectReply("early message")
    expect(port.getReplies()).toHaveLength(1)
  })
})
