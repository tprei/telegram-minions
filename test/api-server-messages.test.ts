import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import http from "node:http"
import { createApiServer, StateBroadcaster, type DispatcherApi } from "../src/api-server.js"

async function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => resolve((server.address() as { port: number }).port))
  })
}

describe("POST /api/messages", () => {
  let server: http.Server
  let broadcaster: StateBroadcaster
  let handleIncomingText: ReturnType<typeof vi.fn>
  let dispatcher: DispatcherApi

  beforeEach(() => {
    broadcaster = new StateBroadcaster()
    handleIncomingText = vi.fn().mockResolvedValue(undefined)
    dispatcher = {
      getSessions: () => new Map(),
      getTopicSessions: () => new Map(),
      getDags: () => new Map(),
      getSessionState: () => undefined,
      sendReply: vi.fn().mockResolvedValue(undefined),
      stopSession: vi.fn(),
      closeSession: vi.fn().mockResolvedValue(undefined),
      handleIncomingText,
    }
  })

  afterEach(() => {
    server?.close()
  })

  it("calls dispatcher.handleIncomingText and returns ok", async () => {
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/task hi" }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ data: { ok: true, sessionId: null } })
    expect(handleIncomingText).toHaveBeenCalledWith("/task hi", undefined)
  })

  it("passes sessionId to dispatcher.handleIncomingText", async () => {
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello", sessionId: "bold-meadow" }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ data: { ok: true, sessionId: "bold-meadow" } })
    expect(handleIncomingText).toHaveBeenCalledWith("hello", "bold-meadow")
  })

  it("returns 400 for empty text", async () => {
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body).toEqual({ data: null, error: "text required" })
    expect(handleIncomingText).not.toHaveBeenCalled()
  })

  it("returns 400 for missing text field", async () => {
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body).toEqual({ data: null, error: "text required" })
  })
})
