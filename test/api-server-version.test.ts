import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import http from "node:http"
import { createApiServer, StateBroadcaster, type DispatcherApi } from "../src/api-server.js"
import pkg from "../package.json" with { type: "json" }

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

describe("GET /api/version", () => {
  let server: http.Server
  let broadcaster: StateBroadcaster

  beforeEach(() => {
    broadcaster = new StateBroadcaster()
  })

  afterEach(() => {
    server?.close()
  })

  it("returns apiVersion 1, libraryVersion from package.json, and expected features", async () => {
    server = createApiServer(makeDispatcher(), {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/version`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.apiVersion).toBe("1")
    expect(body.data.libraryVersion).toBe(pkg.version)
    expect(body.data.features).toContain("messages")
    expect(body.data.features).toContain("auth")
    expect(body.data.features).toContain("cors-allowlist")
  })
})
