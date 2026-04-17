import { describe, it, expect } from "vitest"
import { parseDagItems, parseStackItems } from "../../src/dag/dag-extract.js"

describe("parseDagItems", () => {
  it("parses a valid JSON array of DAG items", () => {
    const input = JSON.stringify([
      { id: "db-schema", title: "Create DB schema", description: "Set up tables", dependsOn: [] },
      { id: "api-routes", title: "Add API routes", description: "REST endpoints", dependsOn: ["db-schema"] },
    ])
    const result = parseDagItems(input)
    expect(result).toEqual([
      { id: "db-schema", title: "Create DB schema", description: "Set up tables", dependsOn: [] },
      { id: "api-routes", title: "Add API routes", description: "REST endpoints", dependsOn: ["db-schema"] },
    ])
  })

  it("extracts JSON from markdown code fences", () => {
    const input = '```json\n[{ "id": "a", "title": "Task A", "description": "Do A", "dependsOn": [] }]\n```'
    const result = parseDagItems(input)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("a")
  })

  it("extracts JSON array embedded in surrounding text", () => {
    const input = 'Here are the items:\n[{ "id": "x", "title": "X", "description": "Do X", "dependsOn": [] }]\nDone.'
    const result = parseDagItems(input)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("x")
  })

  it("defaults missing dependsOn to empty array", () => {
    const input = JSON.stringify([
      { id: "solo", title: "Solo task", description: "No deps" },
    ])
    const result = parseDagItems(input)
    expect(result).toHaveLength(1)
    expect(result[0].dependsOn).toEqual([])
  })

  it("filters out items with missing required fields", () => {
    const input = JSON.stringify([
      { id: "valid", title: "Valid", description: "OK", dependsOn: [] },
      { id: "", title: "Empty ID", description: "Bad", dependsOn: [] },
      { id: "no-title", title: "", description: "Bad", dependsOn: [] },
      { id: "no-desc", title: "Title", description: "", dependsOn: [] },
      { title: "Missing ID", description: "Bad", dependsOn: [] },
      "not-an-object",
      null,
    ])
    const result = parseDagItems(input)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("valid")
  })

  it("filters out items with non-string dependsOn entries", () => {
    const input = JSON.stringify([
      { id: "bad-deps", title: "Bad deps", description: "Has numeric dep", dependsOn: [123] },
      { id: "good", title: "Good", description: "String deps", dependsOn: ["other"] },
    ])
    const result = parseDagItems(input)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("good")
  })

  it("throws when no JSON array is found", () => {
    expect(() => parseDagItems("no json here")).toThrow("no JSON array found")
  })

  it("throws on invalid JSON", () => {
    expect(() => parseDagItems('[{"bad json]')).toThrow("JSON parse error")
  })

  it("returns empty array for empty JSON array input", () => {
    const result = parseDagItems("[]")
    expect(result).toEqual([])
  })
})

describe("parseStackItems", () => {
  it("parses a valid JSON array of stack items", () => {
    const input = JSON.stringify([
      { title: "Step 1", description: "First step" },
      { title: "Step 2", description: "Second step" },
    ])
    const result = parseStackItems(input)
    expect(result).toEqual([
      { title: "Step 1", description: "First step" },
      { title: "Step 2", description: "Second step" },
    ])
  })

  it("extracts JSON from markdown code fences", () => {
    const input = '```json\n[{ "title": "A", "description": "Do A" }]\n```'
    const result = parseStackItems(input)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe("A")
  })

  it("filters out items with missing title or description", () => {
    const input = JSON.stringify([
      { title: "Good", description: "Valid" },
      { title: "", description: "Empty title" },
      { title: "No desc", description: "" },
      { description: "Missing title" },
      null,
    ])
    const result = parseStackItems(input)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe("Good")
  })

  it("throws when no JSON array is found", () => {
    expect(() => parseStackItems("just text")).toThrow("no JSON array found")
  })

  it("throws on invalid JSON", () => {
    expect(() => parseStackItems('[{"bad json]')).toThrow("JSON parse error")
  })

  it("returns empty array for empty JSON array input", () => {
    const result = parseStackItems("[]")
    expect(result).toEqual([])
  })
})
