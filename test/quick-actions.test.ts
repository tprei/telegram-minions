import { describe, it, expect, vi } from "vitest"
import { computeQuickActions, type QuickAction } from "../src/api-server.js"
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

describe("computeQuickActions", () => {
  it("returns empty array for a normal running session", () => {
    const session = makeSession({ activeSessionId: "abc" })
    expect(computeQuickActions(session, "running")).toEqual([])
  })

  it("returns empty array for a completed session without a branch", () => {
    const session = makeSession()
    expect(computeQuickActions(session, "completed")).toEqual([])
  })

  it("returns 'make_pr' when completed with branch but no prUrl", () => {
    const session = makeSession({ branch: "minion/test-session" })
    const actions = computeQuickActions(session, "completed")
    expect(actions).toHaveLength(1)
    expect(actions[0].type).toBe("make_pr")
    expect(actions[0].label).toBe("Make a PR")
    expect(actions[0].message).toContain("pull request")
  })

  it("does not return 'make_pr' when prUrl already exists", () => {
    const session = makeSession({
      branch: "minion/test-session",
      prUrl: "https://github.com/org/repo/pull/1",
    })
    const actions = computeQuickActions(session, "completed")
    expect(actions.find((a) => a.type === "make_pr")).toBeUndefined()
  })

  it("does not return 'make_pr' for running sessions", () => {
    const session = makeSession({
      branch: "minion/test-session",
      activeSessionId: "abc",
    })
    const actions = computeQuickActions(session, "running")
    expect(actions.find((a) => a.type === "make_pr")).toBeUndefined()
  })

  it("returns 'retry' when session has failed", () => {
    const session = makeSession()
    const actions = computeQuickActions(session, "failed")
    expect(actions).toHaveLength(1)
    expect(actions[0].type).toBe("retry")
    expect(actions[0].label).toBe("Retry")
  })

  it("returns 'resume' when session is interrupted with no active process", () => {
    const session = makeSession({
      interruptedAt: Date.now() - 60000,
      activeSessionId: undefined,
    })
    const actions = computeQuickActions(session, "pending")
    expect(actions).toHaveLength(1)
    expect(actions[0].type).toBe("resume")
    expect(actions[0].label).toBe("Resume")
  })

  it("does not return 'resume' when session is still active", () => {
    const session = makeSession({
      interruptedAt: Date.now() - 60000,
      activeSessionId: "active-123",
    })
    const actions = computeQuickActions(session, "running")
    expect(actions.find((a) => a.type === "resume")).toBeUndefined()
  })

  it("returns multiple actions when applicable", () => {
    const session = makeSession({
      interruptedAt: Date.now() - 60000,
      activeSessionId: undefined,
    })
    const actions = computeQuickActions(session, "failed")
    const types = actions.map((a) => a.type)
    expect(types).toContain("retry")
    expect(types).toContain("resume")
  })
})

describe("quickActions in API response", () => {
  it("should include quickActions in session response", async () => {
    const { createApiServer, StateBroadcaster } = await import("../src/api-server.js")

    const broadcaster = new StateBroadcaster()
    const mockTopicSessions = new Map()
    mockTopicSessions.set(123, {
      threadId: 123,
      slug: "done-session",
      conversation: [{ role: "user", text: "/task fix bug" }],
      repo: "org/repo",
      pendingFeedback: [],
      lastActivityAt: Date.now(),
      mode: "task",
      branch: "minion/done-session",
    })

    const mockDispatcher = {
      getSessions: () => new Map(),
      getTopicSessions: () => mockTopicSessions,
      getDags: () => new Map(),
      getSessionState: () => "completed" as const,
      sendReply: vi.fn(),
      stopSession: vi.fn(),
      closeSession: vi.fn(),
    }

    const server = createApiServer(mockDispatcher as any, {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
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
      expect(data.data[0].quickActions).toHaveLength(1)
      expect(data.data[0].quickActions[0].type).toBe("make_pr")
    } finally {
      server.close()
    }
  })

  it("should return empty quickActions for healthy running session", async () => {
    const { createApiServer, StateBroadcaster } = await import("../src/api-server.js")

    const broadcaster = new StateBroadcaster()
    const mockTopicSessions = new Map()
    mockTopicSessions.set(456, {
      threadId: 456,
      slug: "running-session",
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
      expect(data.data[0].quickActions).toEqual([])
    } finally {
      server.close()
    }
  })
})
