import { describe, it, expect } from "vitest"
import { generateSlug, taskToLabel } from "../src/slugs.js"

describe("generateSlug", () => {
  it("returns an adjective-noun pair separated by a hyphen", () => {
    const slug = generateSlug("test-seed")
    expect(slug).toMatch(/^[a-z]+-[a-z]+$/)
  })

  it("is deterministic — same seed produces same slug", () => {
    const a = generateSlug("deterministic-seed")
    const b = generateSlug("deterministic-seed")
    expect(a).toBe(b)
  })

  it("produces different slugs for different seeds", () => {
    const a = generateSlug("seed-alpha")
    const b = generateSlug("seed-beta")
    expect(a).not.toBe(b)
  })

  it("handles empty string seed", () => {
    const slug = generateSlug("")
    expect(slug).toMatch(/^[a-z]+-[a-z]+$/)
  })

  it("handles UUID-style seeds", () => {
    const slug = generateSlug("550e8400-e29b-41d4-a716-446655440000")
    expect(slug).toMatch(/^[a-z]+-[a-z]+$/)
  })
})

describe("taskToLabel", () => {
  it("extracts kebab-case label from a task description", () => {
    expect(taskToLabel("Fix the login button styling")).toBe("fix-the-login-button-styling")
  })

  it("strips URLs and uses remaining words", () => {
    expect(taskToLabel("https://github.com/org/repo Fix auth bug")).toBe("fix-auth-bug")
  })

  it("returns 'task' for URL-only input", () => {
    expect(taskToLabel("https://github.com/org/repo")).toBe("task")
  })

  it("returns 'task' for empty input", () => {
    expect(taskToLabel("")).toBe("task")
  })

  it("limits to 5 words", () => {
    expect(taskToLabel("one two three four five six seven")).toBe("one-two-three-four-five")
  })

  it("truncates to maxLen", () => {
    const label = taskToLabel("implement the new authentication flow redesign", 20)
    expect(label.length).toBeLessThanOrEqual(20)
    expect(label).toBe("implement-the-new")
  })

  it("filters single-character words", () => {
    expect(taskToLabel("add a new b feature")).toBe("add-new-feature")
  })

  it("handles special characters", () => {
    expect(taskToLabel("fix bug #123 — refactor!")).toBe("fix-bug-123-refactor")
  })

  it("handles kebab-case input as-is", () => {
    expect(taskToLabel("fix-auth-bug")).toBe("fix-auth-bug")
  })

  it("lowercases everything", () => {
    expect(taskToLabel("Fix The LOGIN Button")).toBe("fix-the-login-button")
  })

  it("returns 'task' for whitespace-only input", () => {
    expect(taskToLabel("   ")).toBe("task")
  })

  it("does not end with a trailing hyphen after truncation", () => {
    const label = taskToLabel("alpha bravo charlie delta echo", 12)
    expect(label).not.toMatch(/-$/)
  })
})
