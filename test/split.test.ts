import { describe, it, expect } from "vitest"
import { parseSplitItems, buildSplitChildPrompt, getClaudeConfigDir } from "../src/orchestration/split.js"
import type { TopicMessage } from "../src/types.js"

describe("parseSplitItems", () => {
  it("parses a valid JSON array", () => {
    const input = '[{"title":"Add auth","description":"Implement auth middleware"}]'
    const items = parseSplitItems(input)
    expect(items).toEqual([{ title: "Add auth", description: "Implement auth middleware" }])
  })

  it("parses JSON inside markdown fences", () => {
    const input = '```json\n[{"title":"Fix bug","description":"Fix the login bug"}]\n```'
    const items = parseSplitItems(input)
    expect(items).toEqual([{ title: "Fix bug", description: "Fix the login bug" }])
  })

  it("extracts JSON array from surrounding text", () => {
    const input = 'Here are the items:\n[{"title":"A","description":"Do A"},{"title":"B","description":"Do B"}]\nDone.'
    const items = parseSplitItems(input)
    expect(items).toHaveLength(2)
    expect(items[0].title).toBe("A")
    expect(items[1].title).toBe("B")
  })

  it("returns empty array for no JSON", () => {
    expect(parseSplitItems("no json here")).toEqual([])
  })

  it("returns empty array for empty input", () => {
    expect(parseSplitItems("")).toEqual([])
  })

  it("returns empty array for invalid JSON", () => {
    expect(parseSplitItems("[not valid json]")).toEqual([])
  })

  it("filters out items with empty title", () => {
    const input = '[{"title":"","description":"something"},{"title":"Valid","description":"task"}]'
    const items = parseSplitItems(input)
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe("Valid")
  })

  it("filters out items with missing fields", () => {
    const input = '[{"title":"Only title"},{"description":"Only desc"},{"title":"Good","description":"Complete"}]'
    const items = parseSplitItems(input)
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe("Good")
  })

  it("returns empty array for non-array JSON", () => {
    expect(parseSplitItems('{"title":"not array"}')).toEqual([])
  })

  it("handles multiple items", () => {
    const input = JSON.stringify([
      { title: "Item 1", description: "First task" },
      { title: "Item 2", description: "Second task" },
      { title: "Item 3", description: "Third task" },
    ])
    const items = parseSplitItems(input)
    expect(items).toHaveLength(3)
  })
})

describe("buildSplitChildPrompt", () => {
  const conversation: TopicMessage[] = [
    { role: "user", text: "Refactor the auth system" },
    { role: "assistant", text: "I found three areas to improve:\n1. Token validation\n2. Session store\n3. Refresh tokens" },
    { role: "user", text: "Looks good, proceed with all three" },
  ]

  const items = [
    { title: "Token validation", description: "Extract token validation into middleware" },
    { title: "Session store", description: "Replace session store with Redis adapter" },
    { title: "Refresh tokens", description: "Add refresh token rotation endpoint" },
  ]

  it("includes original request", () => {
    const prompt = buildSplitChildPrompt(conversation, items[0], items)
    expect(prompt).toContain("Refactor the auth system")
  })

  it("includes the assigned sub-task", () => {
    const prompt = buildSplitChildPrompt(conversation, items[0], items)
    expect(prompt).toContain("Your assigned sub-task: Token validation")
    expect(prompt).toContain("Extract token validation into middleware")
  })

  it("lists sibling tasks in scope constraints", () => {
    const prompt = buildSplitChildPrompt(conversation, items[0], items)
    expect(prompt).toContain("Session store")
    expect(prompt).toContain("Refresh tokens")
    expect(prompt).not.toMatch(/^- Token validation$/m)
  })

  it("includes planning thread context", () => {
    const prompt = buildSplitChildPrompt(conversation, items[1], items)
    expect(prompt).toContain("Planning thread")
    expect(prompt).toContain("three areas to improve")
  })

  it("truncates long assistant messages", () => {
    const longConversation: TopicMessage[] = [
      { role: "user", text: "Do stuff" },
      { role: "assistant", text: "x".repeat(5000) },
    ]
    const prompt = buildSplitChildPrompt(longConversation, items[0], items)
    expect(prompt).toContain("[earlier output truncated]")
  })

  it("handles single-message conversation", () => {
    const short: TopicMessage[] = [{ role: "user", text: "Do the thing" }]
    const prompt = buildSplitChildPrompt(short, items[0], items)
    expect(prompt).toContain("Do the thing")
    expect(prompt).not.toContain("Planning thread")
  })
})

describe("getClaudeConfigDir", () => {
  it("returns CLAUDE_CONFIG_DIR from env when set", () => {
    const env = { CLAUDE_CONFIG_DIR: "/custom/config", HOME: "/home/user" }
    const result = getClaudeConfigDir(env, () => false)
    expect(result).toBe("/custom/config")
  })

  it("returns /workspace/home/.claude when it exists and CLAUDE_CONFIG_DIR not set", () => {
    const env = { HOME: "/home/user" }
    const fsExists = (p: string) => p === "/workspace/home/.claude"
    const result = getClaudeConfigDir(env, fsExists)
    expect(result).toBe("/workspace/home/.claude")
  })

  it("prefers CLAUDE_CONFIG_DIR over /workspace/home/.claude", () => {
    const env = { CLAUDE_CONFIG_DIR: "/custom/config", HOME: "/home/user" }
    const fsExists = (p: string) => p === "/workspace/home/.claude"
    const result = getClaudeConfigDir(env, fsExists)
    expect(result).toBe("/custom/config")
  })

  it("falls back to HOME/.claude when /workspace/home/.claude does not exist", () => {
    const env = { HOME: "/home/testuser" }
    const fsExists = () => false
    const result = getClaudeConfigDir(env, fsExists)
    expect(result).toBe("/home/testuser/.claude")
  })

  it("uses /root as default HOME when HOME not set", () => {
    const env = {}
    const fsExists = () => false
    const result = getClaudeConfigDir(env, fsExists)
    expect(result).toBe("/root/.claude")
  })

  it("handles empty CLAUDE_CONFIG_DIR by checking filesystem", () => {
    const env = { CLAUDE_CONFIG_DIR: "", HOME: "/home/user" }
    const fsExists = (p: string) => p === "/workspace/home/.claude"
    const result = getClaudeConfigDir(env, fsExists)
    // Empty string is falsy, so it should check filesystem
    expect(result).toBe("/workspace/home/.claude")
  })
})
