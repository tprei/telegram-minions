import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import http from "node:http"
import { createApiServer, StateBroadcaster, type DispatcherApi } from "../src/api-server.js"

function makeDispatcher(): DispatcherApi {
  return {
    getSessions: () => new Map(),
    getTopicSessions: () => new Map(),
    getDags: () => new Map(),
    getSessionState: () => undefined,
    sendReply: vi.fn().mockResolvedValue(undefined),
    stopSession: vi.fn(),
    closeSession: vi.fn().mockResolvedValue(undefined),
    handleIncomingText: vi.fn().mockResolvedValue(undefined),
  }
}

async function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => resolve((server.address() as { port: number }).port))
  })
}

describe("auth middleware", () => {
  let server: http.Server
  let broadcaster: StateBroadcaster

  beforeEach(() => {
    broadcaster = new StateBroadcaster()
  })

  afterEach(() => {
    server?.close()
  })

  it("GET /api/sessions without token returns 401", async () => {
    server = createApiServer(makeDispatcher(), {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
      apiToken: "secret",
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions`)
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body).toEqual({ data: null, error: "unauthorized" })
  })

  it("GET /api/sessions with correct Bearer token returns 200", async () => {
    server = createApiServer(makeDispatcher(), {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
      apiToken: "secret",
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions`, {
      headers: { Authorization: "Bearer secret" },
    })

    expect(res.status).toBe(200)
  })

  it("GET /api/events?token=secret returns 200 (SSE handshake)", async () => {
    server = createApiServer(makeDispatcher(), {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
      apiToken: "secret",
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/events?token=secret`)

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream")
  })

  it("GET /api/events?token=wrong returns 401", async () => {
    server = createApiServer(makeDispatcher(), {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
      apiToken: "secret",
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/events?token=wrong`)
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body).toEqual({ data: null, error: "unauthorized" })
  })

  it("OPTIONS /api/sessions never requires auth", async () => {
    server = createApiServer(makeDispatcher(), {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
      apiToken: "secret",
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions`, { method: "OPTIONS" })

    expect(res.status).toBe(204)
  })

  it("GET /api/version never requires auth", async () => {
    server = createApiServer(makeDispatcher(), {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
      apiToken: "secret",
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/version`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.apiVersion).toBe("1")
  })
})
