import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import {
  parseAdvocateOutput,
  parseJudgeDecision,
  JudgeOrchestrator,
} from "../src/judge/judge-orchestrator.js"
import type { TopicSession, TopicMessage } from "../src/domain/session-types.js"
import type { ChildProcess } from "node:child_process"
import type { EngineContext } from "../src/engine/engine-context.js"
import { makeMockActiveSession, makeMockSessionPort } from "./test-helpers.js"

// Mock spawn to control advocate/judge CLI output
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

import { spawn } from "node:child_process"
const mockSpawn = vi.mocked(spawn)

// ── Pure parser tests ─────────────────────────────────────────────────

describe("parseAdvocateOutput", () => {
  it("parses valid advocate JSON", () => {
    const input = JSON.stringify({
      argument: "Redis is faster because of in-memory storage",
      sources: ["https://redis.io/benchmarks"],
      searchCount: 2,
    })
    const result = parseAdvocateOutput(input, "use-redis")
    expect(result).toEqual({
      argument: "Redis is faster because of in-memory storage",
      sources: ["https://redis.io/benchmarks"],
      searchCount: 2,
    })
  })

  it("parses JSON inside markdown fences", () => {
    const input = '```json\n{"argument":"Test arg","sources":[],"searchCount":0}\n```'
    const result = parseAdvocateOutput(input, "opt-a")
    expect(result).not.toBeNull()
    expect(result!.argument).toBe("Test arg")
  })

  it("extracts JSON object from surrounding text", () => {
    const input = 'Here is my analysis:\n{"argument":"Good option","sources":["src1"],"searchCount":1}\nDone.'
    const result = parseAdvocateOutput(input, "opt-a")
    expect(result).not.toBeNull()
    expect(result!.sources).toEqual(["src1"])
  })

  it("returns null for missing argument field", () => {
    const input = JSON.stringify({ sources: ["a"], searchCount: 1 })
    expect(parseAdvocateOutput(input, "opt-a")).toBeNull()
  })

  it("returns null for empty argument", () => {
    const input = JSON.stringify({ argument: "", sources: [], searchCount: 0 })
    expect(parseAdvocateOutput(input, "opt-a")).toBeNull()
  })

  it("returns null for no JSON in output", () => {
    expect(parseAdvocateOutput("no json here", "opt-a")).toBeNull()
  })

  it("returns null for invalid JSON", () => {
    expect(parseAdvocateOutput("{invalid json}", "opt-a")).toBeNull()
  })

  it("filters non-string sources", () => {
    const input = JSON.stringify({
      argument: "Good option",
      sources: ["valid", 42, null, "also-valid"],
      searchCount: 1,
    })
    const result = parseAdvocateOutput(input, "opt-a")
    expect(result!.sources).toEqual(["valid", "also-valid"])
  })

  it("defaults searchCount to sources length when not a number", () => {
    const input = JSON.stringify({
      argument: "Test",
      sources: ["a", "b"],
      searchCount: "not-a-number",
    })
    const result = parseAdvocateOutput(input, "opt-a")
    expect(result!.searchCount).toBe(2)
  })

  it("uses searchCount when it is a number", () => {
    const input = JSON.stringify({
      argument: "Test",
      sources: ["a"],
      searchCount: 5,
    })
    const result = parseAdvocateOutput(input, "opt-a")
    expect(result!.searchCount).toBe(5)
  })

  it("defaults sources to empty array when not an array", () => {
    const input = JSON.stringify({
      argument: "Test",
      sources: "not-an-array",
      searchCount: 0,
    })
    const result = parseAdvocateOutput(input, "opt-a")
    expect(result!.sources).toEqual([])
  })
})

describe("parseJudgeDecision", () => {
  it("parses valid judge decision JSON", () => {
    const input = JSON.stringify({
      chosenOptionId: "use-redis",
      reasoning: "Redis provides better performance for our use case",
      summary: "Use Redis for caching",
      tradeoffs: ["Higher memory usage", "More complex setup"],
    })
    const result = parseJudgeDecision(input)
    expect(result).toEqual({
      chosenOptionId: "use-redis",
      reasoning: "Redis provides better performance for our use case",
      summary: "Use Redis for caching",
      tradeoffs: ["Higher memory usage", "More complex setup"],
    })
  })

  it("parses JSON inside markdown fences", () => {
    const input = '```json\n{"chosenOptionId":"a","reasoning":"because","summary":"pick a","tradeoffs":[]}\n```'
    const result = parseJudgeDecision(input)
    expect(result).not.toBeNull()
    expect(result!.chosenOptionId).toBe("a")
  })

  it("extracts JSON from surrounding text", () => {
    const input = 'My decision:\n{"chosenOptionId":"b","reasoning":"better fit","summary":"go with b","tradeoffs":["cost"]}\nEnd.'
    const result = parseJudgeDecision(input)
    expect(result).not.toBeNull()
    expect(result!.chosenOptionId).toBe("b")
  })

  it("returns null for missing chosenOptionId", () => {
    const input = JSON.stringify({
      reasoning: "because",
      summary: "something",
      tradeoffs: [],
    })
    expect(parseJudgeDecision(input)).toBeNull()
  })

  it("returns null for empty chosenOptionId", () => {
    const input = JSON.stringify({
      chosenOptionId: "",
      reasoning: "because",
      summary: "something",
      tradeoffs: [],
    })
    expect(parseJudgeDecision(input)).toBeNull()
  })

  it("returns null for missing reasoning", () => {
    const input = JSON.stringify({
      chosenOptionId: "a",
      summary: "something",
      tradeoffs: [],
    })
    expect(parseJudgeDecision(input)).toBeNull()
  })

  it("returns null for no JSON in output", () => {
    expect(parseJudgeDecision("no json here")).toBeNull()
  })

  it("returns null for invalid JSON", () => {
    expect(parseJudgeDecision("{bad json}")).toBeNull()
  })

  it("defaults summary when missing", () => {
    const input = JSON.stringify({
      chosenOptionId: "a",
      reasoning: "good reasons",
      tradeoffs: [],
    })
    const result = parseJudgeDecision(input)
    expect(result!.summary).toBe("Decision made by judge arena")
  })

  it("filters non-string tradeoffs", () => {
    const input = JSON.stringify({
      chosenOptionId: "a",
      reasoning: "reasons",
      summary: "summary",
      tradeoffs: ["valid", 42, null, "also-valid"],
    })
    const result = parseJudgeDecision(input)
    expect(result!.tradeoffs).toEqual(["valid", "also-valid"])
  })

  it("defaults tradeoffs to empty array when not an array", () => {
    const input = JSON.stringify({
      chosenOptionId: "a",
      reasoning: "reasons",
      summary: "summary",
      tradeoffs: "not-array",
    })
    const result = parseJudgeDecision(input)
    expect(result!.tradeoffs).toEqual([])
  })
})

// ── Orchestrator integration tests ────────────────────────────────────

describe("JudgeOrchestrator.handleJudgeCommand", () => {
  function createMockChildProcess(output: string = "{}"): ChildProcess {
    const child = {
      stdout: {
        on: vi.fn((event: string, cb: (data: Buffer) => void) => {
          if (event === "data") cb(Buffer.from(output))
        }),
      },
      stderr: { on: vi.fn() },
      stdin: { write: vi.fn(), end: vi.fn() },
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === "close") cb(0)
      }),
      kill: vi.fn(),
    } as unknown as ChildProcess
    return child
  }

  function createMockContext(): EngineContext {
    const telegram = {
      sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: null }),
    }
    return {
      config: {
        workspace: { maxSplitItems: 10, maxConcurrentSessions: 5 },
      },
      telegram,
      sessions: new Map(),
      topicSessions: new Map(),
      dags: new Map(),
      abortControllers: new Map(),
      profileStore: { get: vi.fn().mockReturnValue(undefined) },
      pushToConversation: vi.fn(),
      postStatus: vi.fn(async (topicSession, html) => {
        await telegram.sendMessage(html, topicSession.threadId)
        return { ok: true, messageId: null }
      }),
      handleDeadThread: vi.fn(),
    } as unknown as EngineContext
  }

  function createTopicSession(conversation?: TopicMessage[]): TopicSession {
    return {
      threadId: 123,
      repo: "test-repo",
      cwd: "/tmp/test",
      slug: "test-slug",
      conversation: conversation ?? [
        { role: "user", text: "Should we use Redis or Memcached?" },
        { role: "assistant", text: "Let me evaluate both options..." },
      ],
      mode: "plan",
    } as TopicSession
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("sends extraction message then error when extraction fails", async () => {
    // Simulate CLI failure — all retries fail
    const failChild = {
      stdout: { on: vi.fn() },
      stderr: {
        on: vi.fn((event: string, cb: (data: Buffer) => void) => {
          if (event === "data") cb(Buffer.from("CLI error"))
        }),
      },
      stdin: { write: vi.fn(), end: vi.fn() },
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === "close") cb(1)
      }),
      kill: vi.fn(),
    } as unknown as ChildProcess

    mockSpawn.mockReturnValue(failChild)

    const ctx = createMockContext()
    const orchestrator = new JudgeOrchestrator(ctx)
    const session = createTopicSession()

    await orchestrator.handleJudgeCommand(session)

    const sendMessage = ctx.telegram.sendMessage as ReturnType<typeof vi.fn>
    expect(sendMessage).toHaveBeenCalledTimes(2)
    // First call: extraction message
    expect(sendMessage.mock.calls[0][0]).toContain("Extracting options")
    // Second call: error message
    expect(sendMessage.mock.calls[1][0]).toContain("Judge Arena failed")
  })

  it("sends error when fewer than 2 options extracted", async () => {
    // Return only 1 option
    const output = JSON.stringify([
      { id: "only-one", title: "Only One", description: "Single option" },
    ])
    mockSpawn.mockReturnValue(createMockChildProcess(output))

    const ctx = createMockContext()
    const orchestrator = new JudgeOrchestrator(ctx)
    const session = createTopicSession()

    await orchestrator.handleJudgeCommand(session)

    const sendMessage = ctx.telegram.sendMessage as ReturnType<typeof vi.fn>
    // extraction msg + error msg
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage.mock.calls[1][0]).toContain("at least 2")
  })

  it("runs full arena flow with valid options", async () => {
    const options = [
      { id: "redis", title: "Use Redis", description: "Redis caching" },
      { id: "memcached", title: "Use Memcached", description: "Memcached caching" },
    ]

    const advocateOutput = JSON.stringify({
      argument: "This is the best option because of performance",
      sources: ["https://example.com"],
      searchCount: 1,
    })

    const judgeOutput = JSON.stringify({
      chosenOptionId: "redis",
      reasoning: "Redis wins due to better feature set",
      summary: "Use Redis",
      tradeoffs: ["Higher memory usage"],
    })

    let callCount = 0
    mockSpawn.mockImplementation(() => {
      callCount++
      // First call: extraction (returns options)
      // Calls 2-3: advocates (return arguments)
      // Last call: judge (returns verdict)
      if (callCount === 1) {
        return createMockChildProcess(JSON.stringify(options))
      } else if (callCount <= 3) {
        return createMockChildProcess(advocateOutput)
      } else {
        return createMockChildProcess(judgeOutput)
      }
    })

    const ctx = createMockContext()
    const orchestrator = new JudgeOrchestrator(ctx)
    const session = createTopicSession()

    await orchestrator.handleJudgeCommand(session)

    const sendMessage = ctx.telegram.sendMessage as ReturnType<typeof vi.fn>
    // extraction + arena + 2 advocate arguments + verdict = 5
    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(5)

    // Check arena message includes both options
    const arenaMsg = sendMessage.mock.calls[1][0] as string
    expect(arenaMsg).toContain("Judge Arena")
    expect(arenaMsg).toContain("redis")
    expect(arenaMsg).toContain("memcached")

    // Check verdict message
    const verdictMsg = sendMessage.mock.calls[sendMessage.mock.calls.length - 1][0] as string
    expect(verdictMsg).toContain("Verdict")
    expect(verdictMsg).toContain("redis")

    // Check conversation was updated with verdict
    expect(ctx.pushToConversation).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        role: "assistant",
        text: expect.stringContaining("Redis wins"),
      }),
    )
  })

  it("kills active session before starting arena", async () => {
    const options = [
      { id: "a", title: "A", description: "Option A" },
      { id: "b", title: "B", description: "Option B" },
    ]

    mockSpawn.mockReturnValue(createMockChildProcess(JSON.stringify(options)))

    const ctx = createMockContext()
    const mockKill = vi.fn().mockResolvedValue(undefined)
    const activeSession = makeMockActiveSession({
      handle: makeMockSessionPort({ kill: mockKill }),
    })
    ctx.sessions.set(123, activeSession)

    const orchestrator = new JudgeOrchestrator(ctx)
    const session = createTopicSession()
    session.activeSessionId = "active-session-id"

    await orchestrator.handleJudgeCommand(session)

    expect(mockKill).toHaveBeenCalled()
    expect(session.activeSessionId).toBeUndefined()
  })

  it("handles all advocates failing gracefully", async () => {
    const options = [
      { id: "a", title: "A", description: "Option A" },
      { id: "b", title: "B", description: "Option B" },
    ]

    const failChild = {
      stdout: { on: vi.fn() },
      stderr: {
        on: vi.fn((event: string, cb: (data: Buffer) => void) => {
          if (event === "data") cb(Buffer.from("error"))
        }),
      },
      stdin: { write: vi.fn(), end: vi.fn() },
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === "close") cb(1)
      }),
      kill: vi.fn(),
    } as unknown as ChildProcess

    let callCount = 0
    mockSpawn.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return createMockChildProcess(JSON.stringify(options))
      }
      return failChild
    })

    const ctx = createMockContext()
    const orchestrator = new JudgeOrchestrator(ctx)
    const session = createTopicSession()

    await orchestrator.handleJudgeCommand(session)

    const sendMessage = ctx.telegram.sendMessage as ReturnType<typeof vi.fn>
    const lastMsg = sendMessage.mock.calls[sendMessage.mock.calls.length - 1][0] as string
    expect(lastMsg).toContain("All advocate agents failed")
  })

  it("uses directive as question when provided", async () => {
    const options = [
      { id: "a", title: "A", description: "Option A" },
      { id: "b", title: "B", description: "Option B" },
    ]

    const advocateOutput = JSON.stringify({
      argument: "Good option",
      sources: [],
      searchCount: 0,
    })

    const judgeOutput = JSON.stringify({
      chosenOptionId: "a",
      reasoning: "A is better",
      summary: "Go with A",
      tradeoffs: [],
    })

    let callCount = 0
    mockSpawn.mockImplementation(() => {
      callCount++
      if (callCount === 1) return createMockChildProcess(JSON.stringify(options))
      if (callCount <= 3) return createMockChildProcess(advocateOutput)
      return createMockChildProcess(judgeOutput)
    })

    const ctx = createMockContext()
    const orchestrator = new JudgeOrchestrator(ctx)
    const session = createTopicSession()

    await orchestrator.handleJudgeCommand(session, "Which caching strategy?")

    const sendMessage = ctx.telegram.sendMessage as ReturnType<typeof vi.fn>
    const arenaMsg = sendMessage.mock.calls[1][0] as string
    expect(arenaMsg).toContain("Which caching strategy?")
  })
})
