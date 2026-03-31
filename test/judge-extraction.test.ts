import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { parseJudgeOptions, extractJudgeOptions } from "../src/judge/judge-extraction.js"
import type { TopicMessage } from "../src/types.js"
import type { ProviderProfile } from "../src/config/config-types.js"
import type { ChildProcess } from "node:child_process"

// Mock spawn to verify environment variables
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

import { spawn } from "node:child_process"
const mockSpawn = vi.mocked(spawn)

describe("parseJudgeOptions", () => {
  it("parses a valid JSON array of options", () => {
    const input = '[{"id":"use-redis","title":"Use Redis","description":"Cache with Redis for fast lookups"}]'
    const options = parseJudgeOptions(input)
    expect(options).toEqual([{
      id: "use-redis",
      title: "Use Redis",
      description: "Cache with Redis for fast lookups",
    }])
  })

  it("parses multiple options", () => {
    const input = JSON.stringify([
      { id: "option-a", title: "Option A", description: "First approach" },
      { id: "option-b", title: "Option B", description: "Second approach" },
    ])
    const options = parseJudgeOptions(input)
    expect(options).toHaveLength(2)
    expect(options[0].id).toBe("option-a")
    expect(options[1].id).toBe("option-b")
  })

  it("parses JSON inside markdown fences", () => {
    const input = '```json\n[{"id":"x","title":"X","description":"Do X"}]\n```'
    const options = parseJudgeOptions(input)
    expect(options).toHaveLength(1)
    expect(options[0].id).toBe("x")
  })

  it("extracts JSON array from surrounding text", () => {
    const input = 'Here are the options:\n[{"id":"a","title":"A","description":"Do A"}]\nDone.'
    const options = parseJudgeOptions(input)
    expect(options).toHaveLength(1)
  })

  it("returns empty array for no JSON", () => {
    expect(parseJudgeOptions("no json here")).toEqual([])
  })

  it("returns empty array for invalid JSON", () => {
    expect(parseJudgeOptions("[not valid json]")).toEqual([])
  })

  it("filters items with missing id", () => {
    const input = '[{"title":"A","description":"Do A"},{"id":"b","title":"B","description":"Do B"}]'
    const options = parseJudgeOptions(input)
    expect(options).toHaveLength(1)
    expect(options[0].id).toBe("b")
  })

  it("filters items with empty id", () => {
    const input = '[{"id":"","title":"A","description":"Do A"}]'
    const options = parseJudgeOptions(input)
    expect(options).toHaveLength(0)
  })

  it("filters items with missing title", () => {
    const input = '[{"id":"a","description":"Do A"}]'
    const options = parseJudgeOptions(input)
    expect(options).toHaveLength(0)
  })

  it("filters items with missing description", () => {
    const input = '[{"id":"a","title":"A"}]'
    const options = parseJudgeOptions(input)
    expect(options).toHaveLength(0)
  })

  it("filters non-object items", () => {
    const input = '["string", null, 42, {"id":"a","title":"A","description":"Do A"}]'
    const options = parseJudgeOptions(input)
    expect(options).toHaveLength(1)
    expect(options[0].id).toBe("a")
  })

  it("returns empty array when parsed value is not an array", () => {
    const input = '{"id":"a","title":"A","description":"Do A"}'
    expect(parseJudgeOptions(input)).toEqual([])
  })

  it("handles fenced JSON with extra whitespace", () => {
    const input = '```json\n  \n[{"id":"ws","title":"Whitespace","description":"Handles whitespace"}]\n  \n```'
    const options = parseJudgeOptions(input)
    expect(options).toHaveLength(1)
    expect(options[0].id).toBe("ws")
  })

  it("ignores extra fields on valid items", () => {
    const input = '[{"id":"a","title":"A","description":"Do A","extra":"ignored"}]'
    const options = parseJudgeOptions(input)
    expect(options).toHaveLength(1)
    expect(options[0].id).toBe("a")
  })
})

describe("extractJudgeOptions profile environment", () => {
  const conversation: TopicMessage[] = [
    { role: "user", text: "Should we use Redis or Memcached for caching?" },
    { role: "assistant", text: "Let me compare both options..." },
  ]

  function createMockChildProcess(output: string = "[]"): ChildProcess {
    const child = {
      stdout: { on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === "data") cb(Buffer.from(output))
      }) },
      stderr: { on: vi.fn() },
      stdin: { write: vi.fn(), end: vi.fn() },
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === "close") cb(0)
      }),
      kill: vi.fn(),
    } as unknown as ChildProcess
    return child
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("passes profile baseUrl to spawned claude process", async () => {
    const profile: ProviderProfile = {
      id: "test-profile",
      name: "Test",
      baseUrl: "https://custom.api.endpoint",
    }
    mockSpawn.mockReturnValue(createMockChildProcess())

    await extractJudgeOptions(conversation, undefined, profile)

    expect(mockSpawn).toHaveBeenCalled()
    const callArgs = mockSpawn.mock.calls[0]
    const env = callArgs[2]?.env
    expect(env?.ANTHROPIC_BASE_URL).toBe("https://custom.api.endpoint")
  })

  it("passes profile authToken to spawned claude process", async () => {
    const profile: ProviderProfile = {
      id: "test-profile",
      name: "Test",
      authToken: "sk-test-token",
    }
    mockSpawn.mockReturnValue(createMockChildProcess())

    await extractJudgeOptions(conversation, undefined, profile)

    const env = mockSpawn.mock.calls[0][2]?.env
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-test-token")
  })

  it("passes all profile fields together", async () => {
    const profile: ProviderProfile = {
      id: "full-profile",
      name: "Full",
      baseUrl: "https://full.api.endpoint",
      authToken: "full-token-123",
      haikuModel: "claude-3-haiku-custom",
    }
    mockSpawn.mockReturnValue(createMockChildProcess())

    await extractJudgeOptions(conversation, undefined, profile)

    const env = mockSpawn.mock.calls[0][2]?.env
    expect(env?.ANTHROPIC_BASE_URL).toBe("https://full.api.endpoint")
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBe("full-token-123")
    expect(env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-3-haiku-custom")
  })

  it("does not override process.env when profile is undefined", async () => {
    mockSpawn.mockReturnValue(createMockChildProcess())

    await extractJudgeOptions(conversation, undefined, undefined)

    const env = mockSpawn.mock.calls[0][2]?.env
    expect(env).toBeDefined()
    expect(env?.PATH).toBe(process.env.PATH)
  })

  it("returns parsed options on successful extraction", async () => {
    const output = JSON.stringify([
      { id: "redis", title: "Use Redis", description: "Redis approach" },
      { id: "memcached", title: "Use Memcached", description: "Memcached approach" },
    ])
    mockSpawn.mockReturnValue(createMockChildProcess(output))

    const result = await extractJudgeOptions(conversation, undefined, undefined)

    expect(result.options).toHaveLength(2)
    expect(result.options[0].id).toBe("redis")
    expect(result.options[1].id).toBe("memcached")
    expect(result.error).toBeUndefined()
  })

  it("returns empty options with error on failure", async () => {
    const child = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === "data") cb(Buffer.from("CLI error"))
      }) },
      stdin: { write: vi.fn(), end: vi.fn() },
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === "close") cb(1)
      }),
      kill: vi.fn(),
    } as unknown as ChildProcess
    mockSpawn.mockReturnValue(child)

    const result = await extractJudgeOptions(conversation)

    expect(result.options).toEqual([])
    expect(result.error).toBe("system")
  })

  it("includes directive in task text", async () => {
    mockSpawn.mockReturnValue(createMockChildProcess())

    await extractJudgeOptions(conversation, "Focus on caching options only")

    const stdinWrite = (mockSpawn.mock.results[0].value as unknown as { stdin: { write: ReturnType<typeof vi.fn> } }).stdin.write
    const writtenTask = stdinWrite.mock.calls[0][0] as string
    expect(writtenTask).toContain("Focus on caching options only")
  })
})
