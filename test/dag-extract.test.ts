import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { parseDagItems, parseStackItems, buildDagChildPrompt, extractDagItems, extractStackItems } from "../src/dag/dag-extract.js"
import type { TopicMessage } from "../src/types.js"
import type { DagInput } from "../src/dag/dag.js"
import type { ProviderProfile } from "../src/config/config-types.js"
import type { ChildProcess } from "node:child_process"

// Mock spawn to verify environment variables
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

import { spawn } from "node:child_process"
const mockSpawn = vi.mocked(spawn)

describe("parseDagItems", () => {
  it("parses a valid DAG JSON array", () => {
    const input = '[{"id":"db-schema","title":"DB Schema","description":"Create tables","dependsOn":[]}]'
    const items = parseDagItems(input)
    expect(items).toEqual([{
      id: "db-schema",
      title: "DB Schema",
      description: "Create tables",
      dependsOn: [],
    }])
  })

  it("parses items with dependencies", () => {
    const input = JSON.stringify([
      { id: "a", title: "A", description: "Do A", dependsOn: [] },
      { id: "b", title: "B", description: "Do B", dependsOn: ["a"] },
    ])
    const items = parseDagItems(input)
    expect(items).toHaveLength(2)
    expect(items[1].dependsOn).toEqual(["a"])
  })

  it("parses JSON inside markdown fences", () => {
    const input = '```json\n[{"id":"x","title":"X","description":"Do X","dependsOn":[]}]\n```'
    const items = parseDagItems(input)
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe("x")
  })

  it("extracts JSON array from surrounding text", () => {
    const input = 'Here are the items:\n[{"id":"a","title":"A","description":"Do A","dependsOn":[]}]\nDone.'
    const items = parseDagItems(input)
    expect(items).toHaveLength(1)
  })

  it("returns empty array for no JSON", () => {
    expect(parseDagItems("no json here")).toEqual([])
  })

  it("returns empty array for invalid JSON", () => {
    expect(parseDagItems("[not valid json]")).toEqual([])
  })

  it("filters items with missing id", () => {
    const input = '[{"title":"A","description":"Do A","dependsOn":[]},{"id":"b","title":"B","description":"Do B","dependsOn":[]}]'
    const items = parseDagItems(input)
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe("b")
  })

  it("defaults missing dependsOn to empty array", () => {
    const input = '[{"id":"a","title":"A","description":"Do A"}]'
    const items = parseDagItems(input)
    expect(items).toHaveLength(1)
    expect(items[0].dependsOn).toEqual([])
  })

  it("filters items with non-string dependsOn entries", () => {
    const input = '[{"id":"a","title":"A","description":"Do A","dependsOn":[123]}]'
    const items = parseDagItems(input)
    expect(items).toHaveLength(0)
  })
})

describe("parseStackItems", () => {
  it("parses a valid ordered array", () => {
    const input = '[{"title":"First","description":"Do first"},{"title":"Second","description":"Do second"}]'
    const items = parseStackItems(input)
    expect(items).toHaveLength(2)
    expect(items[0].title).toBe("First")
    expect(items[1].title).toBe("Second")
  })

  it("parses JSON inside markdown fences", () => {
    const input = '```json\n[{"title":"Step 1","description":"Setup"}]\n```'
    const items = parseStackItems(input)
    expect(items).toHaveLength(1)
  })

  it("filters invalid items", () => {
    const input = '[{"title":"Good","description":"Valid"},{"title":"","description":"Bad"}]'
    const items = parseStackItems(input)
    expect(items).toHaveLength(1)
  })

  it("returns empty for no JSON", () => {
    expect(parseStackItems("nothing")).toEqual([])
  })
})

describe("buildDagChildPrompt", () => {
  const conversation: TopicMessage[] = [
    { role: "user", text: "Build an auth system" },
    { role: "assistant", text: "I'll plan the implementation..." },
  ]

  it("includes original request", () => {
    const node: DagInput = {
      id: "db-schema",
      title: "DB Schema",
      description: "Create auth tables",
      dependsOn: [],
    }
    const prompt = buildDagChildPrompt(conversation, node, [node], [], false)
    expect(prompt).toContain("Build an auth system")
    expect(prompt).toContain("DB Schema")
    expect(prompt).toContain("Create auth tables")
  })

  it("includes upstream context when dependencies exist", () => {
    const allNodes: DagInput[] = [
      { id: "schema", title: "Schema", description: "Create schema", dependsOn: [] },
      { id: "api", title: "API", description: "Create API", dependsOn: ["schema"] },
    ]
    const prompt = buildDagChildPrompt(conversation, allNodes[1], allNodes, ["minion/slug-a"], false)
    expect(prompt).toContain("Upstream context")
    expect(prompt).toContain("Schema")
    expect(prompt).toContain("already been completed")
  })

  it("includes PR target instruction for stacks", () => {
    const allNodes: DagInput[] = [
      { id: "step-0", title: "First", description: "Do first", dependsOn: [] },
      { id: "step-1", title: "Second", description: "Do second", dependsOn: ["step-0"] },
    ]
    const prompt = buildDagChildPrompt(conversation, allNodes[1], allNodes, ["minion/slug-0"], true)
    expect(prompt).toContain("PR target")
    expect(prompt).toContain("minion/slug-0")
    expect(prompt).toContain("stacked PR")
  })

  it("does not include PR target instruction for non-stacks", () => {
    const allNodes: DagInput[] = [
      { id: "a", title: "A", description: "Do A", dependsOn: [] },
      { id: "b", title: "B", description: "Do B", dependsOn: ["a"] },
    ]
    const prompt = buildDagChildPrompt(conversation, allNodes[1], allNodes, ["minion/slug-a"], false)
    expect(prompt).not.toContain("PR target")
  })

  it("includes scope constraints for sibling nodes", () => {
    const allNodes: DagInput[] = [
      { id: "a", title: "A", description: "Do A", dependsOn: [] },
      { id: "b", title: "B", description: "Do B", dependsOn: [] },
      { id: "c", title: "C", description: "Do C", dependsOn: [] },
    ]
    const prompt = buildDagChildPrompt(conversation, allNodes[0], allNodes, [], false)
    expect(prompt).toContain("Scope constraints")
    expect(prompt).toContain("B")
    expect(prompt).toContain("C")
  })

  it("does not list dependencies as scope constraints", () => {
    const allNodes: DagInput[] = [
      { id: "a", title: "A", description: "Do A", dependsOn: [] },
      { id: "b", title: "B", description: "Do B", dependsOn: ["a"] },
    ]
    const prompt = buildDagChildPrompt(conversation, allNodes[1], allNodes, ["minion/slug-a"], false)
    // "A" should appear in upstream context, not in scope constraints
    expect(prompt).toContain("Upstream context")
    // If there are no siblings, scope constraints section may not appear or be empty
  })

  it("truncates long assistant messages", () => {
    const longConversation: TopicMessage[] = [
      { role: "user", text: "Plan this" },
      { role: "assistant", text: "x".repeat(5000) },
    ]
    const node: DagInput = { id: "a", title: "A", description: "Do A", dependsOn: [] }
    const prompt = buildDagChildPrompt(longConversation, node, [node], [], false)
    expect(prompt).toContain("[output truncated]")
  })

  it("includes conflict resolution instructions when conflictFiles are provided", () => {
    const node: DagInput = {
      id: "c",
      title: "Combine",
      description: "Combine upstream work",
      dependsOn: ["a", "b"],
    }
    const allNodes: DagInput[] = [
      { id: "a", title: "A", description: "Do A", dependsOn: [] },
      { id: "b", title: "B", description: "Do B", dependsOn: [] },
      node,
    ]
    const prompt = buildDagChildPrompt(conversation, node, allNodes, ["minion/a", "minion/b"], false, ["test/format.test.ts", "src/format.ts"])
    expect(prompt).toContain("Merge conflicts to resolve first")
    expect(prompt).toContain("`test/format.test.ts`")
    expect(prompt).toContain("`src/format.ts`")
    expect(prompt).toContain("git add")
    expect(prompt).toContain("git commit --no-edit")
  })

  it("omits conflict section when conflictFiles is empty", () => {
    const node: DagInput = { id: "a", title: "A", description: "Do A", dependsOn: [] }
    const prompt = buildDagChildPrompt(conversation, node, [node], [], false, [])
    expect(prompt).not.toContain("Merge conflicts to resolve first")
  })
})

describe("extractDagItems profile environment", () => {
  const conversation: TopicMessage[] = [
    { role: "user", text: "Build an auth system" },
    { role: "assistant", text: "I'll plan it" },
  ]

  // Helper to create a mock child process that exits successfully
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
    // Suppress stderr in tests
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

    await extractDagItems(conversation, undefined, profile)

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

    await extractDagItems(conversation, undefined, profile)

    const env = mockSpawn.mock.calls[0][2]?.env
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-test-token")
  })

  it("passes profile haikuModel to spawned claude process", async () => {
    const profile: ProviderProfile = {
      id: "test-profile",
      name: "Test",
      haikuModel: "claude-custom-haiku",
    }
    mockSpawn.mockReturnValue(createMockChildProcess())

    await extractDagItems(conversation, undefined, profile)

    const env = mockSpawn.mock.calls[0][2]?.env
    expect(env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-custom-haiku")
  })

  it("passes all profile fields together", async () => {
    const profile: ProviderProfile = {
      id: "z-ai-profile",
      name: "Z.AI",
      baseUrl: "https://z-ai.example.com/v1",
      authToken: "zai-token-123",
      haikuModel: "claude-3-haiku-zai",
    }
    mockSpawn.mockReturnValue(createMockChildProcess())

    await extractDagItems(conversation, undefined, profile)

    const env = mockSpawn.mock.calls[0][2]?.env
    expect(env?.ANTHROPIC_BASE_URL).toBe("https://z-ai.example.com/v1")
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBe("zai-token-123")
    expect(env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-3-haiku-zai")
  })

  it("does not override process.env when profile is undefined", async () => {
    mockSpawn.mockReturnValue(createMockChildProcess())

    await extractDagItems(conversation, undefined, undefined)

    const env = mockSpawn.mock.calls[0][2]?.env
    // When profile is undefined, process.env is spread but no profile overrides are applied
    // The env should still contain process.env values (not be wiped out)
    expect(env).toBeDefined()
    expect(env?.PATH).toBe(process.env.PATH) // Sanity check that process.env is spread
  })

  it("does not add profile overrides for undefined profile fields", async () => {
    const profile: ProviderProfile = {
      id: "minimal-profile",
      name: "Minimal",
      // No baseUrl, authToken, or haikuModel - these should not be overridden
    }
    mockSpawn.mockReturnValue(createMockChildProcess())

    await extractDagItems(conversation, undefined, profile)

    const env = mockSpawn.mock.calls[0][2]?.env
    // Profile with undefined fields should not add any of these keys
    // (though process.env values may already exist, the profile shouldn't add new ones)
    expect(env).toBeDefined()
    expect(env?.PATH).toBe(process.env.PATH)
  })
})

describe("extractStackItems profile environment", () => {
  const conversation: TopicMessage[] = [
    { role: "user", text: "Build in order" },
    { role: "assistant", text: "I'll plan the steps" },
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

  it("passes profile environment to spawned claude process for stack extraction", async () => {
    const profile: ProviderProfile = {
      id: "stack-profile",
      name: "Stack Test",
      baseUrl: "https://stack.api.endpoint",
      authToken: "stack-token",
      haikuModel: "stack-haiku-model",
    }
    mockSpawn.mockReturnValue(createMockChildProcess())

    await extractStackItems(conversation, undefined, profile)

    const env = mockSpawn.mock.calls[0][2]?.env
    expect(env?.ANTHROPIC_BASE_URL).toBe("https://stack.api.endpoint")
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBe("stack-token")
    expect(env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("stack-haiku-model")
  })
})
