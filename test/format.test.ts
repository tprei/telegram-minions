import { describe, it, expect } from "vitest"
import {
  esc,
  truncate,
  formatToolLine,
  formatActivityLog,
  formatToolActivity,
  formatSessionStart,
  formatSessionComplete,
  formatSessionError,
  formatSessionInterrupted,
  formatAssistantText,
  formatAssistantTextChunks,
  formatPlanStart,
  formatPlanIteration,
  formatPlanExecuting,
  formatPlanComplete,
  formatReviewStart,
  formatReviewIteration,
  formatReviewComplete,
  formatTaskComplete,
  formatFollowUpIteration,
  formatStatus,
  formatHelp,
  formatQualityReport,
  formatQualityReportForContext,
  formatSplitAnalyzing,
  formatSplitStart,
  formatSplitChildComplete,
  formatSplitAllDone,
  formatCIConflicts,
  formatCIResolvingConflicts,
  formatCINoChecks,
  formatUsage,
  formatDagNodeComplete,
  formatDagNodeStarting,
  formatShipThinkStart,
  formatShipPlanStart,
  formatShipVerifyStart,
  formatShipPhaseAdvance,
  formatShipComplete,
  threadLink,
  formatPinnedSplitStatus,
  formatPinnedDagStatus,
} from "../src/format.js"
import type { ClaudeUsageResponse } from "../src/claude-usage.js"
import type { AggregateStats, SessionRecord, ModeBreakdown } from "../src/stats.js"

describe("esc", () => {
  it("escapes &, <, and >", () => {
    expect(esc("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d")
  })

  it("returns empty string unchanged", () => {
    expect(esc("")).toBe("")
  })

  it("leaves safe text untouched", () => {
    expect(esc("hello world")).toBe("hello world")
  })
})

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello")
  })

  it("truncates long strings and appends ellipsis", () => {
    const result = truncate("hello world", 5)
    expect(result).toBe("hello…")
    expect(result.length).toBe(6)
  })

  it("handles exact boundary", () => {
    expect(truncate("hello", 5)).toBe("hello")
  })
})

describe("formatToolLine", () => {
  it("formats a Bash tool with command summary", () => {
    const line = formatToolLine("Bash", { command: "npm test" })
    expect(line).toContain("💻")
    expect(line).toContain("npm test")
  })

  it("formats a Read tool with file path", () => {
    const line = formatToolLine("Read", { file_path: "/src/main.ts" })
    expect(line).toContain("📖")
    expect(line).toContain("/src/main.ts")
  })

  it("formats an Edit tool with file path", () => {
    const line = formatToolLine("Edit", { file_path: "/src/app.ts" })
    expect(line).toContain("✏️")
    expect(line).toContain("/src/app.ts")
  })

  it("formats a Grep tool with pattern", () => {
    const line = formatToolLine("Grep", { pattern: "TODO" })
    expect(line).toContain("🔍")
    expect(line).toContain("TODO")
  })

  it("formats a Glob tool with pattern", () => {
    const line = formatToolLine("Glob", { pattern: "**/*.ts" })
    expect(line).toContain("📂")
    expect(line).toContain("**/*.ts")
  })

  it("formats a browser_take_screenshot tool with icon", () => {
    const line = formatToolLine("browser_take_screenshot", {})
    expect(line).toContain("📸")
  })

  it("formats a browser_navigate tool with URL", () => {
    const line = formatToolLine("mcp__playwright__browser_navigate", { url: "https://example.com" })
    expect(line).toContain("https://example.com")
  })

  it("uses generic icon for unknown tools", () => {
    const line = formatToolLine("CustomTool", {})
    expect(line).toContain("🔧")
    expect(line).toContain("CustomTool")
  })

  it("truncates long command summaries", () => {
    const longCmd = "a".repeat(100)
    const line = formatToolLine("Bash", { command: longCmd })
    expect(line.length).toBeLessThan(120)
  })

  it("escapes HTML in summaries", () => {
    const line = formatToolLine("Bash", { command: "echo <script>" })
    expect(line).toContain("&lt;script&gt;")
    expect(line).not.toContain("<script>")
  })
})

describe("formatActivityLog", () => {
  it("includes header with tool count", () => {
    const log = formatActivityLog(["line1"], 1)
    expect(log).toContain("🔧")
    expect(log).toContain("1 tool")
    expect(log).not.toContain("tools")
  })

  it("pluralizes tool count", () => {
    const log = formatActivityLog(["a", "b"], 5)
    expect(log).toContain("5 tools")
  })
})

describe("formatToolActivity", () => {
  it("includes tool count when > 1", () => {
    const result = formatToolActivity("Bash", { command: "ls" }, 3)
    expect(result).toContain("(3 tools)")
  })

  it("omits tool count when 1", () => {
    const result = formatToolActivity("Bash", { command: "ls" }, 1)
    expect(result).not.toContain("(1 tool")
  })
})

describe("formatSessionStart", () => {
  it("includes repo, slug, and task", () => {
    const msg = formatSessionStart("my-repo", "bold-arc", "fix the bug")
    expect(msg).toContain("my-repo")
    expect(msg).toContain("bold-arc")
    expect(msg).toContain("fix the bug")
    expect(msg).toContain("Session started")
  })

  it("truncates long tasks", () => {
    const longTask = "x".repeat(300)
    const msg = formatSessionStart("repo", "slug", longTask)
    expect(msg).toContain("…")
  })
})

describe("formatSessionComplete", () => {
  it("formats duration in seconds", () => {
    const msg = formatSessionComplete("bold-arc", 45000, null)
    expect(msg).toContain("45s")
    expect(msg).toContain("Complete")
  })

  it("formats duration in minutes and seconds", () => {
    const msg = formatSessionComplete("bold-arc", 125000, null)
    expect(msg).toContain("2m 5s")
  })

  it("includes token count when provided", () => {
    const msg = formatSessionComplete("bold-arc", 60000, 1500)
    expect(msg).toContain("1,500 tokens")
  })

  it("omits token count when null", () => {
    const msg = formatSessionComplete("bold-arc", 60000, null)
    expect(msg).not.toContain("tokens")
  })
})

describe("formatSessionError", () => {
  it("includes slug and error message", () => {
    const msg = formatSessionError("bold-arc", "process crashed")
    expect(msg).toContain("bold-arc")
    expect(msg).toContain("process crashed")
    expect(msg).toContain("Error")
  })

  it("truncates long error messages", () => {
    const longErr = "e".repeat(500)
    const msg = formatSessionError("slug", longErr)
    expect(msg).toContain("…")
  })
})

describe("formatSessionInterrupted", () => {
  it("includes slug", () => {
    const msg = formatSessionInterrupted("bold-arc")
    expect(msg).toContain("bold-arc")
    expect(msg).toContain("interrupted")
  })
})

describe("formatAssistantText", () => {
  it("includes slug and text", () => {
    const msg = formatAssistantText("bold-arc", "Here is my analysis")
    expect(msg).toContain("bold-arc")
    expect(msg).toContain("Here is my analysis")
    expect(msg).toContain("Reply")
  })

  it("includes tool count when provided", () => {
    const msg = formatAssistantText("slug", "text", undefined, 5)
    expect(msg).toContain("5 tools")
  })

  it("includes tool lines when provided", () => {
    const msg = formatAssistantText("slug", "text", ["📖 file.ts"], 1)
    expect(msg).toContain("📖 file.ts")
  })
})

describe("formatAssistantTextChunks", () => {
  it("returns single chunk for short text", () => {
    const chunks = formatAssistantTextChunks("slug", "Short text")
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain("Short text")
    expect(chunks[0]).not.toContain("(1/1)")
  })

  it("splits long text into multiple chunks with headers", () => {
    // Create text that needs splitting (multiple paragraphs)
    const paragraphs = []
    for (let i = 0; i < 10; i++) {
      paragraphs.push(`Paragraph ${i}: ${"x".repeat(500)}`)
    }
    const longText = paragraphs.join("\n\n")

    const chunks = formatAssistantTextChunks("slug", longText)

    expect(chunks.length).toBeGreaterThan(1)
    // Each chunk should have header like "(1/N)"
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]).toContain(`(${i + 1}/${chunks.length})`)
    }
  })

  it("only first chunk includes tool activity", () => {
    const longText = "x".repeat(5000)
    const toolLines = ["📖 file.ts"]

    const chunks = formatAssistantTextChunks("slug", longText, toolLines, 1)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]).toContain("📖 file.ts")
    expect(chunks[0]).toContain("1 tool")
    // Subsequent chunks should not have tools
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]).not.toContain("📖 file.ts")
    }
  })

  it("respects paragraph boundaries when splitting", () => {
    // Create text with clear paragraph boundaries
    const text = [
      "First paragraph with some content here.",
      "Second paragraph with more content here.",
      "Third paragraph with even more content.",
    ].join("\n\n")

    const chunks = formatAssistantTextChunks("slug", text)

    // Should not split mid-word or mid-sentence if possible
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/paragraph\s*\n.*paragraph/i)
    }
  })

  it("escapes HTML in text", () => {
    const chunks = formatAssistantTextChunks("slug", "Text with <script>alert('xss')</script>")
    expect(chunks[0]).toContain("&lt;script&gt;")
    expect(chunks[0]).not.toContain("<script>")
  })
})

describe("formatPlanStart", () => {
  it("includes planning header and execute hint", () => {
    const msg = formatPlanStart("my-repo", "calm-bay", "plan the feature")
    expect(msg).toContain("Planning started")
    expect(msg).toContain("my-repo")
    expect(msg).toContain("calm-bay")
    expect(msg).toContain("/execute")
  })
})

describe("formatPlanIteration", () => {
  it("includes iteration number", () => {
    const msg = formatPlanIteration("calm-bay", 3)
    expect(msg).toContain("calm-bay")
    expect(msg).toContain("iteration 3")
    expect(msg).toContain("Refining plan")
  })
})

describe("formatPlanExecuting", () => {
  it("includes both slugs", () => {
    const msg = formatPlanExecuting("calm-bay", "starting…")
    expect(msg).toContain("calm-bay")
    expect(msg).toContain("Executing plan")
  })
})

describe("formatPlanComplete", () => {
  it("includes slug and next-step hint", () => {
    const msg = formatPlanComplete("calm-bay")
    expect(msg).toContain("calm-bay")
    expect(msg).toContain("Plan complete")
    expect(msg).toContain("/execute")
  })
})

describe("formatTaskComplete", () => {
  it("includes duration and feedback hint", () => {
    const msg = formatTaskComplete("bold-arc", 90000, 2000)
    expect(msg).toContain("1m 30s")
    expect(msg).toContain("2,000 tokens")
    expect(msg).toContain("/reply")
  })
})

describe("formatFollowUpIteration", () => {
  it("includes iteration number", () => {
    const msg = formatFollowUpIteration("bold-arc", 2)
    expect(msg).toContain("Follow-up")
    expect(msg).toContain("iteration 2")
  })
})

describe("formatStatus", () => {
  it("shows empty state", () => {
    const msg = formatStatus([], [], 5)
    expect(msg).toContain("0/5 slots")
    expect(msg).toContain("No active sessions")
  })

  it("shows active task sessions", () => {
    const sessions = [{
      meta: { topicName: "bold-arc", repo: "my-repo", startedAt: Date.now() - 30000, mode: "task" },
      task: "fix the bug",
      handle: { isActive: () => true, getState: () => "working" },
    }]
    const msg = formatStatus(sessions, [], 5)
    expect(msg).toContain("1/5 slots")
    expect(msg).toContain("bold-arc")
    expect(msg).toContain("my-repo")
    expect(msg).toContain("working")
    expect(msg).toContain("🟢")
  })

  it("shows inactive sessions with red indicator", () => {
    const sessions = [{
      meta: { topicName: "bold-arc", repo: "my-repo", startedAt: Date.now(), mode: "task" },
      task: "fix the bug",
      handle: { isActive: () => false, getState: () => "completed" },
    }]
    const msg = formatStatus(sessions, [], 5)
    expect(msg).toContain("🔴")
  })

  it("shows standby topic sessions awaiting feedback", () => {
    const topicSessions = [{
      slug: "calm-bay",
      repo: "my-repo",
      conversation: [{ role: "user", text: "plan the feature" }],
      activeSessionId: undefined,
    }]
    const msg = formatStatus([], topicSessions, 5)
    expect(msg).toContain("calm-bay")
    expect(msg).toContain("awaiting feedback")
  })

  it("excludes active topic sessions from standby list", () => {
    const topicSessions = [{
      slug: "calm-bay",
      repo: "my-repo",
      conversation: [{ role: "user", text: "plan" }],
      activeSessionId: "some-uuid",
    }]
    const msg = formatStatus([], topicSessions, 5)
    expect(msg).not.toContain("calm-bay")
  })
})

describe("formatQualityReport", () => {
  it("returns empty string for no results", () => {
    expect(formatQualityReport([])).toBe("")
  })

  it("shows check icon when all pass", () => {
    const msg = formatQualityReport([
      { gate: "tests", passed: true, output: "" },
      { gate: "lint", passed: true, output: "" },
    ])
    expect(msg).toContain("✅")
    expect(msg).toContain("Quality gates")
  })

  it("shows warning icon when some fail", () => {
    const msg = formatQualityReport([
      { gate: "tests", passed: false, output: "FAIL src/app.test.ts" },
      { gate: "lint", passed: true, output: "" },
    ])
    expect(msg).toContain("⚠️")
    expect(msg).toContain("❌ tests")
    expect(msg).toContain("✅ lint")
  })

  it("includes failure output", () => {
    const msg = formatQualityReport([
      { gate: "tests", passed: false, output: "Expected 2 but got 3" },
    ])
    expect(msg).toContain("Expected 2 but got 3")
  })

  it("trims long failure output to last 500 chars", () => {
    const longOutput = "x".repeat(800)
    const msg = formatQualityReport([
      { gate: "tests", passed: false, output: longOutput },
    ])
    expect(msg).not.toContain("x".repeat(800))
  })
})

describe("formatQualityReportForContext", () => {
  it("includes header", () => {
    const msg = formatQualityReportForContext([
      { gate: "tests", passed: true, output: "" },
    ])
    expect(msg).toContain("## Quality gate results")
  })

  it("labels passing gates as PASSED", () => {
    const msg = formatQualityReportForContext([
      { gate: "lint", passed: true, output: "" },
    ])
    expect(msg).toContain("### lint: PASSED")
  })

  it("labels failing gates as FAILED", () => {
    const msg = formatQualityReportForContext([
      { gate: "tests", passed: false, output: "test error" },
    ])
    expect(msg).toContain("### tests: FAILED")
  })

  it("includes failure output in code blocks", () => {
    const msg = formatQualityReportForContext([
      { gate: "tests", passed: false, output: "Expected 2 got 3" },
    ])
    expect(msg).toContain("```")
    expect(msg).toContain("Expected 2 got 3")
  })

  it("does not include output for passing gates", () => {
    const msg = formatQualityReportForContext([
      { gate: "lint", passed: true, output: "all good" },
    ])
    expect(msg).not.toContain("all good")
    expect(msg).not.toContain("```")
  })

  it("trims long failure output to last 1500 chars", () => {
    const longOutput = "a".repeat(2000)
    const msg = formatQualityReportForContext([
      { gate: "tests", passed: false, output: longOutput },
    ])
    expect(msg).not.toContain("a".repeat(2000))
    expect(msg).toContain("a".repeat(1500))
  })

  it("includes fix instruction at the end", () => {
    const msg = formatQualityReportForContext([
      { gate: "tests", passed: false, output: "error" },
    ])
    expect(msg).toContain("Fix the failing quality gates before proceeding.")
  })

  it("handles mixed results", () => {
    const msg = formatQualityReportForContext([
      { gate: "tests", passed: false, output: "fail output" },
      { gate: "typecheck", passed: true, output: "" },
      { gate: "lint", passed: false, output: "lint error" },
    ])
    expect(msg).toContain("### tests: FAILED")
    expect(msg).toContain("### typecheck: PASSED")
    expect(msg).toContain("### lint: FAILED")
    expect(msg).toContain("fail output")
    expect(msg).toContain("lint error")
  })
})

describe("formatHelp", () => {
  it("includes top-level commands", () => {
    const msg = formatHelp()
    expect(msg).toContain("/task")
    expect(msg).toContain("/plan")
    expect(msg).toContain("/status")
    expect(msg).toContain("/help")
  })

  it("includes thread commands", () => {
    const msg = formatHelp()
    expect(msg).toContain("/reply")
    expect(msg).toContain("/execute")
    expect(msg).toContain("/close")
  })

  it("includes section headers", () => {
    const msg = formatHelp()
    expect(msg).toContain("Available commands")
    expect(msg).toContain("Inside a thread")
  })

  it("includes shorthand notation for reply", () => {
    const msg = formatHelp()
    expect(msg).toContain("/r text")
  })

  it("describes close as deleting the topic", () => {
    const msg = formatHelp()
    expect(msg).toContain("delete the topic")
  })

  it("includes /split command", () => {
    const msg = formatHelp()
    expect(msg).toContain("/split")
  })

  it("includes /review command", () => {
    const msg = formatHelp()
    expect(msg).toContain("/review")
  })

  it("includes /usage command", () => {
    const msg = formatHelp()
    expect(msg).toContain("/usage")
  })
})

describe("formatSplitAnalyzing", () => {
  it("includes slug and analyzing message", () => {
    const msg = formatSplitAnalyzing("calm-bay")
    expect(msg).toContain("calm-bay")
    expect(msg).toContain("Analyzing conversation")
  })
})

describe("formatSplitStart", () => {
  it("lists all children with titles", () => {
    const children = [
      { repo: "myrepo", slug: "bold-arc", title: "Add auth" },
      { repo: "myrepo", slug: "keen-elm", title: "Fix tests" },
    ]
    const msg = formatSplitStart("calm-bay", children)
    expect(msg).toContain("Split into 2 sub-tasks")
    expect(msg).toContain("calm-bay")
    expect(msg).toContain("bold-arc")
    expect(msg).toContain("keen-elm")
    expect(msg).toContain("Add auth")
    expect(msg).toContain("Fix tests")
  })
})

describe("formatSplitChildComplete", () => {
  it("shows success with PR link", () => {
    const msg = formatSplitChildComplete("bold-arc", "completed", "Add auth", "https://github.com/org/repo/pull/42")
    expect(msg).toContain("bold-arc")
    expect(msg).toContain("completed")
    expect(msg).toContain("Add auth")
    expect(msg).toContain("PR")
  })

  it("shows error without PR", () => {
    const msg = formatSplitChildComplete("bold-arc", "errored", "Add auth")
    expect(msg).toContain("❌")
    expect(msg).toContain("errored")
  })
})

describe("formatSplitAllDone", () => {
  it("shows succeeded count", () => {
    const msg = formatSplitAllDone(2, 3)
    expect(msg).toContain("2/3")
    expect(msg).toContain("Split complete")
  })
})

describe("formatReviewStart", () => {
  it("includes review header, repo, slug, and task", () => {
    const msg = formatReviewStart("my-repo", "cool-slug", "Review PR #42")
    expect(msg).toContain("Review started")
    expect(msg).toContain("my-repo")
    expect(msg).toContain("cool-slug")
    expect(msg).toContain("Review PR #42")
  })

  it("includes /reply instructions", () => {
    const msg = formatReviewStart("repo", "slug", "task")
    expect(msg).toContain("/reply")
  })
})

describe("formatReviewIteration", () => {
  it("includes slug and iteration number", () => {
    const msg = formatReviewIteration("cool-slug", 2)
    expect(msg).toContain("Re-reviewing")
    expect(msg).toContain("cool-slug")
    expect(msg).toContain("2")
  })
})

describe("formatReviewComplete", () => {
  it("includes slug and /reply instructions", () => {
    const msg = formatReviewComplete("cool-slug")
    expect(msg).toContain("Review complete")
    expect(msg).toContain("cool-slug")
    expect(msg).toContain("/reply")
  })
})

describe("formatShipThinkStart", () => {
  it("includes ship header, repo, slug, and task", () => {
    const msg = formatShipThinkStart("my-repo", "cool-slug", "Build auth system")
    expect(msg).toContain("Ship: researching")
    expect(msg).toContain("my-repo")
    expect(msg).toContain("cool-slug")
    expect(msg).toContain("Build auth system")
  })

  it("includes auto-advance description", () => {
    const msg = formatShipThinkStart("repo", "slug", "task")
    expect(msg).toContain("Auto-advancing")
  })

  it("truncates long tasks", () => {
    const longTask = "x".repeat(300)
    const msg = formatShipThinkStart("repo", "slug", longTask)
    expect(msg).toContain("\u2026")
  })
})

describe("formatShipPlanStart", () => {
  it("includes ship planning header", () => {
    const msg = formatShipPlanStart("my-repo", "cool-slug", "Build auth system")
    expect(msg).toContain("Ship: planning")
    expect(msg).toContain("my-repo")
    expect(msg).toContain("implementation plan")
  })
})

describe("formatShipVerifyStart", () => {
  it("includes ship verify header", () => {
    const msg = formatShipVerifyStart("my-repo", "cool-slug", "Build auth system")
    expect(msg).toContain("Ship: verifying")
    expect(msg).toContain("quality gates")
  })
})

describe("formatShipPhaseAdvance", () => {
  it("shows phase transition", () => {
    const msg = formatShipPhaseAdvance("cool-slug", "think", "plan")
    expect(msg).toContain("think complete")
    expect(msg).toContain("plan")
    expect(msg).toContain("cool-slug")
  })
})

describe("formatShipComplete", () => {
  it("shows success when all passed", () => {
    const msg = formatShipComplete("cool-slug", 3, 0, 3)
    expect(msg).toContain("Ship complete")
    expect(msg).toContain("All 3 node(s) verified")
    expect(msg).toContain("\u2705")
  })

  it("shows warning when some failed", () => {
    const msg = formatShipComplete("cool-slug", 2, 1, 3)
    expect(msg).toContain("2/3")
    expect(msg).toContain("1 failed")
    expect(msg).toContain("\u26a0\ufe0f")
  })
})

describe("formatStatus (review mode)", () => {
  it("displays review mode icon", () => {
    const msg = formatStatus(
      [{
        meta: { topicName: "review-slug", repo: "repo", startedAt: Date.now(), mode: "review" },
        task: "Review PR #42",
        handle: { isActive: () => true, getState: () => "working" },
      }],
      [],
      5,
    )
    expect(msg).toContain("👀 review")
  })
})

describe("formatCIConflicts", () => {
  it("includes slug, PR number, and conflict message", () => {
    const msg = formatCIConflicts("test-slug", "https://github.com/org/repo/pull/42")
    expect(msg).toContain("Merge conflicts")
    expect(msg).toContain("test-slug")
    expect(msg).toContain("PR #42")
    expect(msg).toContain("CI cannot run until conflicts are resolved")
  })
})

describe("formatCIResolvingConflicts", () => {
  it("includes slug, PR number, and attempt info", () => {
    const msg = formatCIResolvingConflicts("test-slug", "https://github.com/org/repo/pull/42", 1, 3)
    expect(msg).toContain("Resolving conflicts")
    expect(msg).toContain("test-slug")
    expect(msg).toContain("PR #42")
    expect(msg).toContain("attempt 1/3")
  })

  it("shows correct attempt numbers", () => {
    const msg = formatCIResolvingConflicts("test-slug", "https://github.com/org/repo/pull/42", 2, 5)
    expect(msg).toContain("attempt 2/5")
  })
})

describe("formatCINoChecks", () => {
  it("includes slug, PR number, and timeout message", () => {
    const msg = formatCINoChecks("test-slug", "https://github.com/org/repo/pull/99")
    expect(msg).toContain("No CI checks found")
    expect(msg).toContain("test-slug")
    expect(msg).toContain("PR #99")
    expect(msg).toContain("Timed out waiting for checks")
  })
})

describe("formatUsage", () => {
  const mockAgg: AggregateStats = {
    totalSessions: 10,
    completedSessions: 8,
    erroredSessions: 2,
    totalTokens: 500000,
    totalDurationMs: 600000,
    avgDurationMs: 60000,
  }

  const mockBreakdown: Record<string, ModeBreakdown> = {
    task: { count: 7, tokens: 400000, durationMs: 420000 },
    plan: { count: 3, tokens: 100000, durationMs: 180000 },
  }

  const mockRecent: SessionRecord[] = [
    { slug: "bold-arc", repo: "my-repo", mode: "task", state: "completed", totalTokens: 45000, durationMs: 720000, timestamp: Date.now() },
    { slug: "calm-bay", repo: "other-repo", mode: "plan", state: "completed", totalTokens: 23000, durationMs: 480000, timestamp: Date.now() - 60000 },
  ]

  it("shows local stats without ACP usage", () => {
    const result = formatUsage(null, mockAgg, mockBreakdown, mockRecent)
    expect(result).toContain("📊")
    expect(result).toContain("10 sessions")
    expect(result).toContain("500K tokens")
    expect(result).toContain("task: 7 sessions")
    expect(result).toContain("plan: 3 sessions")
    expect(result).toContain("bold-arc")
    expect(result).toContain("calm-bay")
    expect(result).not.toContain("Claude ACP")
  })

  it("shows ACP usage when available", () => {
    const acpUsage: ClaudeUsageResponse = {
      five_hour: { utilization: 35, resets_at: new Date(Date.now() + 7200000).toISOString() },
      seven_day: { utilization: 25, resets_at: new Date(Date.now() + 400000000).toISOString() },
      seven_day_opus: { utilization: 8, resets_at: null },
      seven_day_sonnet: { utilization: 12, resets_at: new Date(Date.now() + 300000000).toISOString() },
      extra_usage: null,
    }
    const result = formatUsage(acpUsage, mockAgg, mockBreakdown, mockRecent)
    expect(result).toContain("Claude ACP")
    expect(result).toContain("5h:")
    expect(result).toContain("35%")
    expect(result).toContain("7d:")
    expect(result).toContain("25%")
    expect(result).toContain("7d opus:")
    expect(result).toContain("8%")
  })

  it("shows extra usage when enabled", () => {
    const acpUsage: ClaudeUsageResponse = {
      five_hour: { utilization: 10, resets_at: null },
      seven_day: { utilization: 20, resets_at: null },
      seven_day_opus: { utilization: 0, resets_at: null },
      seven_day_sonnet: { utilization: 0, resets_at: null },
      extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 12.5, utilization: null },
    }
    const result = formatUsage(acpUsage, mockAgg, mockBreakdown, mockRecent)
    expect(result).toContain("extra:")
    expect(result).toContain("$12.50")
    expect(result).toContain("$100")
  })

  it("handles empty state gracefully", () => {
    const emptyAgg: AggregateStats = {
      totalSessions: 0, completedSessions: 0, erroredSessions: 0,
      totalTokens: 0, totalDurationMs: 0, avgDurationMs: 0,
    }
    const result = formatUsage(null, emptyAgg, {}, [])
    expect(result).toContain("0 sessions")
    expect(result).not.toContain("Recent sessions")
  })
})

describe("formatDagNodeComplete", () => {
  it("shows error emoji for errored state", () => {
    const result = formatDagNodeComplete("my-slug", "errored", "My Task")
    expect(result).toContain("❌")
  })

  it("shows error emoji for failed state", () => {
    const result = formatDagNodeComplete("my-slug", "failed", "My Task")
    expect(result).toContain("❌")
  })

  it("shows success emoji for completed state", () => {
    const result = formatDagNodeComplete("my-slug", "completed", "My Task")
    expect(result).toContain("✅")
  })

  it("includes PR link when provided", () => {
    const result = formatDagNodeComplete("my-slug", "completed", "My Task", "https://github.com/org/repo/pull/42")
    expect(result).toContain("PR")
    expect(result).toContain("https://github.com/org/repo/pull/42")
  })

  it("includes progress when provided", () => {
    const result = formatDagNodeComplete("my-slug", "completed", "My Task", undefined, { done: 3, total: 5, running: 1 })
    expect(result).toContain("3/5 complete")
    expect(result).toContain("1 running")
  })

  it("renders slug as clickable link when threadId and chatId provided", () => {
    const result = formatDagNodeComplete("my-slug", "completed", "My Task", undefined, undefined, 42, -1001234567890)
    expect(result).toContain('<a href="https://t.me/c/1234567890/42">my-slug</a>')
    expect(result).not.toContain("<b>my-slug</b>")
  })

  it("falls back to bold slug when threadId missing", () => {
    const result = formatDagNodeComplete("my-slug", "completed", "My Task", undefined, undefined, undefined, -1001234567890)
    expect(result).toContain("<b>my-slug</b>")
    expect(result).not.toContain("<a href=")
  })

  it("falls back to bold slug when chatId missing", () => {
    const result = formatDagNodeComplete("my-slug", "completed", "My Task", undefined, undefined, 42)
    expect(result).toContain("<b>my-slug</b>")
    expect(result).not.toContain("<a href=")
  })
})

describe("formatDagNodeStarting", () => {
  it("renders basic output without link params", () => {
    const result = formatDagNodeStarting("My Task", "node-1", "my-slug")
    expect(result).toContain("Starting")
    expect(result).toContain("My Task")
    expect(result).toContain("node-1")
    expect(result).toContain("<code>my-slug</code>")
  })

  it("renders slug as clickable link when threadId and chatId provided", () => {
    const result = formatDagNodeStarting("My Task", "node-1", "my-slug", 42, -1001234567890)
    expect(result).toContain('<a href="https://t.me/c/1234567890/42">my-slug</a>')
    expect(result).not.toContain("<code>my-slug</code>")
  })

  it("falls back to code slug when only threadId provided", () => {
    const result = formatDagNodeStarting("My Task", "node-1", "my-slug", 42)
    expect(result).toContain("<code>my-slug</code>")
  })
})

describe("formatSplitChildComplete with links", () => {
  it("renders slug as clickable link when threadId and chatId provided", () => {
    const result = formatSplitChildComplete("bold-arc", "completed", "Add auth", undefined, 42, -1001234567890)
    expect(result).toContain('<a href="https://t.me/c/1234567890/42">bold-arc</a>')
    expect(result).not.toContain("<b>bold-arc</b>")
  })

  it("falls back to bold slug when no link params", () => {
    const result = formatSplitChildComplete("bold-arc", "completed", "Add auth")
    expect(result).toContain("<b>bold-arc</b>")
    expect(result).not.toContain("<a href=")
  })

  it("renders both topic link and PR link", () => {
    const result = formatSplitChildComplete("bold-arc", "completed", "Add auth", "https://github.com/org/repo/pull/42", 99, -1001234567890)
    expect(result).toContain('<a href="https://t.me/c/1234567890/99">bold-arc</a>')
    expect(result).toContain('<a href="https://github.com/org/repo/pull/42">PR</a>')
  })
})

describe("threadLink", () => {
  it("builds a t.me/c/ URL from numeric chatId and threadId", () => {
    expect(threadLink(-1001234567890, 42)).toBe("https://t.me/c/1234567890/42")
  })

  it("strips -100 prefix from string chatId", () => {
    expect(threadLink("-1001234567890", 99)).toBe("https://t.me/c/1234567890/99")
  })

  it("works with chatId that has no -100 prefix", () => {
    expect(threadLink("1234567890", 7)).toBe("https://t.me/c/1234567890/7")
  })

  it("returns undefined when chatId is undefined", () => {
    expect(threadLink(undefined, 42)).toBeUndefined()
  })

  it("returns undefined when threadId is undefined", () => {
    expect(threadLink(-1001234567890, undefined)).toBeUndefined()
  })

  it("returns undefined when both args are undefined", () => {
    expect(threadLink(undefined, undefined)).toBeUndefined()
  })

  it("handles negative chatId without -100 prefix", () => {
    expect(threadLink(-5, 42)).toBe("https://t.me/c/-5/42")
  })

  it("handles numeric chatId with exact -100 value", () => {
    expect(threadLink(-100, 1)).toBe("https://t.me/c//1")
  })
})

describe("formatPinnedSplitStatus", () => {
  const children = [
    { slug: "bold-fox", label: "Fix auth", status: "done" as const, prUrl: "https://github.com/org/repo/pull/1", threadId: 10 },
    { slug: "calm-owl", label: "Add tests", status: "running" as const, threadId: 20 },
    { slug: "dark-elk", label: "Update docs", status: "failed" as const, threadId: 30 },
  ]

  it("uses tree branch characters (├── and └──)", () => {
    const result = formatPinnedSplitStatus("parent-slug", "my-repo", children)
    expect(result).toContain("├── ")
    expect(result).toContain("└── ")
  })

  it("uses └── only for the last child", () => {
    const lines = formatPinnedSplitStatus("parent-slug", "my-repo", children).split("\n")
    const branchLines = lines.filter((l) => l.includes("├── ") || l.includes("└── "))
    expect(branchLines).toHaveLength(3)
    expect(branchLines[0]).toContain("├── ")
    expect(branchLines[1]).toContain("├── ")
    expect(branchLines[2]).toContain("└── ")
  })

  it("includes status icons", () => {
    const result = formatPinnedSplitStatus("parent-slug", "my-repo", children)
    expect(result).toContain("✅")
    expect(result).toContain("⚡")
    expect(result).toContain("❌")
  })

  it("adds thread hyperlinks when chatId is provided", () => {
    const result = formatPinnedSplitStatus("parent-slug", "my-repo", children, -1001234567890)
    expect(result).toContain('<a href="https://t.me/c/1234567890/10">bold-fox</a>')
    expect(result).toContain('<a href="https://t.me/c/1234567890/20">calm-owl</a>')
    expect(result).toContain('<a href="https://t.me/c/1234567890/30">dark-elk</a>')
  })

  it("falls back to code tags when chatId is not provided", () => {
    const result = formatPinnedSplitStatus("parent-slug", "my-repo", children)
    expect(result).toContain("<code>bold-fox</code>")
    expect(result).toContain("<code>calm-owl</code>")
  })

  it("falls back to code tags when child has no threadId", () => {
    const noThreadChildren = [
      { slug: "bold-fox", label: "Fix auth", status: "done" as const },
    ]
    const result = formatPinnedSplitStatus("parent-slug", "my-repo", noThreadChildren, -1001234567890)
    expect(result).toContain("<code>bold-fox</code>")
    expect(result).not.toContain("t.me")
  })

  it("includes PR links for completed children", () => {
    const result = formatPinnedSplitStatus("parent-slug", "my-repo", children)
    expect(result).toContain('<a href="https://github.com/org/repo/pull/1">PR</a>')
  })

  it("shows progress summary", () => {
    const result = formatPinnedSplitStatus("parent-slug", "my-repo", children)
    expect(result).toContain("1/3 done")
    expect(result).toContain("1 failed")
    expect(result).toContain("1 running")
  })

  it("handles empty children array", () => {
    const result = formatPinnedSplitStatus("parent-slug", "my-repo", [])
    expect(result).toContain("0/0 done")
    expect(result).not.toContain("├── ")
    expect(result).not.toContain("└── ")
  })

  it("single child uses └── only", () => {
    const single = [{ slug: "only-fox", label: "Solo task", status: "running" as const, threadId: 5 }]
    const result = formatPinnedSplitStatus("parent-slug", "repo", single)
    expect(result).toContain("└── ")
    expect(result).not.toContain("├── ")
  })

  it("escapes HTML in repo and slug names", () => {
    const result = formatPinnedSplitStatus("slug<xss>", "repo&name", [
      { slug: "child<evil>", label: "test", status: "running" as const },
    ])
    expect(result).toContain("slug&lt;xss&gt;")
    expect(result).toContain("repo&amp;name")
    expect(result).toContain("child&lt;evil&gt;")
  })

  it("shows header with split icon and repo", () => {
    const result = formatPinnedSplitStatus("my-slug", "my-repo", children)
    expect(result).toContain("🔀")
    expect(result).toContain("Split")
    expect(result).toContain("my-repo")
    expect(result).toContain("my-slug")
  })

  it("hides failed/running counts when zero", () => {
    const allDone = [
      { slug: "a", label: "A", status: "done" as const },
      { slug: "b", label: "B", status: "done" as const },
    ]
    const result = formatPinnedSplitStatus("slug", "repo", allDone)
    expect(result).toContain("2/2 done")
    expect(result).not.toContain("failed")
    expect(result).not.toContain("running")
  })
})

describe("formatPinnedDagStatus", () => {
  const stackNodes = [
    { id: "step-0", title: "Set up auth", dependsOn: [], status: "done" as const, threadId: 10, prUrl: "https://github.com/org/repo/pull/1" },
    { id: "step-1", title: "Add middleware", dependsOn: ["step-0"], status: "running" as const, threadId: 20 },
    { id: "step-2", title: "Write tests", dependsOn: ["step-1"], status: "pending" as const },
  ]

  const dagNodes = [
    { id: "auth", title: "Auth service", dependsOn: [], status: "done" as const, threadId: 10, prUrl: "https://github.com/org/repo/pull/1" },
    { id: "api", title: "API layer", dependsOn: ["auth"], status: "running" as const, threadId: 20 },
    { id: "ui", title: "UI components", dependsOn: ["auth"], status: "pending" as const, threadId: 30 },
    { id: "integration", title: "Integration tests", dependsOn: ["api", "ui"], status: "pending" as const },
  ]

  describe("stack mode (isStack=true)", () => {
    it("uses tree branch characters (├── and └──)", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", stackNodes, true)
      expect(result).toContain("├── ")
      expect(result).toContain("└── ")
    })

    it("uses └── only for the last node", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", stackNodes, true)
      const lines = result.split("\n").filter((l) => l.includes("├── ") || l.includes("└── "))
      expect(lines).toHaveLength(3)
      expect(lines[0]).toContain("├── ")
      expect(lines[1]).toContain("├── ")
      expect(lines[2]).toContain("└── ")
    })

    it("adds │ connectors between stack nodes", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", stackNodes, true)
      const lines = result.split("\n")
      const connectors = lines.filter((l) => l.trim() === "│")
      expect(connectors.length).toBeGreaterThan(0)
    })

    it("shows status icons", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", stackNodes, true)
      expect(result).toContain("✅")
      expect(result).toContain("⚡")
      expect(result).toContain("⏳")
    })

    it("includes thread hyperlinks when chatId is provided", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", stackNodes, true, -1001234567890)
      expect(result).toContain('<a href="https://t.me/c/1234567890/10">step-0</a>')
      expect(result).toContain('<a href="https://t.me/c/1234567890/20">step-1</a>')
    })

    it("falls back to code tags when chatId is not provided", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", stackNodes, true)
      expect(result).toContain("<code>step-0</code>")
      expect(result).toContain("<code>step-1</code>")
    })

    it("falls back to code tags when threadId is missing", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", stackNodes, true, -1001234567890)
      expect(result).toContain("<code>step-2</code>")
      expect(result).not.toContain("t.me/c/1234567890/undefined")
    })

    it("includes PR links", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", stackNodes, true)
      expect(result).toContain('<a href="https://github.com/org/repo/pull/1">PR</a>')
    })

    it("shows header with 📚 Stack label", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", stackNodes, true)
      expect(result).toContain("📚")
      expect(result).toContain("Stack")
    })

    it("shows progress summary", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", stackNodes, true)
      expect(result).toContain("1/3 done")
      expect(result).toContain("1 running")
      expect(result).toContain("1 pending")
    })

    it("strikethrough for done nodes", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", stackNodes, true)
      expect(result).toContain("<s>Set up auth</s>")
    })

    it("bold for running nodes", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", stackNodes, true)
      expect(result).toContain("<b>Add middleware</b>")
    })
  })

  describe("DAG mode (isStack=false)", () => {
    it("shows header with 🔗 DAG label", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", dagNodes, false)
      expect(result).toContain("🔗")
      expect(result).toContain("DAG")
    })

    it("shows dependency notation (← dep) for nodes with dependencies", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", dagNodes, false)
      expect(result).toContain("← auth")
      expect(result).toContain("← api, ui")
    })

    it("uses tree branch characters", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", dagNodes, false)
      expect(result).toContain("├── ")
      expect(result).toContain("└── ")
    })

    it("includes thread hyperlinks when chatId is provided", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", dagNodes, false, -1001234567890)
      expect(result).toContain('<a href="https://t.me/c/1234567890/10">auth</a>')
      expect(result).toContain('<a href="https://t.me/c/1234567890/20">api</a>')
      expect(result).toContain('<a href="https://t.me/c/1234567890/30">ui</a>')
    })

    it("falls back to code tags when threadId is missing", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", dagNodes, false, -1001234567890)
      expect(result).toContain("<code>integration</code>")
    })

    it("shows progress summary", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", dagNodes, false)
      expect(result).toContain("1/4 done")
      expect(result).toContain("1 running")
      expect(result).toContain("2 pending")
    })

    it("includes PR links for nodes that have them", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", dagNodes, false)
      expect(result).toContain('<a href="https://github.com/org/repo/pull/1">PR</a>')
    })

    it("renders root nodes at depth 0 and dependents indented", () => {
      const result = formatPinnedDagStatus("parent-slug", "my-repo", dagNodes, false)
      const lines = result.split("\n")
      const authLine = lines.find((l) => l.includes("Auth service"))
      const integrationLine = lines.find((l) => l.includes("Integration tests"))
      expect(authLine).toBeDefined()
      expect(integrationLine).toBeDefined()
      expect(integrationLine!.search(/\S/)).toBeGreaterThan(authLine!.search(/\S/))
    })
  })

  describe("edge cases", () => {
    it("handles single node", () => {
      const single = [{ id: "only", title: "Only task", dependsOn: [], status: "running" as const }]
      const result = formatPinnedDagStatus("slug", "repo", single, true)
      expect(result).toContain("└── ")
      expect(result).toContain("⚡")
      expect(result).toContain("Only task")
    })

    it("handles empty nodes array", () => {
      const result = formatPinnedDagStatus("slug", "repo", [], false)
      expect(result).toContain("0/0 done")
    })

    it("handles skipped status", () => {
      const nodes = [
        { id: "a", title: "Task A", dependsOn: [], status: "failed" as const },
        { id: "b", title: "Task B", dependsOn: ["a"], status: "skipped" as const },
      ]
      const result = formatPinnedDagStatus("slug", "repo", nodes, false)
      expect(result).toContain("❌")
      expect(result).toContain("⏭️")
      expect(result).toContain("<s>Task B</s>")
    })

    it("handles ready status as pending icon", () => {
      const nodes = [
        { id: "a", title: "Task A", dependsOn: [], status: "ready" as const },
      ]
      const result = formatPinnedDagStatus("slug", "repo", nodes, false)
      expect(result).toContain("⏳")
      expect(result).toContain("Task A")
    })

    it("counts ready status as pending in progress summary", () => {
      const nodes = [
        { id: "a", title: "Task A", dependsOn: [], status: "done" as const },
        { id: "b", title: "Task B", dependsOn: ["a"], status: "ready" as const },
      ]
      const result = formatPinnedDagStatus("slug", "repo", nodes, false)
      expect(result).toContain("1/2 done")
      expect(result).toContain("1 pending")
    })

    it("escapes HTML in node titles", () => {
      const nodes = [
        { id: "a", title: "Fix <script>alert</script>", dependsOn: [], status: "running" as const },
      ]
      const result = formatPinnedDagStatus("slug", "repo", nodes, false)
      expect(result).toContain("&lt;script&gt;")
      expect(result).not.toContain("<script>")
    })

    it("renders diamond DAG (fan-out then fan-in) correctly", () => {
      const diamond = [
        { id: "root", title: "Root", dependsOn: [], status: "done" as const, threadId: 1 },
        { id: "left", title: "Left", dependsOn: ["root"], status: "done" as const, threadId: 2 },
        { id: "right", title: "Right", dependsOn: ["root"], status: "running" as const, threadId: 3 },
        { id: "merge", title: "Merge", dependsOn: ["left", "right"], status: "pending" as const },
      ]
      const result = formatPinnedDagStatus("slug", "repo", diamond, false, -1001234567890)
      // Root at depth 0
      expect(result).toContain("Root")
      // Left and Right at depth 1
      expect(result).toContain("Left")
      expect(result).toContain("Right")
      // Merge at depth 2 with dependency notation
      expect(result).toContain("← left, right")
      // All thread links for nodes that have them
      expect(result).toContain('href="https://t.me/c/1234567890/1"')
      expect(result).toContain('href="https://t.me/c/1234567890/2"')
      expect(result).toContain('href="https://t.me/c/1234567890/3"')
      // Merge has no threadId → code tag
      expect(result).toContain("<code>merge</code>")
    })

    it("renders multiple independent roots in DAG", () => {
      const nodes = [
        { id: "a", title: "Independent A", dependsOn: [], status: "running" as const },
        { id: "b", title: "Independent B", dependsOn: [], status: "running" as const },
      ]
      const result = formatPinnedDagStatus("slug", "repo", nodes, false)
      expect(result).toContain("Independent A")
      expect(result).toContain("Independent B")
      // Both at depth 0, so ├── and └──
      expect(result).toContain("├── ")
      expect(result).toContain("└── ")
    })

    it("DAG level connectors separate depth levels", () => {
      const nodes = [
        { id: "a", title: "Root", dependsOn: [], status: "done" as const },
        { id: "b", title: "Child", dependsOn: ["a"], status: "pending" as const },
      ]
      const result = formatPinnedDagStatus("slug", "repo", nodes, false)
      const lines = result.split("\n")
      // Should have a │ connector between depth 0 and depth 1
      const connectorLines = lines.filter((l) => l.trim() === "│")
      expect(connectorLines.length).toBeGreaterThan(0)
    })

    it("plain text for pending nodes (no bold, no strikethrough)", () => {
      const nodes = [
        { id: "a", title: "Waiting", dependsOn: [], status: "pending" as const },
      ]
      const result = formatPinnedDagStatus("slug", "repo", nodes, false)
      expect(result).toContain("Waiting")
      expect(result).not.toContain("<s>Waiting</s>")
      expect(result).not.toContain("<b>Waiting</b>")
    })

    it("bold for failed nodes", () => {
      const nodes = [
        { id: "a", title: "Broken", dependsOn: [], status: "failed" as const },
      ]
      const result = formatPinnedDagStatus("slug", "repo", nodes, false)
      expect(result).toContain("<b>Broken</b>")
    })
  })
})
