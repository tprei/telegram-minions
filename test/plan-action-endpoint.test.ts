import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import http from "node:http"
import { createApiServer, StateBroadcaster, type DispatcherApi } from "../src/api-server.js"
import type { TopicSession } from "../src/types.js"

function makeTopicSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 1,
    repo: "org/repo",
    cwd: "/tmp",
    slug: "test-session",
    conversation: [{ role: "user", text: "/plan Design feature" }],
    pendingFeedback: [],
    mode: "plan",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

describe("POST /api/sessions/:id/action", () => {
  let server: http.Server
  let broadcaster: StateBroadcaster
  let mockDispatcher: DispatcherApi
  const mockSessions = new Map<number, { handle: unknown; meta: { sessionId: string; threadId: number }; task: string }>()
  const mockTopicSessions = new Map<number, TopicSession>()
  const mockDags = new Map()

  async function startServer(): Promise<number> {
    server = createApiServer(mockDispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      broadcaster,
    })
    const address = await new Promise<{ port: number }>((resolve) => {
      server.listen(0, () => resolve(server.address() as { port: number }))
    })
    return address.port
  }

  beforeEach(() => {
    broadcaster = new StateBroadcaster()
    mockDispatcher = {
      getSessions: () => mockSessions,
      getTopicSessions: () => mockTopicSessions,
      getDags: () => mockDags,
      getSessionState: () => undefined,
      sendReply: vi.fn().mockResolvedValue(undefined),
      stopSession: vi.fn(),
      closeSession: vi.fn().mockResolvedValue(undefined),
    }
    mockSessions.clear()
    mockTopicSessions.clear()
    mockDags.clear()
  })

  afterEach(() => {
    if (server) server.close()
  })

  it("sends /execute for execute action on plan session", async () => {
    mockTopicSessions.set(100, makeTopicSession({ threadId: 100, slug: "plan-session", mode: "plan" }))
    const port = await startServer()

    const response = await fetch(`http://localhost:${port}/api/sessions/plan-session/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "execute" }),
    })
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.success).toBe(true)
    expect(mockDispatcher.sendReply).toHaveBeenCalledWith(100, "/execute")
  })

  it("sends /split for split action on think session", async () => {
    mockTopicSessions.set(200, makeTopicSession({ threadId: 200, slug: "think-session", mode: "think" }))
    const port = await startServer()

    const response = await fetch(`http://localhost:${port}/api/sessions/think-session/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "split" }),
    })
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.success).toBe(true)
    expect(mockDispatcher.sendReply).toHaveBeenCalledWith(200, "/split")
  })

  it("sends /stack for stack action", async () => {
    mockTopicSessions.set(100, makeTopicSession({ threadId: 100, slug: "plan-session" }))
    const port = await startServer()

    const response = await fetch(`http://localhost:${port}/api/sessions/plan-session/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stack" }),
    })

    expect(response.status).toBe(200)
    expect(mockDispatcher.sendReply).toHaveBeenCalledWith(100, "/stack")
  })

  it("sends /dag for dag action", async () => {
    mockTopicSessions.set(100, makeTopicSession({ threadId: 100, slug: "plan-session" }))
    const port = await startServer()

    const response = await fetch(`http://localhost:${port}/api/sessions/plan-session/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dag" }),
    })

    expect(response.status).toBe(200)
    expect(mockDispatcher.sendReply).toHaveBeenCalledWith(100, "/dag")
  })

  it("returns 404 for unknown session", async () => {
    const port = await startServer()

    const response = await fetch(`http://localhost:${port}/api/sessions/nonexistent/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "execute" }),
    })
    const data = await response.json()

    expect(response.status).toBe(404)
    expect(data.success).toBe(false)
    expect(data.error).toBe("Session not found")
  })

  it("returns 400 for invalid action", async () => {
    mockTopicSessions.set(100, makeTopicSession({ threadId: 100, slug: "plan-session" }))
    const port = await startServer()

    const response = await fetch(`http://localhost:${port}/api/sessions/plan-session/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "invalid" }),
    })
    const data = await response.json()

    expect(response.status).toBe(400)
    expect(data.success).toBe(false)
    expect(data.error).toContain("Invalid action")
  })

  it("returns 400 for missing action", async () => {
    mockTopicSessions.set(100, makeTopicSession({ threadId: 100, slug: "plan-session" }))
    const port = await startServer()

    const response = await fetch(`http://localhost:${port}/api/sessions/plan-session/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    const data = await response.json()

    expect(response.status).toBe(400)
    expect(data.success).toBe(false)
  })

  it("returns 400 for task mode session", async () => {
    mockTopicSessions.set(100, makeTopicSession({ threadId: 100, slug: "task-session", mode: "task" }))
    const port = await startServer()

    const response = await fetch(`http://localhost:${port}/api/sessions/task-session/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "execute" }),
    })
    const data = await response.json()

    expect(response.status).toBe(400)
    expect(data.success).toBe(false)
    expect(data.error).toContain("does not support plan actions")
  })

  it("returns 400 for review mode session", async () => {
    mockTopicSessions.set(100, makeTopicSession({ threadId: 100, slug: "review-session", mode: "review" }))
    const port = await startServer()

    const response = await fetch(`http://localhost:${port}/api/sessions/review-session/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "split" }),
    })
    const data = await response.json()

    expect(response.status).toBe(400)
    expect(data.success).toBe(false)
    expect(data.error).toContain("does not support plan actions")
  })

  it("looks up session by thread ID string", async () => {
    mockTopicSessions.set(500, makeTopicSession({ threadId: 500, slug: "some-slug", mode: "plan" }))
    const port = await startServer()

    const response = await fetch(`http://localhost:${port}/api/sessions/500/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "execute" }),
    })

    expect(response.status).toBe(200)
    expect(mockDispatcher.sendReply).toHaveBeenCalledWith(500, "/execute")
  })

  it("returns 500 when dispatcher.sendReply throws", async () => {
    mockTopicSessions.set(100, makeTopicSession({ threadId: 100, slug: "plan-session" }))
    ;(mockDispatcher.sendReply as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Send failed"))
    const port = await startServer()

    const response = await fetch(`http://localhost:${port}/api/sessions/plan-session/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "execute" }),
    })
    const data = await response.json()

    expect(response.status).toBe(500)
    expect(data.success).toBe(false)
    expect(data.error).toContain("Send failed")
  })
})
