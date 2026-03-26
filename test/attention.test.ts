import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { computeAttentionReasons, type AttentionReason } from "../src/api-server.js"
import type { TopicSession } from "../src/types.js"

function makeSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 1,
    repo: "org/repo",
    cwd: "/tmp",
    slug: "test-session",
    conversation: [{ role: "user", text: "/task do stuff" }],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

describe("computeAttentionReasons", () => {
  it("returns empty array for a normal running session", () => {
    const session = makeSession({ activeSessionId: "abc" })
    expect(computeAttentionReasons(session, "running")).toEqual([])
  })

  it("returns empty array for a normal completed session", () => {
    const session = makeSession()
    expect(computeAttentionReasons(session, "completed")).toEqual([])
  })

  it("returns 'failed' when status is failed", () => {
    const session = makeSession()
    const reasons = computeAttentionReasons(session, "failed")
    expect(reasons).toContain("failed")
  })

  it("returns 'waiting_for_feedback' when pendingFeedback is non-empty", () => {
    const session = makeSession({ pendingFeedback: ["please clarify"] })
    const reasons = computeAttentionReasons(session, "running")
    expect(reasons).toContain("waiting_for_feedback")
  })

  it("returns 'interrupted' when interruptedAt is set and no active session", () => {
    const session = makeSession({
      interruptedAt: Date.now() - 60000,
      activeSessionId: undefined,
    })
    const reasons = computeAttentionReasons(session, "pending")
    expect(reasons).toContain("interrupted")
  })

  it("does not return 'interrupted' when session is still active", () => {
    const session = makeSession({
      interruptedAt: Date.now() - 60000,
      activeSessionId: "active-123",
    })
    const reasons = computeAttentionReasons(session, "running")
    expect(reasons).not.toContain("interrupted")
  })

  it("returns 'ci_fix' when mode is ci-fix", () => {
    const session = makeSession({ mode: "ci-fix" })
    const reasons = computeAttentionReasons(session, "running")
    expect(reasons).toContain("ci_fix")
  })

  it("returns 'idle_long' when session is pending and idle for over 30 minutes", () => {
    const session = makeSession({
      lastActivityAt: Date.now() - 31 * 60 * 1000,
      activeSessionId: undefined,
    })
    const reasons = computeAttentionReasons(session, "pending")
    expect(reasons).toContain("idle_long")
  })

  it("does not return 'idle_long' when session is pending but recently active", () => {
    const session = makeSession({
      lastActivityAt: Date.now() - 5 * 60 * 1000,
      activeSessionId: undefined,
    })
    const reasons = computeAttentionReasons(session, "pending")
    expect(reasons).not.toContain("idle_long")
  })

  it("does not return 'idle_long' for running sessions", () => {
    const session = makeSession({
      lastActivityAt: Date.now() - 60 * 60 * 1000,
      activeSessionId: "abc",
    })
    const reasons = computeAttentionReasons(session, "running")
    expect(reasons).not.toContain("idle_long")
  })

  it("returns multiple reasons when applicable", () => {
    const session = makeSession({
      pendingFeedback: ["help me"],
      mode: "ci-fix",
    })
    const reasons = computeAttentionReasons(session, "failed")
    expect(reasons).toContain("failed")
    expect(reasons).toContain("waiting_for_feedback")
    expect(reasons).toContain("ci_fix")
    expect(reasons).toHaveLength(3)
  })
})

describe("attention fields in API response", () => {
  it("should include needsAttention and attentionReasons in session response", async () => {
    const { createApiServer, StateBroadcaster } = await import("../src/api-server.js")

    const broadcaster = new StateBroadcaster()
    const mockTopicSessions = new Map()
    mockTopicSessions.set(123, {
      threadId: 123,
      slug: "failing-session",
      conversation: [{ role: "user", text: "/task fix bug" }],
      repo: "org/repo",
      pendingFeedback: ["need help"],
      lastActivityAt: Date.now(),
      mode: "task",
    })

    const mockDispatcher = {
      getSessions: () => new Map(),
      getTopicSessions: () => mockTopicSessions,
      getDags: () => new Map(),
      getSessionState: () => "errored" as const,
      sendReply: vi.fn(),
      stopSession: vi.fn(),
      closeSession: vi.fn(),
    }

    const server = createApiServer(mockDispatcher as any, {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token-123456",
      broadcaster,
    })

    try {
      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      const response = await fetch(`http://localhost:${address.port}/api/sessions`)
      const data = await response.json()

      expect(data.data).toHaveLength(1)
      expect(data.data[0].needsAttention).toBe(true)
      expect(data.data[0].attentionReasons).toContain("failed")
      expect(data.data[0].attentionReasons).toContain("waiting_for_feedback")
    } finally {
      server.close()
    }
  })

  it("should return needsAttention=false for healthy session", async () => {
    const { createApiServer, StateBroadcaster } = await import("../src/api-server.js")

    const broadcaster = new StateBroadcaster()
    const mockTopicSessions = new Map()
    mockTopicSessions.set(456, {
      threadId: 456,
      slug: "healthy-session",
      conversation: [{ role: "user", text: "/task add feature" }],
      repo: "org/repo",
      pendingFeedback: [],
      lastActivityAt: Date.now(),
      mode: "task",
      activeSessionId: "session-1",
    })

    const mockDispatcher = {
      getSessions: () => {
        const m = new Map()
        m.set(456, { handle: null, meta: { sessionId: "session-1", threadId: 456 }, task: "add feature" })
        return m
      },
      getTopicSessions: () => mockTopicSessions,
      getDags: () => new Map(),
      getSessionState: () => "working" as const,
      sendReply: vi.fn(),
      stopSession: vi.fn(),
      closeSession: vi.fn(),
    }

    const server = createApiServer(mockDispatcher as any, {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token-123456",
      broadcaster,
    })

    try {
      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      const response = await fetch(`http://localhost:${address.port}/api/sessions`)
      const data = await response.json()

      expect(data.data).toHaveLength(1)
      expect(data.data[0].needsAttention).toBe(false)
      expect(data.data[0].attentionReasons).toEqual([])
    } finally {
      server.close()
    }
  })
})
