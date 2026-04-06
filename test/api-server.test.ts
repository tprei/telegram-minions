import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import http from "node:http"
import crypto from "node:crypto"
import { createApiServer, StateBroadcaster, type DispatcherApi, validateTelegramInitData } from "../src/api-server.js"

describe("API Server", () => {
  let server: http.Server
  let broadcaster: StateBroadcaster
  let mockDispatcher: DispatcherApi

  const mockSessions = new Map<string, { handle: unknown; meta: { sessionId: string; threadId: string }; task: string }>()
  const mockTopicSessions = new Map<string, { threadId: string; slug: string; conversation: { role: string; text: string }[]; repo?: string; repoUrl?: string; startedAt?: number; lastActivityAt: number; mode: string }>()
  const mockDags = new Map<string, { id: string; nodes: { id: string; title: string; status: string; dependsOn: string[] }[]; parentThreadId: string; repo: string; createdAt: number }>()

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
        botToken: "test-bot-token-123456",
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
      mockTopicSessions.set("123", {
        threadId: "123",
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
        botToken: "test-bot-token-123456",
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

    it("should expose prUrl and branch fields from topic session", async () => {
      mockTopicSessions.set("456", {
        threadId: "456",
        slug: "swift-river",
        conversation: [{ role: "user", text: "/task Fix bug" }],
        repo: "org/repo",
        repoUrl: "https://github.com/org/repo",
        lastActivityAt: Date.now(),
        mode: "task",
        branch: "minion/swift-river",
        prUrl: "https://github.com/org/repo/pull/42",
      })

      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId: "-1001234567890",
        botToken: "test-bot-token-123456",
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
      expect(data.data[0].branch).toBe("minion/swift-river")
      expect(data.data[0].prUrl).toBe("https://github.com/org/repo/pull/42")
    })

    it("should return undefined prUrl and branch when not set", async () => {
      mockTopicSessions.set("789", {
        threadId: "789",
        slug: "quiet-pond",
        conversation: [{ role: "user", text: "/plan Design feature" }],
        lastActivityAt: Date.now(),
        mode: "plan",
      })

      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId: "-1001234567890",
        botToken: "test-bot-token-123456",
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
      expect(data.data[0].branch).toBeUndefined()
      expect(data.data[0].prUrl).toBeUndefined()
    })
  })

  describe("GET /api/sessions/:id", () => {
    it("should return 404 for unknown session", async () => {
      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId: "-1001234567890",
        botToken: "test-bot-token-123456",
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
      mockTopicSessions.set("123", {
        threadId: "123",
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
        botToken: "test-bot-token-123456",
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
        botToken: "test-bot-token-123456",
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
      mockTopicSessions.set("123", {
        threadId: "123",
        slug: "test-session",
        conversation: [],
        lastActivityAt: Date.now(),
        mode: "task",
      })

      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId: "-1001234567890",
        botToken: "test-bot-token-123456",
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
      expect(mockDispatcher.sendReply).toHaveBeenCalledWith("123", "Hello")
    })

    it("should handle stop command", async () => {
      mockTopicSessions.set("456", {
        threadId: "456",
        slug: "running-session",
        conversation: [],
        lastActivityAt: Date.now(),
        mode: "task",
      })

      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId: "-1001234567890",
        botToken: "test-bot-token-123456",
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
      expect(mockDispatcher.stopSession).toHaveBeenCalledWith("456")
    })

    it("should return 404 for unknown session", async () => {
      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId: "-1001234567890",
        botToken: "test-bot-token-123456",
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
        botToken: "test-bot-token-123456",
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

  describe("chatId in API responses", () => {
    it("should include parsed chatId in session response", async () => {
      mockTopicSessions.set("123", {
        threadId: "123",
        slug: "test-chatid",
        conversation: [{ role: "user", text: "/task test" }],
        lastActivityAt: Date.now(),
        mode: "task",
      })

      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId: "-1001234567890",
        botToken: "test-bot-token-123456",
        broadcaster,
      })

      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      const response = await fetch(`http://localhost:${address.port}/api/sessions`)
      const data = await response.json()

      expect(data.data[0].chatId).toBe("-1001234567890")
    })

    it("should include chatId in single session response", async () => {
      mockTopicSessions.set("456", {
        threadId: "456",
        slug: "single-chatid",
        conversation: [{ role: "user", text: "/task hello" }],
        lastActivityAt: Date.now(),
        mode: "task",
      })

      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId: "-1009876543210",
        botToken: "test-bot-token-123456",
        broadcaster,
      })

      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      const response = await fetch(`http://localhost:${address.port}/api/sessions/single-chatid`)
      const data = await response.json()

      expect(data.data.chatId).toBe("-1009876543210")
    })
  })

  describe("StateBroadcaster", () => {
    it("should emit events to listeners", () => {
      const listener = vi.fn()
      broadcaster.on("event", listener)

      broadcaster.broadcast({ type: "session_created", session: { id: "test", slug: "test", status: "pending", command: "", createdAt: "", updatedAt: "", childIds: [], needsAttention: false, attentionReasons: [], quickActions: [] } })

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
        botToken: "test-bot-token-123456",
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

  describe("POST /validate", () => {
    const botToken = "test-bot-token-123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
    const chatId = "-1001234567890"

    /**
     * Generate valid Telegram init data with proper HMAC signature
     */
    function generateValidInitData(
      user: { id: number; first_name: string; username?: string },
      authDate: number,
      chatIdOverride?: string,
    ): string {
      const params = new URLSearchParams()
      params.set("user", JSON.stringify(user))
      params.set("auth_date", authDate.toString())
      if (chatIdOverride !== undefined) {
        params.set("chat_id", chatIdOverride)
      }

      // Sort and create data-check string
      const keys = Array.from(params.keys()).sort()
      const dataCheckString = keys
        .map((key) => `${key}=${params.get(key)}`)
        .join("\n")

      // Create secret key: HMAC-SHA256(botToken, "WebAppData")
      const secretKey = crypto
        .createHmac("sha256", "WebAppData")
        .update(botToken)
        .digest()

      // Calculate signature: HMAC-SHA256(secretKey, dataCheckString)
      const hash = crypto
        .createHmac("sha256", secretKey)
        .update(dataCheckString)
        .digest("hex")

      params.set("hash", hash)
      return params.toString()
    }

    it("should return 405 for GET requests", async () => {
      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId,
        botToken,
        broadcaster,
      })

      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      const response = await fetch(`http://localhost:${address.port}/validate`)
      const data = await response.json()

      expect(response.status).toBe(405)
      expect(data.error).toBe("Method not allowed")
    })

    it("should return 400 for missing initData", async () => {
      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId,
        botToken,
        broadcaster,
      })

      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      const response = await fetch(`http://localhost:${address.port}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.valid).toBe(false)
      expect(data.error).toBe("Missing initData")
    })

    it("should return 403 for invalid HMAC signature", async () => {
      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId,
        botToken,
        broadcaster,
      })

      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      // Init data with invalid hash
      const initData = new URLSearchParams({
        user: JSON.stringify({ id: 123456, first_name: "Test", username: "testuser" }),
        auth_date: Math.floor(Date.now() / 1000).toString(),
        hash: "invalidhash123",
      }).toString()

      const response = await fetch(`http://localhost:${address.port}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData }),
      })
      const data = await response.json()

      expect(response.status).toBe(403)
      expect(data.valid).toBe(false)
      expect(data.error).toBe("Invalid signature")
    })

    it("should return 403 for missing hash", async () => {
      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId,
        botToken,
        broadcaster,
      })

      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      // Init data without hash
      const initData = new URLSearchParams({
        user: JSON.stringify({ id: 123456, first_name: "Test", username: "testuser" }),
        auth_date: Math.floor(Date.now() / 1000).toString(),
      }).toString()

      const response = await fetch(`http://localhost:${address.port}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData }),
      })
      const data = await response.json()

      expect(response.status).toBe(403)
      expect(data.valid).toBe(false)
      expect(data.error).toBe("Invalid signature")
    })

    it("should return 403 for unauthorized chat", async () => {
      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId,
        botToken,
        broadcaster,
      })

      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      const initData = generateValidInitData(
        { id: 123456, first_name: "Test", username: "testuser" },
        Math.floor(Date.now() / 1000),
        "-999999999999", // Different chat ID
      )

      const response = await fetch(`http://localhost:${address.port}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData }),
      })
      const data = await response.json()

      expect(response.status).toBe(403)
      expect(data.valid).toBe(false)
      expect(data.error).toBe("Unauthorized chat")
    })

    it("should return 403 for expired init data", async () => {
      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId,
        botToken,
        broadcaster,
      })

      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      // Auth date is 25 hours ago (beyond 24h limit)
      const expiredAuthDate = Math.floor((Date.now() - 25 * 60 * 60 * 1000) / 1000)
      const initData = generateValidInitData(
        { id: 123456, first_name: "Test", username: "testuser" },
        expiredAuthDate,
        chatId,
      )

      const response = await fetch(`http://localhost:${address.port}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData }),
      })
      const data = await response.json()

      expect(response.status).toBe(403)
      expect(data.valid).toBe(false)
      expect(data.error).toBe("Init data expired")
    })

    it("should return 200 for valid init data", async () => {
      server = createApiServer(mockDispatcher, {
        port: 0,
        uiDistPath: "/nonexistent",
        chatId,
        botToken,
        broadcaster,
      })

      const address = await new Promise<{ port: number }>((resolve) => {
        server.listen(0, () => {
          resolve(server.address() as { port: number })
        })
      })

      const initData = generateValidInitData(
        { id: 123456, first_name: "Test", username: "testuser" },
        Math.floor(Date.now() / 1000),
        chatId,
      )

      const response = await fetch(`http://localhost:${address.port}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData }),
      })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.valid).toBe(true)
      expect(data.user).toEqual({
        id: 123456,
        username: "testuser",
        firstName: "Test",
      })
    })
  })

  describe("validateTelegramInitData", () => {
    const botToken = "test-bot-token-123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"

    function generateInitData(params: Record<string, string>): string {
      const searchParams = new URLSearchParams()

      // Sort keys alphabetically for data-check string
      const sortedKeys = Object.keys(params).filter((k) => k !== "hash").sort()
      for (const key of sortedKeys) {
        searchParams.set(key, params[key])
      }

      // Create data-check string
      const dataCheckString = sortedKeys
        .map((key) => `${key}=${params[key]}`)
        .join("\n")

      // Create secret key and hash
      const secretKey = crypto
        .createHmac("sha256", "WebAppData")
        .update(botToken)
        .digest()

      const hash = crypto
        .createHmac("sha256", secretKey)
        .update(dataCheckString)
        .digest("hex")

      searchParams.set("hash", hash)
      return searchParams.toString()
    }

    it("should return false for missing hash", () => {
      const initData = new URLSearchParams({
        user: JSON.stringify({ id: 123 }),
        auth_date: "1234567890",
      }).toString()

      expect(validateTelegramInitData(initData, botToken)).toBe(false)
    })

    it("should return false for invalid hash", () => {
      const initData = new URLSearchParams({
        user: JSON.stringify({ id: 123 }),
        auth_date: "1234567890",
        hash: "invalidhash",
      }).toString()

      expect(validateTelegramInitData(initData, botToken)).toBe(false)
    })

    it("should return true for valid signature", () => {
      const initData = generateInitData({
        user: JSON.stringify({ id: 123456, first_name: "Test" }),
        auth_date: "1234567890",
      })

      expect(validateTelegramInitData(initData, botToken)).toBe(true)
    })

    it("should return false when signed with wrong token", () => {
      const initData = generateInitData({
        user: JSON.stringify({ id: 123456, first_name: "Test" }),
        auth_date: "1234567890",
      })

      expect(validateTelegramInitData(initData, "wrong-token")).toBe(false)
    })

    it("should handle special characters in values", () => {
      const initData = generateInitData({
        user: JSON.stringify({ id: 123456, first_name: "Test User & Co." }),
        auth_date: "1234567890",
        query_id: "AAHdF5e6r9kVFwAAoR9h7jI",
      })

      expect(validateTelegramInitData(initData, botToken)).toBe(true)
    })
  })
})
