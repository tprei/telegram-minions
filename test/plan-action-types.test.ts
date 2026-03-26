import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import http from "node:http"
import { createApiServer, StateBroadcaster, topicSessionToApi, type DispatcherApi, type PlanActionType, type ApiSession } from "../src/api-server.js"
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

describe("ApiSession mode and conversation fields", () => {
  it("includes mode from topic session", () => {
    const session = makeTopicSession({ mode: "plan" })
    const api = topicSessionToApi(session, "-1001234567890")
    expect(api.mode).toBe("plan")
  })

  it("includes mode 'think' for think sessions", () => {
    const session = makeTopicSession({ mode: "think" })
    const api = topicSessionToApi(session, "-1001234567890")
    expect(api.mode).toBe("think")
  })

  it("includes mode 'task' for task sessions", () => {
    const session = makeTopicSession({ mode: "task" })
    const api = topicSessionToApi(session, "-1001234567890")
    expect(api.mode).toBe("task")
  })

  it("includes conversation messages with role and text", () => {
    const session = makeTopicSession({
      conversation: [
        { role: "user", text: "/plan Design a new auth flow" },
        { role: "assistant", text: "Here is my proposal..." },
        { role: "user", text: "Looks good, refine step 2" },
      ],
    })
    const api = topicSessionToApi(session, "-1001234567890")

    expect(api.conversation).toHaveLength(3)
    expect(api.conversation[0]).toEqual({ role: "user", text: "/plan Design a new auth flow" })
    expect(api.conversation[1]).toEqual({ role: "assistant", text: "Here is my proposal..." })
    expect(api.conversation[2]).toEqual({ role: "user", text: "Looks good, refine step 2" })
  })

  it("returns empty conversation array when no messages", () => {
    const session = makeTopicSession({ conversation: [] })
    const api = topicSessionToApi(session, "-1001234567890")
    expect(api.conversation).toEqual([])
  })

  it("strips extra fields from conversation messages (only role and text)", () => {
    const session = makeTopicSession({
      conversation: [
        { role: "user", text: "hello", images: ["img1.png"] },
      ],
    })
    const api = topicSessionToApi(session, "-1001234567890")
    expect(api.conversation[0]).toEqual({ role: "user", text: "hello" })
    expect((api.conversation[0] as Record<string, unknown>).images).toBeUndefined()
  })
})

describe("PlanActionType", () => {
  it("accepts all valid plan action types", () => {
    const validActions: PlanActionType[] = ["execute", "split", "stack", "dag"]
    expect(validActions).toHaveLength(4)
  })
})

describe("POST /api/commands plan_action", () => {
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

  it("sends /execute reply for execute plan action", async () => {
    mockTopicSessions.set(100, makeTopicSession({ threadId: 100, slug: "plan-session" }))
    const port = await startServer()

    const response = await fetch(`http://localhost:${port}/api/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "plan_action", sessionId: "plan-session", planAction: "execute" }),
    })
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.success).toBe(true)
    expect(mockDispatcher.sendReply).toHaveBeenCalledWith(100, "/execute")
  })

  it("sends /split reply for split plan action", async () => {
    mockTopicSessions.set(100, makeTopicSession({ threadId: 100, slug: "plan-session" }))
    const port = await startServer()

    const response = await fetch(`http://localhost:${port}/api/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "plan_action", sessionId: "plan-session", planAction: "split" }),
    })
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.success).toBe(true)
    expect(mockDispatcher.sendReply).toHaveBeenCalledWith(100, "/split")
  })

  it("sends /stack reply for stack plan action", async () => {
    mockTopicSessions.set(100, makeTopicSession({ threadId: 100, slug: "plan-session" }))
    const port = await startServer()

    const response = await fetch(`http://localhost:${port}/api/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "plan_action", sessionId: "plan-session", planAction: "stack" }),
    })

    expect(response.status).toBe(200)
    expect(mockDispatcher.sendReply).toHaveBeenCalledWith(100, "/stack")
  })

  it("sends /dag reply for dag plan action", async () => {
    mockTopicSessions.set(100, makeTopicSession({ threadId: 100, slug: "plan-session" }))
    const port = await startServer()

    const response = await fetch(`http://localhost:${port}/api/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "plan_action", sessionId: "plan-session", planAction: "dag" }),
    })

    expect(response.status).toBe(200)
    expect(mockDispatcher.sendReply).toHaveBeenCalledWith(100, "/dag")
  })

  it("returns 404 for plan_action on unknown session", async () => {
    const port = await startServer()

    const response = await fetch(`http://localhost:${port}/api/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "plan_action", sessionId: "nonexistent", planAction: "execute" }),
    })

    expect(response.status).toBe(404)
  })

  it("returns mode and conversation in GET /api/sessions response", async () => {
    mockTopicSessions.set(200, makeTopicSession({
      threadId: 200,
      slug: "plan-with-convo",
      mode: "plan",
      conversation: [
        { role: "user", text: "/plan Build auth" },
        { role: "assistant", text: "Here is a plan..." },
      ],
    }))
    const port = await startServer()

    const response = await fetch(`http://localhost:${port}/api/sessions`)
    const data = await response.json()

    expect(data.data[0].mode).toBe("plan")
    expect(data.data[0].conversation).toHaveLength(2)
    expect(data.data[0].conversation[0].role).toBe("user")
    expect(data.data[0].conversation[1].role).toBe("assistant")
  })

  it("returns mode and conversation in GET /api/sessions/:id response", async () => {
    mockTopicSessions.set(300, makeTopicSession({
      threadId: 300,
      slug: "think-session",
      mode: "think",
      conversation: [
        { role: "user", text: "/think How should we approach this?" },
        { role: "assistant", text: "Let me think about this..." },
        { role: "user", text: "Good points, what about caching?" },
      ],
    }))
    const port = await startServer()

    const response = await fetch(`http://localhost:${port}/api/sessions/think-session`)
    const data = await response.json()

    expect(data.data.mode).toBe("think")
    expect(data.data.conversation).toHaveLength(3)
  })
})
