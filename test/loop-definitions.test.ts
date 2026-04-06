import { describe, it, expect } from "vitest"
import { DEFAULT_LOOPS } from "../src/loops/loop-definitions.js"

describe("DEFAULT_LOOPS", () => {
  it("contains exactly 4 loop definitions", () => {
    expect(DEFAULT_LOOPS).toHaveLength(4)
  })

  it("has unique ids", () => {
    const ids = DEFAULT_LOOPS.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("has unique names", () => {
    const names = DEFAULT_LOOPS.map((l) => l.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it("all definitions are enabled by default", () => {
    for (const def of DEFAULT_LOOPS) {
      expect(def.enabled).toBe(true)
    }
  })

  it("all definitions have positive intervalMs", () => {
    for (const def of DEFAULT_LOOPS) {
      expect(def.intervalMs).toBeGreaterThan(0)
    }
  })

  it("all definitions have non-empty prompts", () => {
    for (const def of DEFAULT_LOOPS) {
      expect(def.prompt.length).toBeGreaterThan(100)
    }
  })

  it("all prompts mention post-task-router", () => {
    for (const def of DEFAULT_LOOPS) {
      expect(def.prompt).toContain("post-task-router")
    }
  })

  it("all prompts enforce single-item scope", () => {
    for (const def of DEFAULT_LOOPS) {
      expect(def.prompt.toLowerCase()).toContain("exactly one")
    }
  })

  it("all definitions have maxConsecutiveFailures set", () => {
    for (const def of DEFAULT_LOOPS) {
      expect(def.maxConsecutiveFailures).toBeGreaterThan(0)
    }
  })

  it("includes expected loop ids", () => {
    const ids = DEFAULT_LOOPS.map((l) => l.id)
    expect(ids).toContain("test-coverage")
    expect(ids).toContain("type-safety")
    expect(ids).toContain("dead-code")
    expect(ids).toContain("todo-resolver")
  })

  it("test-coverage runs every 8 hours", () => {
    const def = DEFAULT_LOOPS.find((l) => l.id === "test-coverage")!
    expect(def.intervalMs).toBe(8 * 60 * 60 * 1000)
  })

  it("dead-code runs every 24 hours", () => {
    const def = DEFAULT_LOOPS.find((l) => l.id === "dead-code")!
    expect(def.intervalMs).toBe(24 * 60 * 60 * 1000)
  })

  it("type-safety runs every 12 hours", () => {
    const def = DEFAULT_LOOPS.find((l) => l.id === "type-safety")!
    expect(def.intervalMs).toBe(12 * 60 * 60 * 1000)
  })

  it("repo defaults to empty string for all definitions", () => {
    for (const def of DEFAULT_LOOPS) {
      expect(def.repo).toBe("")
    }
  })
})
