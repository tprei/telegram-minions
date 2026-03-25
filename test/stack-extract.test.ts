import { describe, it, expect } from "vitest"
import { parseStackItems, buildStackChildPrompt } from "../src/stack-extract.js"
import type { TopicMessage } from "../src/types.js"
import type { StackItem } from "../src/stack-orchestrator.js"

describe("parseStackItems", () => {
  it("parses a valid JSON array with dependencies", () => {
    const input = '[{"id":"refactor","title":"Refactor core","description":"Refactor the core module","dependencies":[]}]'
    const items = parseStackItems(input)
    expect(items).toEqual([{
      id: "refactor",
      title: "Refactor core",
      description: "Refactor the core module",
      dependencies: [],
    }])
  })

  it("parses items with dependencies", () => {
    const input = JSON.stringify([
      { id: "base", title: "Base", description: "Base changes", dependencies: [] },
      { id: "feature", title: "Feature", description: "Add feature", dependencies: ["base"] },
    ])
    const items = parseStackItems(input)
    expect(items).toHaveLength(2)
    expect(items[1].dependencies).toEqual(["base"])
  })

  it("parses JSON inside markdown fences", () => {
    const input = '```json\n[{"id":"test","title":"Test","description":"Add tests","dependencies":[]}]\n```'
    const items = parseStackItems(input)
    expect(items).toEqual([{
      id: "test",
      title: "Test",
      description: "Add tests",
      dependencies: [],
    }])
  })

  it("extracts JSON array from surrounding text", () => {
    const input = 'Here are the stack items:\n[{"id":"a","title":"A","description":"Do A","dependencies":[]}]\nDone.'
    const items = parseStackItems(input)
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe("a")
  })

  it("returns empty array for no JSON", () => {
    expect(parseStackItems("no json here")).toEqual([])
  })

  it("returns empty array for empty input", () => {
    expect(parseStackItems("")).toEqual([])
  })

  it("returns empty array for invalid JSON", () => {
    expect(parseStackItems("[not valid json]")).toEqual([])
  })

  it("filters out items with empty id", () => {
    const input = '[{"id":"","title":"Valid","description":"task"},{"id":"good","title":"Good","description":"Complete"}]'
    const items = parseStackItems(input)
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe("good")
  })

  it("filters out items with missing fields", () => {
    const input = '[{"id":"a","title":"Only title"},{"id":"b","description":"Only desc"},{"id":"c","title":"Good","description":"Complete"}]'
    const items = parseStackItems(input)
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe("c")
  })

  it("filters out invalid dependency references", () => {
    const input = JSON.stringify([
      { id: "a", title: "A", description: "First", dependencies: [] },
      { id: "b", title: "B", description: "Second", dependencies: ["a", "nonexistent"] },
    ])
    const items = parseStackItems(input)
    expect(items).toHaveLength(2)
    // The invalid dependency should be filtered out
    expect(items[1].dependencies).toEqual(["a"])
  })

  it("handles non-array dependencies gracefully", () => {
    const input = '[{"id":"a","title":"A","description":"Do A","dependencies":"not-an-array"}]'
    const items = parseStackItems(input)
    expect(items).toHaveLength(1)
    expect(items[0].dependencies).toEqual([])
  })

  it("handles multiple items with complex dependencies", () => {
    const input = JSON.stringify([
      { id: "infra", title: "Infrastructure", description: "Setup infra", dependencies: [] },
      { id: "api", title: "API", description: "Build API", dependencies: ["infra"] },
      { id: "frontend", title: "Frontend", description: "Build UI", dependencies: ["infra"] },
      { id: "integration", title: "Integration", description: "Integrate", dependencies: ["api", "frontend"] },
    ])
    const items = parseStackItems(input)
    expect(items).toHaveLength(4)
    expect(items[3].dependencies).toEqual(["api", "frontend"])
  })
})

describe("buildStackChildPrompt", () => {
  const conversation: TopicMessage[] = [
    { role: "user", text: "Build a feature with API and frontend" },
    { role: "assistant", text: "I'll break this down into:\n1. Infrastructure setup\n2. API endpoint\n3. Frontend component\n4. Integration tests" },
    { role: "user", text: "Sounds good, proceed" },
  ]

  const items: StackItem[] = [
    { id: "infra", title: "Infrastructure", description: "Setup infrastructure", dependencies: [] },
    { id: "api", title: "API endpoint", description: "Build the API", dependencies: ["infra"] },
    { id: "frontend", title: "Frontend", description: "Build the UI", dependencies: ["infra"] },
    { id: "tests", title: "Integration tests", description: "Add tests", dependencies: ["api", "frontend"] },
  ]

  it("includes original request", () => {
    const prompt = buildStackChildPrompt(conversation, items[1], items)
    expect(prompt).toContain("Build a feature with API and frontend")
  })

  it("includes the assigned stack item", () => {
    const prompt = buildStackChildPrompt(conversation, items[1], items)
    expect(prompt).toContain("Your assigned stack item: API endpoint")
    expect(prompt).toContain("Build the API")
  })

  it("includes dependency information when item has dependencies", () => {
    const prompt = buildStackChildPrompt(conversation, items[1], items)
    expect(prompt).toContain("Dependencies")
    expect(prompt).toContain("This item depends on the following items being completed first")
    expect(prompt).toContain("Infrastructure")
  })

  it("does not include dependencies section for root items", () => {
    const prompt = buildStackChildPrompt(conversation, items[0], items)
    expect(prompt).not.toContain("## Dependencies")
  })

  it("includes stack context with all items", () => {
    const prompt = buildStackChildPrompt(conversation, items[1], items)
    expect(prompt).toContain("Stack context")
    expect(prompt).toContain("Infrastructure")
    expect(prompt).toContain("API endpoint")
    expect(prompt).toContain("Frontend")
    expect(prompt).toContain("Integration tests")
  })

  it("marks current item with YOU in stack context", () => {
    const prompt = buildStackChildPrompt(conversation, items[1], items)
    expect(prompt).toContain("API endpoint (YOU)")
  })

  it("includes planning thread context", () => {
    const prompt = buildStackChildPrompt(conversation, items[1], items)
    expect(prompt).toContain("Planning thread")
    expect(prompt).toContain("break this down")
  })

  it("truncates long assistant messages", () => {
    const longConversation: TopicMessage[] = [
      { role: "user", text: "Do stuff" },
      { role: "assistant", text: "x".repeat(5000) },
    ]
    const prompt = buildStackChildPrompt(longConversation, items[0], items)
    expect(prompt).toContain("[earlier output truncated]")
  })

  it("handles single-message conversation", () => {
    const short: TopicMessage[] = [{ role: "user", text: "Do the thing" }]
    const prompt = buildStackChildPrompt(short, items[0], items)
    expect(prompt).toContain("Do the thing")
    expect(prompt).not.toContain("Planning thread")
  })

  it("includes multiple dependencies", () => {
    const prompt = buildStackChildPrompt(conversation, items[3], items)
    expect(prompt).toContain("depends on: api, frontend")
  })
})
