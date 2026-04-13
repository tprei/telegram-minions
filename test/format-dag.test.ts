import { describe, it, expect } from "vitest"
import {
  formatDagStart,
  formatDagNodeSkipped,
  formatDagAllDone,
  formatDagCIWaiting,
  formatDagCIFailed,
  formatDagForceAdvance,
} from "../src/telegram/format.js"

describe("formatDagStart", () => {
  it("renders DAG mode with dependency indicators", () => {
    const children = [
      { slug: "fox-1", title: "Add auth", dependsOn: [] },
      { slug: "fox-2", title: "Add routes", dependsOn: ["fox-1"] },
    ]
    const result = formatDagStart("my-slug", children, false)

    expect(result).toContain("DAG: 2 tasks")
    expect(result).toContain("🔗")
    expect(result).toContain("<code>my-slug</code>")
    expect(result).toContain("⚡")
    expect(result).toContain("fox-1")
    expect(result).toContain("⏳")
    expect(result).toContain("fox-2")
    expect(result).toContain("← fox-1")
    expect(result).toContain("Tasks run in dependency order")
  })

  it("renders Stack mode when isStack is true", () => {
    const children = [
      { slug: "s-1", title: "Step one", dependsOn: [] },
    ]
    const result = formatDagStart("stack-slug", children, true)

    expect(result).toContain("Stack: 1 tasks")
    expect(result).toContain("📚")
    expect(result).toContain("Tasks run sequentially")
  })

  it("escapes HTML in titles and slugs", () => {
    const children = [
      { slug: "a&b", title: "Fix <tag>", dependsOn: [] },
    ]
    const result = formatDagStart("s<x>", children, false)

    expect(result).toContain("s&lt;x&gt;")
    expect(result).toContain("a&amp;b")
    expect(result).toContain("Fix &lt;tag&gt;")
  })

  it("shows multiple dependencies", () => {
    const children = [
      { slug: "a", title: "A", dependsOn: [] },
      { slug: "b", title: "B", dependsOn: [] },
      { slug: "c", title: "C", dependsOn: ["a", "b"] },
    ]
    const result = formatDagStart("slug", children, false)

    expect(result).toContain("← a, b")
  })
})

describe("formatDagNodeSkipped", () => {
  it("formats a skipped node message", () => {
    const result = formatDagNodeSkipped("Add caching", "dependency failed")
    expect(result).toContain("Skipped")
    expect(result).toContain("Add caching")
    expect(result).toContain("dependency failed")
  })

  it("escapes HTML in title and reason", () => {
    const result = formatDagNodeSkipped("Fix <bug>", "dep <a> failed")
    expect(result).toContain("Fix &lt;bug&gt;")
    expect(result).toContain("dep &lt;a&gt; failed")
  })
})

describe("formatDagAllDone", () => {
  it("formats success without failures", () => {
    const result = formatDagAllDone(3, 3, 0)
    expect(result).toContain("DAG complete")
    expect(result).toContain("3/3 succeeded")
    expect(result).not.toContain("failed")
  })

  it("includes failure count when > 0", () => {
    const result = formatDagAllDone(2, 3, 1)
    expect(result).toContain("2/3 succeeded")
    expect(result).toContain("1 failed")
  })
})

describe("formatDagCIWaiting", () => {
  it("formats waiting message with PR link", () => {
    const result = formatDagCIWaiting("fox-1", "Add auth", "https://github.com/o/r/pull/1")
    expect(result).toContain("fox-1")
    expect(result).toContain("waiting for CI")
    expect(result).toContain("Add auth")
    expect(result).toContain('href="https://github.com/o/r/pull/1"')
  })
})

describe("formatDagCIFailed", () => {
  it("shows block message for block policy", () => {
    const result = formatDagCIFailed("fox-1", "Add auth", "https://github.com/o/r/pull/1", "block")
    expect(result).toContain("CI failed")
    expect(result).toContain("fox-1")
    expect(result).toContain("Dependents blocked")
    expect(result).toContain("/force")
  })

  it("shows proceed message for warn policy", () => {
    const result = formatDagCIFailed("fox-1", "Add auth", "https://github.com/o/r/pull/1", "warn")
    expect(result).toContain("CI failed")
    expect(result).toContain("Proceeding with dependents")
    expect(result).toContain("policy: warn")
  })
})

describe("formatDagForceAdvance", () => {
  it("formats force-advance message", () => {
    const result = formatDagForceAdvance("Add auth", "node-1")
    expect(result).toContain("Force-advancing")
    expect(result).toContain("Add auth")
    expect(result).toContain("node-1")
  })

  it("escapes HTML in node title", () => {
    const result = formatDagForceAdvance("Fix <bug>", "n-1")
    expect(result).toContain("Fix &lt;bug&gt;")
  })
})
