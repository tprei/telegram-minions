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

  it("truncates very long text", () => {
    const longText = "z".repeat(5000)
    const msg = formatAssistantText("slug", longText)
    expect(msg).toContain("…")
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
