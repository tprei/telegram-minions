import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { SessionPort, SessionMeta, SessionState, TopicSession } from "../src/types.js"
import type { ActiveSession } from "../src/session/session-manager.js"
import { ReplyQueue } from "../src/reply-queue.js"
import { SDKSessionHandle } from "../src/session/sdk-session.js"

/** StubSessionPort that tracks injectReply calls */
class StubSessionPort implements SessionPort {
  readonly meta: SessionMeta
  private state: SessionState = "working"
  private replies: Array<{ text: string; images?: string[] }> = []

  constructor(meta: SessionMeta) {
    this.meta = meta
  }

  start(): void {
    this.state = "working"
  }

  injectReply(text: string, images?: string[]): boolean {
    this.replies.push({ text, images })
    return true
  }

  waitForCompletion(): Promise<"completed" | "errored"> {
    return new Promise(() => {})
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
  }

  async kill(): Promise<void> {
    this.state = "errored"
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
    mode: "plan",
    ...overrides,
  }
}

function makeTopicSession(cwd: string, overrides?: Partial<TopicSession>): TopicSession {
  return {
    threadId: 100,
    repo: "org/repo",
    cwd,
    slug: "test-slug",
    conversation: [],
    pendingFeedback: [],
    mode: "plan",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

describe("ReplyQueue integration with dispatcher feedback flow", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-reply-test-"))
  })

  it("persists reply to queue before injection for SDK sessions", async () => {
    const queue = new ReplyQueue(tmpDir)

    const queued = await queue.push("user feedback")
    expect(queued.delivered).toBe(false)

    const meta = makeMeta({ cwd: tmpDir })
    const handle = new StubSessionPort(meta)
    handle.injectReply(queued.text)
    await queue.markDelivered(queued.id)

    const pending = await queue.pending()
    expect(pending).toHaveLength(0)

    const all = await queue.list()
    expect(all).toHaveLength(1)
    expect(all[0].delivered).toBe(true)

    expect(handle.getReplies()).toEqual([{ text: "user feedback", images: undefined }])
  })

  it("queues reply to pendingFeedback for non-SDK sessions", async () => {
    const queue = new ReplyQueue(tmpDir)
    const topicSession = makeTopicSession(tmpDir, { activeSessionId: "active-1" })

    const queued = await queue.push("user feedback")
    topicSession.pendingFeedback.push(queued.text)

    expect(topicSession.pendingFeedback).toEqual(["user feedback"])

    const pending = await queue.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0].delivered).toBe(false)
  })

  it("recovers undelivered replies on startup", async () => {
    const queue = new ReplyQueue(tmpDir)
    await queue.push("reply 1")
    await queue.push("reply 2")
    const delivered = await queue.push("reply 3")
    await queue.markDelivered(delivered.id)

    const pending = await queue.pending()
    expect(pending).toHaveLength(2)

    const topicSession = makeTopicSession(tmpDir)
    for (const reply of pending) {
      topicSession.pendingFeedback.push(reply.text)
      await queue.markDelivered(reply.id)
    }

    expect(topicSession.pendingFeedback).toEqual(["reply 1", "reply 2"])

    const remainingPending = await queue.pending()
    expect(remainingPending).toHaveLength(0)
  })

  it("clears delivered replies after session completion", async () => {
    const queue = new ReplyQueue(tmpDir)
    const r1 = await queue.push("msg 1")
    const r2 = await queue.push("msg 2")
    await queue.markDelivered(r1.id)
    await queue.markDelivered(r2.id)

    const cleared = await queue.clearDelivered()
    expect(cleared).toBe(2)

    const all = await queue.list()
    expect(all).toHaveLength(0)
  })

  it("preserves undelivered replies across clear operations", async () => {
    const queue = new ReplyQueue(tmpDir)
    const r1 = await queue.push("delivered")
    await queue.push("pending")
    await queue.markDelivered(r1.id)

    await queue.clearDelivered()

    const all = await queue.list()
    expect(all).toHaveLength(1)
    expect(all[0].text).toBe("pending")
    expect(all[0].delivered).toBe(false)
  })

  it("handles multiple rapid replies maintaining FIFO order", async () => {
    const queue = new ReplyQueue(tmpDir)
    const handle = new StubSessionPort(makeMeta({ cwd: tmpDir }))

    const replies = ["first", "second", "third", "fourth", "fifth"]
    for (const text of replies) {
      const queued = await queue.push(text)
      handle.injectReply(text)
      await queue.markDelivered(queued.id)
    }

    const injected = handle.getReplies().map((r) => r.text)
    expect(injected).toEqual(replies)

    const pending = await queue.pending()
    expect(pending).toHaveLength(0)
  })

  it("handles reply with images", async () => {
    const queue = new ReplyQueue(tmpDir)
    const handle = new StubSessionPort(makeMeta({ cwd: tmpDir }))

    const imagePaths = ["/tmp/photo1.jpg", "/tmp/photo2.png"]
    const queued = await queue.push("check these images", imagePaths)
    handle.injectReply("check these images", imagePaths)
    await queue.markDelivered(queued.id)

    const all = await queue.list()
    expect(all[0].images).toEqual(imagePaths)
    expect(all[0].delivered).toBe(true)

    expect(handle.getReplies()[0]).toEqual({
      text: "check these images",
      images: imagePaths,
    })
  })
})

describe("ActiveSession handle type compatibility", () => {
  it("accepts StubSessionPort as handle in ActiveSession", () => {
    const meta = makeMeta()
    const handle = new StubSessionPort(meta)
    const session: ActiveSession = { handle, meta, task: "test task" }
    expect(session.handle.isActive()).toBe(true)
  })

  it("can call injectReply on ActiveSession handle", () => {
    const meta = makeMeta()
    const handle = new StubSessionPort(meta)
    const session: ActiveSession = { handle, meta, task: "test task" }
    session.handle.injectReply("hello")
    expect((handle as StubSessionPort).getReplies()).toHaveLength(1)
  })

  it("instanceof check distinguishes SDK from CLI handles", () => {
    const meta = makeMeta()
    const stubHandle = new StubSessionPort(meta)

    expect(stubHandle instanceof SDKSessionHandle).toBe(false)
  })
})

describe("SDK_MODES set", () => {
  const sdkModes = new Set(["plan", "think", "review", "ship-think", "ship-plan", "ship-verify"])
  const cliModes = ["task", "ci-fix", "dag-review"]

  it("includes all interactive Claude modes", () => {
    for (const mode of ["plan", "think", "review", "ship-think", "ship-plan", "ship-verify"]) {
      expect(sdkModes.has(mode)).toBe(true)
    }
  })

  it("excludes task and ci-fix modes", () => {
    for (const mode of cliModes) {
      expect(sdkModes.has(mode)).toBe(false)
    }
  })
})

describe("conversation tracking on reply injection", () => {
  it("pushes user message to conversation when SDK reply is injected", () => {
    const topicSession = makeTopicSession("/tmp/test")
    const feedback = "please also check the auth flow"

    topicSession.conversation.push({
      role: "user",
      text: feedback,
    })

    expect(topicSession.conversation).toHaveLength(1)
    expect(topicSession.conversation[0].role).toBe("user")
    expect(topicSession.conversation[0].text).toBe(feedback)
  })

  it("does not push to conversation when reply is only queued (non-SDK)", () => {
    const topicSession = makeTopicSession("/tmp/test", { activeSessionId: "active-1" })

    topicSession.pendingFeedback.push("queued feedback")

    expect(topicSession.conversation).toHaveLength(0)
    expect(topicSession.pendingFeedback).toEqual(["queued feedback"])
  })
})
