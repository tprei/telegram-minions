import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import http from "node:http"
import { createApiServer, StateBroadcaster, type DispatcherApi } from "../src/api-server.js"

describe("API Server", () => {
  let server: http.Server
  let broadcaster: StateBroadcaster
  let mockDispatcher: DispatcherApi

  const mockSessions = new Map<number, { handle: unknown; meta: { sessionId: string; threadId: number }; task: string }>()
  const mockTopicSessions = new Map<number, { threadId: number; slug: string; conversation: { role: string; text: string }[]; repo?: string; repoUrl?: string; startedAt?: number; lastActivityAt: number; mode: string }>()
  const mockDags = new Map<string, { id: string; nodes: { id: string; title: string; status: string; dependsOn: string[] }[]; parentThreadId: number; repo: string; createdAt: number }>()

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

    // Clear mocks
    mockSessions.clear()
    mockTopicSessions.clear()
    mockDags.clear()
  })

  afterEach(() => {
    if (server) {
      server.close()
    }
  })

  describe("GET /api/sessions", () => {
    it("should return empty array when no sessions", async () => {
      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId: "-1001234567890",
        broadcaster,
      })

      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      const response = await fetch(`http://localhost:${address.port}/api/sessions`)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data).toEqual({ data: [] })
    })

    it("should return sessions from dispatcher", async () => {
      mockTopicSessions.set(123, {
        threadId: 123,
        slug: "bold-meadow",
        conversation: [{ role: "user", text: "/task Add feature" }],
        repo: "org/repo",
        repoUrl: "https://github.com/org/repo",
        startedAt: Date.now() - 3600000,
        lastActivityAt: Date.now(),
        mode: "task",
      })

      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId: "-1001234567890",
        broadcaster,
      })

      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      const response = await fetch(`http://localhost:${address.port}/api/sessions`)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.data).toHaveLength(1)
      expect(data.data[0].slug).toBe("bold-meadow")
      expect(data.data[0].command).toBe("/task Add feature")
    })
  })

  describe("GET /api/sessions/:id", () => {
    it("should return 404 for unknown session", async () => {
      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId: "-1001234567890",
        broadcaster,
      })

      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      const response = await fetch(`http://localhost:${address.port}/api/sessions/unknown-slug`)
      const data = await response.json()

      expect(response.status).toBe(404)
      expect(data.error).toBe("Session not found")
    })

    it("should return session by slug", async () => {
      mockTopicSessions.set(123, {
        threadId: 123,
        slug: "calm-lake",
        conversation: [{ role: "user", text: "/plan Feature design" }],
        repo: "org/repo",
        lastActivityAt: Date.now(),
        mode: "plan",
      })

      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId: "-1001234567890",
        broadcaster,
      })

      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      const response = await fetch(`http://localhost:${address.port}/api/sessions/calm-lake`)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.data.slug).toBe("calm-lake")
    })
  })

  describe("GET /api/dags", () => {
    it("should return empty array when no DAGs", async () => {
      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId: "-1001234567890",
        broadcaster,
      })

      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      const response = await fetch(`http://localhost:${address.port}/api/dags`)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data).toEqual({ data: [] })
    })
  })

  describe("POST /api/commands", () => {
    it("should handle reply command", async () => {
      mockTopicSessions.set(123, {
        threadId: 123,
        slug: "test-session",
        conversation: [],
        lastActivityAt: Date.now(),
        mode: "task",
      })

      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId: "-1001234567890",
        broadcaster,
      })

      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      const response = await fetch(`http://localhost:${address.port}/api/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reply", sessionId: "test-session", message: "Hello" }),
      })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.success).toBe(true)
      expect(mockDispatcher.sendReply).toHaveBeenCalledWith(123, "Hello")
    })

    it("should handle stop command", async () => {
      mockTopicSessions.set(456, {
        threadId: 456,
        slug: "running-session",
        conversation: [],
        lastActivityAt: Date.now(),
        mode: "task",
      })

      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId: "-1001234567890",
        broadcaster,
      })

      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      const response = await fetch(`http://localhost:${address.port}/api/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", sessionId: "running-session" }),
      })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.success).toBe(true)
      expect(mockDispatcher.stopSession).toHaveBeenCalledWith(456)
    })

    it("should return 404 for unknown session", async () => {
      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId: "-1001234567890",
        broadcaster,
      })

      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      const response = await fetch(`http://localhost:${address.port}/api/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", sessionId: "unknown" }),
      })
      const data = await response.json()

      expect(response.status).toBe(404)
      expect(data.success).toBe(false)
      expect(data.error).toBe("Session not found")
    })
  })

  describe("GET /api/events (SSE)", () => {
    it("should establish SSE connection", async () => {
      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId: "-1001234567890",
        broadcaster,
      })

      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      const response = await fetch(`http://localhost:${address.port}/api/events`)

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("text/event-stream")
    })
  })

  describe("StateBroadcaster", () => {
    it("should emit events to listeners", () => {
      const listener = vi.fn()
      broadcaster.on("event", listener)

      broadcaster.broadcast({ type: "session_created", session: { id: "test", slug: "test", status: "pending", command: "", createdAt: "", updatedAt: "", childIds: [] } })

      expect(listener).toHaveBeenCalledTimes(1)
    })

    it("should handle multiple listeners", () => {
      const listener1 = vi.fn()
      const listener2 = vi.fn()
      broadcaster.on("event", listener1)
      broadcaster.on("event", listener2)

      broadcaster.broadcast({ type: "dag_created", dag: { id: "dag-1", rootTaskId: "1", nodes: {}, status: "pending", createdAt: "", updatedAt: "" } })

      expect(listener1).toHaveBeenCalledTimes(1)
      expect(listener2).toHaveBeenCalledTimes(1)
    })
  })

  describe("OPTIONS requests (CORS)", () => {
    it("should handle OPTIONS preflight", async () => {
      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId: "-1001234567890",
        broadcaster,
      })

      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      const response = await fetch(`http://localhost:${address.port}/api/sessions`, {
        method: "OPTIONS",
      })

      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-origin")).toBe("*")
    })
  })
})
