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

describe("CORS headers", () => {
  let server: http.Server
  let broadcaster: StateBroadcaster

  beforeEach(() => {
    broadcaster = new StateBroadcaster()
  })

  afterEach(() => {
    server?.close()
  })

  it("allowed origin is echoed back with Vary: Origin", async () => {
    server = createApiServer(makeDispatcher(), {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
      corsAllowedOrigins: ["http://localhost:5173"],
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions`, {
      headers: { Origin: "http://localhost:5173" },
    })

    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173")
    expect(res.headers.get("vary")).toContain("Origin")
  })

  it("disallowed origin gets no Access-Control-Allow-Origin header", async () => {
    server = createApiServer(makeDispatcher(), {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
      corsAllowedOrigins: ["http://localhost:5173"],
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions`, {
      headers: { Origin: "http://evil.com" },
    })

    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("undefined corsAllowedOrigins returns *", async () => {
    server = createApiServer(makeDispatcher(), {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions`)

    expect(res.headers.get("access-control-allow-origin")).toBe("*")
  })

  it("Access-Control-Allow-Headers includes Authorization, Content-Type, Cache-Control, Last-Event-ID", async () => {
    server = createApiServer(makeDispatcher(), {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions`, { method: "OPTIONS" })
    const allowHeaders = res.headers.get("access-control-allow-headers") ?? ""

    expect(allowHeaders).toContain("Authorization")
    expect(allowHeaders).toContain("Content-Type")
    expect(allowHeaders).toContain("Cache-Control")
    expect(allowHeaders).toContain("Last-Event-ID")
  })

  it("Access-Control-Max-Age is 600", async () => {
    server = createApiServer(makeDispatcher(), {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions`, { method: "OPTIONS" })

    expect(res.headers.get("access-control-max-age")).toBe("600")
  })
})
