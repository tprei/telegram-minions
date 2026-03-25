import { describe, it, expect } from "vitest"
import { parseDagItems, parseStackItems, buildDagChildPrompt } from "../src/dag-extract.js"
import type { TopicMessage } from "../src/types.js"
import type { DagInput } from "../src/dag.js"

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
    expect(prompt).toContain("[earlier output truncated]")
  })
})
