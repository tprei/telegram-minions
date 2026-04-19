import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import http from "node:http"
import {
  createApiServer,
  StateBroadcaster,
  topicSessionToApi,
  type DispatcherApi,
  type SseEvent,
} from "../src/api-server.js"
import type { TopicSession } from "../src/domain/session-types.js"
import type { TranscriptEvent, TranscriptSnapshot } from "../src/transcript/types.js"

async function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => resolve((server.address() as { port: number }).port))
  })
}

function makeTopicSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 1,
    repo: "org/repo",
    cwd: "/tmp",
    slug: "bold-meadow",
    conversation: [{ role: "user", text: "/task transcript check" }],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

function makeDispatcher(
  overrides: Partial<DispatcherApi> = {},
): DispatcherApi {
  return {
    getSessions: () => new Map(),
    getTopicSessions: () => new Map(),
    getDags: () => new Map(),
    getSessionState: () => undefined,
    sendReply: vi.fn().mockResolvedValue(undefined),
    stopSession: vi.fn(),
    closeSession: vi.fn().mockResolvedValue(undefined),
    handleIncomingText: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue({ slug: "unused", threadId: 0 }),
    createSessionVariants: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

function makeEvent(partial: Partial<TranscriptEvent> & Pick<TranscriptEvent, "seq" | "type">): TranscriptEvent {
  const base = {
    id: `e-${partial.seq}`,
    sessionId: "bold-meadow",
    turn: 0,
    timestamp: 1_700_000_000_000 + partial.seq,
  }
  if (partial.type === "assistant_text") {
    return {
      ...base,
      ...partial,
      blockId: "block-1",
      text: "hello",
      final: true,
    } as TranscriptEvent
  }
  if (partial.type === "user_message") {
    return {
      ...base,
      ...partial,
      text: "hi",
    } as TranscriptEvent
  }
  if (partial.type === "turn_started") {
    return { ...base, ...partial, trigger: "user_message" } as TranscriptEvent
  }
  if (partial.type === "turn_completed") {
    return { ...base, ...partial } as TranscriptEvent
  }
  throw new Error(`unsupported event type in fixture: ${partial.type}`)
}

describe("transcriptUrl on ApiSession", () => {
  it("populates transcriptUrl from the session slug", () => {
    const api = topicSessionToApi(makeTopicSession({ slug: "bold-meadow" }), "-100123")
    expect(api.transcriptUrl).toBe("/api/sessions/bold-meadow/transcript")
  })

  it("URL-encodes unusual slugs", () => {
    const api = topicSessionToApi(makeTopicSession({ slug: "foo_bar-baz" }), "-100123")
    expect(api.transcriptUrl).toBe("/api/sessions/foo_bar-baz/transcript")
  })
})

describe("GET /api/sessions/:slug/transcript", () => {
  let server: http.Server
  let broadcaster: StateBroadcaster

  beforeEach(() => {
    broadcaster = new StateBroadcaster()
  })

  afterEach(() => {
    server?.close()
  })

  it("returns 404 when the session does not exist", async () => {
    const dispatcher = makeDispatcher({
      getTranscript: vi.fn(),
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/missing/transcript`)
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error).toBe("Session not found")
    expect(dispatcher.getTranscript).not.toHaveBeenCalled()
  })

  it("returns 501 when the minion has no transcript store", async () => {
    const topicSessions = new Map<number, TopicSession>()
    topicSessions.set(1, makeTopicSession())
    const dispatcher = makeDispatcher({
      getTopicSessions: () => topicSessions,
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/bold-meadow/transcript`)
    const body = await res.json()

    expect(res.status).toBe(501)
    expect(body.error).toMatch(/transcript/i)
  })

  it("returns a full snapshot when no `after` query param is provided", async () => {
    const topicSessions = new Map<number, TopicSession>()
    topicSessions.set(1, makeTopicSession())
    const events = [
      makeEvent({ seq: 0, type: "turn_started" }),
      makeEvent({ seq: 1, type: "user_message" }),
      makeEvent({ seq: 2, type: "assistant_text" }),
    ]
    const snapshot: TranscriptSnapshot = {
      session: { sessionId: "bold-meadow", startedAt: 1_700_000_000_000 },
      events,
      highWaterMark: 2,
    }
    const getTranscript = vi.fn().mockReturnValue(snapshot)
    const dispatcher = makeDispatcher({
      getTopicSessions: () => topicSessions,
      getTranscript,
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/bold-meadow/transcript`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(getTranscript).toHaveBeenCalledWith("bold-meadow", -1)
    expect(body.data.highWaterMark).toBe(2)
    expect(body.data.events).toHaveLength(3)
    expect(body.data.events[0].type).toBe("turn_started")
  })

  it("forwards the `after` query param as an integer seq", async () => {
    const topicSessions = new Map<number, TopicSession>()
    topicSessions.set(1, makeTopicSession())
    const events = [makeEvent({ seq: 3, type: "assistant_text" })]
    const snapshot: TranscriptSnapshot = {
      session: { sessionId: "bold-meadow", startedAt: 1_700_000_000_000 },
      events,
      highWaterMark: 3,
    }
    const getTranscript = vi.fn().mockReturnValue(snapshot)
    const dispatcher = makeDispatcher({
      getTopicSessions: () => topicSessions,
      getTranscript,
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/bold-meadow/transcript?after=2`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(getTranscript).toHaveBeenCalledWith("bold-meadow", 2)
    expect(body.data.events).toHaveLength(1)
    expect(body.data.events[0].seq).toBe(3)
  })

  it("rejects non-integer `after` values", async () => {
    const topicSessions = new Map<number, TopicSession>()
    topicSessions.set(1, makeTopicSession())
    const getTranscript = vi.fn()
    const dispatcher = makeDispatcher({
      getTopicSessions: () => topicSessions,
      getTranscript,
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/bold-meadow/transcript?after=abc`)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/integer/i)
    expect(getTranscript).not.toHaveBeenCalled()
  })

  it("rejects `after` values below -1", async () => {
    const topicSessions = new Map<number, TopicSession>()
    topicSessions.set(1, makeTopicSession())
    const dispatcher = makeDispatcher({
      getTopicSessions: () => topicSessions,
      getTranscript: vi.fn(),
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/bold-meadow/transcript?after=-2`)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/integer/i)
  })

  it("returns 404 when getTranscript returns undefined (e.g. unknown session at store level)", async () => {
    const topicSessions = new Map<number, TopicSession>()
    topicSessions.set(1, makeTopicSession())
    const dispatcher = makeDispatcher({
      getTopicSessions: () => topicSessions,
      getTranscript: vi.fn().mockReturnValue(undefined),
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/bold-meadow/transcript`)
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error).toBe("Session not found")
  })
})

describe("GET /api/version transcript feature flag", () => {
  let server: http.Server
  let broadcaster: StateBroadcaster

  beforeEach(() => {
    broadcaster = new StateBroadcaster()
  })

  afterEach(() => {
    server?.close()
  })

  it("advertises transcript feature when the dispatcher provides getTranscript", async () => {
    const dispatcher = makeDispatcher({
      getTranscript: vi.fn().mockReturnValue(undefined),
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/version`)
    const body = await res.json()

    expect(body.data.features).toContain("transcript")
  })

  it("omits transcript feature when dispatcher does not expose getTranscript", async () => {
    const dispatcher = makeDispatcher()
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/version`)
    const body = await res.json()

    expect(body.data.features).not.toContain("transcript")
  })
})

describe("StateBroadcaster transcript_event fan-out", () => {
  it("emits transcript_event SseEvents to subscribers", () => {
    const broadcaster = new StateBroadcaster()
    const event: SseEvent = {
      type: "transcript_event",
      sessionId: "bold-meadow",
      event: {
        seq: 0,
        id: "e-0",
        sessionId: "bold-meadow",
        turn: 0,
        timestamp: 1_700_000_000_000,
        type: "assistant_text",
        blockId: "b0",
        text: "hi",
        final: true,
      },
    }
    const listener = vi.fn()
    broadcaster.on("event", listener)
    broadcaster.broadcast(event)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(event)
  })
})

describe("GET /api/sessions/:slug/transcript — additional coverage", () => {
  let server: http.Server
  let broadcaster: StateBroadcaster

  beforeEach(() => {
    broadcaster = new StateBroadcaster()
  })

  afterEach(() => {
    server?.close()
  })

  it("returns an empty snapshot when the session exists but has no events yet", async () => {
    const topicSessions = new Map<number, TopicSession>()
    topicSessions.set(1, makeTopicSession())
    const snapshot: TranscriptSnapshot = {
      session: { sessionId: "bold-meadow", startedAt: 1_700_000_000_000 },
      events: [],
      highWaterMark: -1,
    }
    const dispatcher = makeDispatcher({
      getTopicSessions: () => topicSessions,
      getTranscript: vi.fn().mockReturnValue(snapshot),
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/bold-meadow/transcript`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.events).toEqual([])
    expect(body.data.highWaterMark).toBe(-1)
    expect(body.data.session.sessionId).toBe("bold-meadow")
  })

  it("treats after=-1 the same as omitting the query param", async () => {
    const topicSessions = new Map<number, TopicSession>()
    topicSessions.set(1, makeTopicSession())
    const snapshot: TranscriptSnapshot = {
      session: { sessionId: "bold-meadow", startedAt: 1_700_000_000_000 },
      events: [makeEvent({ seq: 0, type: "turn_started" })],
      highWaterMark: 0,
    }
    const getTranscript = vi.fn().mockReturnValue(snapshot)
    const dispatcher = makeDispatcher({
      getTopicSessions: () => topicSessions,
      getTranscript,
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/bold-meadow/transcript?after=-1`)

    expect(res.status).toBe(200)
    expect(getTranscript).toHaveBeenCalledWith("bold-meadow", -1)
  })

  it("forwards session metadata (repo, mode, totals) from the snapshot", async () => {
    const topicSessions = new Map<number, TopicSession>()
    topicSessions.set(1, makeTopicSession())
    const snapshot: TranscriptSnapshot = {
      session: {
        sessionId: "bold-meadow",
        startedAt: 1_700_000_000_000,
        repo: "org/repo",
        mode: "task",
        totalTokens: 1234,
        totalCostUsd: 0.42,
        numTurns: 3,
        active: true,
      },
      events: [],
      highWaterMark: -1,
    }
    const dispatcher = makeDispatcher({
      getTopicSessions: () => topicSessions,
      getTranscript: vi.fn().mockReturnValue(snapshot),
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/bold-meadow/transcript`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.session).toMatchObject({
      sessionId: "bold-meadow",
      repo: "org/repo",
      mode: "task",
      totalTokens: 1234,
      totalCostUsd: 0.42,
      numTurns: 3,
      active: true,
    })
  })

  it("rejects floating-point `after` values", async () => {
    const topicSessions = new Map<number, TopicSession>()
    topicSessions.set(1, makeTopicSession())
    const getTranscript = vi.fn()
    const dispatcher = makeDispatcher({
      getTopicSessions: () => topicSessions,
      getTranscript,
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/bold-meadow/transcript?after=1.5`)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/integer/i)
    expect(getTranscript).not.toHaveBeenCalled()
  })

  it("matches session slugs exactly — lookalike slugs still 404", async () => {
    const topicSessions = new Map<number, TopicSession>()
    topicSessions.set(1, makeTopicSession({ slug: "bold-meadow" }))
    const dispatcher = makeDispatcher({
      getTopicSessions: () => topicSessions,
      getTranscript: vi.fn(),
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/bold-meadow-2/transcript`)
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error).toBe("Session not found")
    expect(dispatcher.getTranscript).not.toHaveBeenCalled()
  })

  it("returns 404 for unsupported HTTP methods on the transcript path", async () => {
    const topicSessions = new Map<number, TopicSession>()
    topicSessions.set(1, makeTopicSession())
    const dispatcher = makeDispatcher({
      getTopicSessions: () => topicSessions,
      getTranscript: vi.fn(),
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/bold-meadow/transcript`, {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    })

    expect(res.status).toBe(404)
    expect(dispatcher.getTranscript).not.toHaveBeenCalled()
  })
})

describe("SSE transcript_event delivery", () => {
  let server: http.Server
  let broadcaster: StateBroadcaster

  beforeEach(() => {
    broadcaster = new StateBroadcaster()
  })

  afterEach(() => {
    server?.close()
  })

  interface SseStream {
    next(predicate: (frame: string) => boolean, timeoutMs?: number): Promise<string>
    close: () => void
  }

  async function openSseStream(port: number): Promise<SseStream> {
    const controller = new AbortController()
    const res = await fetch(`http://localhost:${port}/api/events`, {
      signal: controller.signal,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream")
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const pending: string[] = []

    async function next(predicate: (frame: string) => boolean, timeoutMs = 2000): Promise<string> {
      const start = Date.now()
      while (true) {
        while (pending.length > 0) {
          const frame = pending.shift()!
          if (predicate(frame)) return frame
        }
        if (Date.now() - start >= timeoutMs) {
          throw new Error("timed out waiting for SSE event")
        }
        const { value, done } = await reader.read()
        if (done) throw new Error("SSE stream closed before event arrived")
        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split("\n\n")
        buffer = frames.pop() ?? ""
        for (const frame of frames) {
          if (frame.length > 0) pending.push(frame)
        }
      }
    }

    return {
      next,
      close: () => {
        controller.abort()
        reader.cancel().catch(() => undefined)
      },
    }
  }

  function parseDataPayload(frame: string): unknown {
    const dataLines = frame
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length))
    if (dataLines.length === 0) throw new Error(`no data lines in frame: ${frame}`)
    return JSON.parse(dataLines.join("\n"))
  }

  it("delivers a broadcast transcript_event to an SSE subscriber over the wire", async () => {
    const dispatcher = makeDispatcher({ getTranscript: vi.fn() })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const stream = await openSseStream(port)
    try {
      const event: SseEvent = {
        type: "transcript_event",
        sessionId: "bold-meadow",
        event: makeEvent({ seq: 7, type: "assistant_text" }),
      }
      // Broadcast after the subscriber is attached.
      broadcaster.broadcast(event)

      const frame = await stream.next((f) => f.includes("transcript_event"))
      const payload = parseDataPayload(frame) as SseEvent

      expect(payload.type).toBe("transcript_event")
      if (payload.type !== "transcript_event") throw new Error("unreachable")
      expect(payload.sessionId).toBe("bold-meadow")
      expect(payload.event.seq).toBe(7)
      expect(payload.event.type).toBe("assistant_text")
    } finally {
      stream.close()
    }
  })

  it("delivers multiple transcript_events in broadcast order", async () => {
    const dispatcher = makeDispatcher({ getTranscript: vi.fn() })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const stream = await openSseStream(port)
    try {
      const e0 = makeEvent({ seq: 0, type: "turn_started" })
      const e1 = makeEvent({ seq: 1, type: "user_message" })
      const e2 = makeEvent({ seq: 2, type: "assistant_text" })
      broadcaster.broadcast({ type: "transcript_event", sessionId: "bold-meadow", event: e0 })
      broadcaster.broadcast({ type: "transcript_event", sessionId: "bold-meadow", event: e1 })
      broadcaster.broadcast({ type: "transcript_event", sessionId: "bold-meadow", event: e2 })

      const seqs: number[] = []
      while (seqs.length < 3) {
        const frame = await stream.next((f) => f.includes("transcript_event"))
        const payload = parseDataPayload(frame) as SseEvent
        if (payload.type !== "transcript_event") throw new Error("unexpected event type")
        seqs.push(payload.event.seq)
      }

      expect(seqs).toEqual([0, 1, 2])
    } finally {
      stream.close()
    }
  })

  it("fans out transcript_events for every session to every subscriber (client-side filtering)", async () => {
    const dispatcher = makeDispatcher({ getTranscript: vi.fn() })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const stream = await openSseStream(port)
    try {
      broadcaster.broadcast({
        type: "transcript_event",
        sessionId: "other-session",
        event: { ...makeEvent({ seq: 0, type: "assistant_text" }), sessionId: "other-session" },
      })
      broadcaster.broadcast({
        type: "transcript_event",
        sessionId: "bold-meadow",
        event: makeEvent({ seq: 1, type: "assistant_text" }),
      })

      const sessionIds: string[] = []
      while (sessionIds.length < 2) {
        const frame = await stream.next((f) => f.includes("transcript_event"))
        const payload = parseDataPayload(frame) as SseEvent
        if (payload.type !== "transcript_event") throw new Error("unexpected event type")
        sessionIds.push(payload.sessionId)
      }

      expect(sessionIds).toEqual(["other-session", "bold-meadow"])
    } finally {
      stream.close()
    }
  })

  it("interleaves transcript_event and session_updated on the same SSE stream", async () => {
    const dispatcher = makeDispatcher({ getTranscript: vi.fn() })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const stream = await openSseStream(port)
    try {
      const apiSession = topicSessionToApi(makeTopicSession(), undefined)
      broadcaster.broadcast({ type: "session_updated", session: apiSession })
      broadcaster.broadcast({
        type: "transcript_event",
        sessionId: "bold-meadow",
        event: makeEvent({ seq: 0, type: "assistant_text" }),
      })

      const types: string[] = []
      while (types.length < 2) {
        const frame = await stream.next(
          (f) => f.includes("session_updated") || f.includes("transcript_event"),
        )
        const payload = parseDataPayload(frame) as SseEvent
        types.push(payload.type)
      }

      expect(types).toEqual(["session_updated", "transcript_event"])
    } finally {
      stream.close()
    }
  })
})
