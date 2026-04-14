import { describe, it, expect } from "vitest"
import {
  formatThinkStart,
  formatThinkIteration,
  formatThinkComplete,
  formatStats,
  formatQuotaSleep,
  formatDagStart,
  formatDagAllDone,
  formatDagNodeSkipped,
  formatPinnedStatus,
} from "../src/telegram/format.js"

describe("formatThinkStart", () => {
  it("includes repo, slug, task, and instructions", () => {
    const result = formatThinkStart("org/repo", "bold-lion", "Investigate auth")
    expect(result).toContain("org/repo")
    expect(result).toContain("bold-lion")
    expect(result).toContain("Investigate auth")
    expect(result).toContain("Deep research started")
  })

  it("escapes HTML in task text", () => {
    const result = formatThinkStart("org/repo", "slug", "<script>alert(1)</script>")
    expect(result).not.toContain("<script>")
    expect(result).toContain("&lt;script&gt;")
  })

  it("truncates long task text", () => {
    const result = formatThinkStart("org/repo", "slug", "x".repeat(500))
    expect(result).not.toContain("x".repeat(500))
  })
})

describe("formatThinkIteration", () => {
  it("includes slug and iteration number", () => {
    const result = formatThinkIteration("bold-lion", 3)
    expect(result).toContain("bold-lion")
    expect(result).toContain("3")
    expect(result).toContain("Thinking deeper")
  })
})

describe("formatThinkComplete", () => {
  it("includes slug and follow-up instructions", () => {
    const result = formatThinkComplete("bold-lion")
    expect(result).toContain("Research complete")
    expect(result).toContain("/reply")
    expect(result).toContain("/execute")
  })
})

describe("formatStats", () => {
  it("formats all stat fields", () => {
    const result = formatStats({
      totalSessions: 10, completedSessions: 8, erroredSessions: 2,
      totalTokens: 50000, totalDurationMs: 3600000, avgDurationMs: 360000,
    })
    expect(result).toContain("10 total")
    expect(result).toContain("8 completed")
    expect(result).toContain("50,000")
  })

  it("shows n/a for avg when no completed sessions", () => {
    const result = formatStats({
      totalSessions: 0, completedSessions: 0, erroredSessions: 0,
      totalTokens: 0, totalDurationMs: 0, avgDurationMs: 0,
    })
    expect(result).toContain("n/a")
  })
})

describe("formatQuotaSleep", () => {
  it("includes slug, minutes, and attempt info", () => {
    const result = formatQuotaSleep("bold-lion", 300000, 1, 3)
    expect(result).toContain("bold-lion")
    expect(result).toContain("5 min")
    expect(result).toContain("attempt 1/3")
    expect(result).toContain("Quota exhausted")
  })
})

describe("formatDagStart", () => {
  it("formats DAG mode with dependency arrows", () => {
    const children = [
      { slug: "auth", title: "Auth module", dependsOn: [] as string[] },
      { slug: "api", title: "API layer", dependsOn: ["auth"] },
    ]
    const result = formatDagStart("parent", children, false)
    expect(result).toContain("DAG: 2 tasks")
    expect(result).toContain("← auth")
    expect(result).toContain("parallel")
  })

  it("formats stack mode with sequential label and status icons", () => {
    const children = [
      { slug: "a", title: "A", dependsOn: [] as string[] },
      { slug: "b", title: "B", dependsOn: ["a"] },
    ]
    const result = formatDagStart("parent", children, true)
    expect(result).toContain("Stack: 2 tasks")
    expect(result).toContain("sequentially")
    expect(result).toContain("⚡")
    expect(result).toContain("⏳")
  })
})

describe("formatDagAllDone", () => {
  it("omits failed suffix when none failed", () => {
    const result = formatDagAllDone(5, 5, 0)
    expect(result).toContain("5/5 succeeded")
    expect(result).not.toContain("failed")
  })

  it("includes failed count when > 0", () => {
    const result = formatDagAllDone(3, 5, 2)
    expect(result).toContain("2 failed")
  })
})

describe("formatDagNodeSkipped", () => {
  it("escapes HTML in title and reason", () => {
    const result = formatDagNodeSkipped("<b>bad</b>", "<script>")
    expect(result).toContain("&lt;b&gt;")
    expect(result).toContain("Skipped")
  })
})

describe("formatPinnedStatus", () => {
  it("shows working status with correct icon", () => {
    const result = formatPinnedStatus("bold-lion", "org/repo", "working")
    expect(result).toContain("⚡")
    expect(result).toContain("Working")
    expect(result).toContain("bold-lion")
  })

  it("shows completed status with PR link", () => {
    const result = formatPinnedStatus("s", "r", "completed", "https://github.com/o/r/pull/42")
    expect(result).toContain("✅")
    expect(result).toContain("#42")
  })

  it("shows errored icon and extra label when no PR", () => {
    expect(formatPinnedStatus("s", "r", "errored")).toContain("❌")
    const extra = formatPinnedStatus("s", "r", "working", undefined, { label: "auth", state: "run" })
    expect(extra).toContain("auth")
  })
})
