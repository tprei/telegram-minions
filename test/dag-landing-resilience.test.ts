import { describe, it, expect } from "vitest"
import {
  formatLandComplete,
  formatLandSkipped,
  formatLandSummary,
  formatLandConflictResolution,
  formatLandRecovered,
  formatLandFailedClosed,
  formatLandPreRetarget,
} from "../src/telegram/format.js"

describe("formatLandSkipped", () => {
  it("formats a skipped PR with lowercase state", () => {
    const result = formatLandSkipped("Create tables", "MERGED")
    expect(result).toContain("Skipped")
    expect(result).toContain("Create tables")
    expect(result).toContain("already merged")
  })

  it("formats a closed PR", () => {
    const result = formatLandSkipped("Fix bug", "CLOSED")
    expect(result).toContain("already closed")
  })
})

describe("formatLandComplete", () => {
  it("uses provided baseBranch name", () => {
    const result = formatLandComplete(3, 3, "master")
    expect(result).toContain("merged to master")
    expect(result).not.toContain("merged to main")
  })

  it("defaults to main when baseBranch omitted", () => {
    const result = formatLandComplete(3, 3)
    expect(result).toContain("merged to main")
  })
})

describe("formatLandSummary", () => {
  it("shows all merged when no failures or skips", () => {
    const result = formatLandSummary(5, 0, 0, 5, [])
    expect(result).toContain("5/5 PRs merged")
    expect(result).not.toContain("skipped")
    expect(result).not.toContain("failed")
  })

  it("includes skipped count", () => {
    const result = formatLandSummary(3, 0, 2, 5, [])
    expect(result).toContain("3/5 PRs merged")
    expect(result).toContain("2 skipped")
  })

  it("includes failed titles", () => {
    const result = formatLandSummary(2, 1, 0, 3, ["Create tables"])
    expect(result).toContain("2/3 PRs merged")
    expect(result).toContain("1 failed")
    expect(result).toContain("Create tables")
  })

  it("includes both skipped and failed", () => {
    const result = formatLandSummary(1, 2, 1, 4, ["Task A", "Task B"])
    expect(result).toContain("1/4 PRs merged")
    expect(result).toContain("1 skipped")
    expect(result).toContain("2 failed")
    expect(result).toContain("Task A")
    expect(result).toContain("Task B")
  })

  it("escapes HTML in failed titles", () => {
    const result = formatLandSummary(0, 1, 0, 1, ["<script>alert(1)</script>"])
    expect(result).toContain("&lt;script&gt;")
    expect(result).not.toContain("<script>")
  })

  it("uses provided baseBranch name", () => {
    const result = formatLandSummary(2, 1, 0, 3, ["Task A"], "master")
    expect(result).toContain("merged to master")
    expect(result).not.toContain("merged to main")
  })
})

describe("formatLandRecovered", () => {
  it("marks the merge as recovered from closed state", () => {
    const result = formatLandRecovered("Fix auth", "https://github.com/org/repo/pull/7", 1, 3)
    expect(result).toContain("2/3")
    expect(result).toContain("recovered from closed")
    expect(result).toContain("Fix auth")
    expect(result).toContain("https://github.com/org/repo/pull/7")
  })
})

describe("formatLandFailedClosed", () => {
  it("explains that retarget was rejected", () => {
    const result = formatLandFailedClosed("Fix auth", "404 not found")
    expect(result).toContain("Landing failed")
    expect(result).toContain("Fix auth")
    expect(result).toContain("retarget")
    expect(result).toContain("404 not found")
  })
})

describe("formatLandPreRetarget", () => {
  it("names the base branch and pr count", () => {
    const result = formatLandPreRetarget(6, "master")
    expect(result).toContain("Retargeting 6 PRs")
    expect(result).toContain("master")
  })

  it("uses singular form for a single PR", () => {
    const result = formatLandPreRetarget(1, "main")
    expect(result).toContain("Retargeting 1 PR ")
    expect(result).not.toContain("1 PRs")
  })
})

describe("formatLandSummary with recovered", () => {
  it("reports the recovered count separately from merged and skipped", () => {
    const result = formatLandSummary(5, 0, 0, 5, [], "master", 2)
    expect(result).toContain("5/5 PRs merged")
    expect(result).toContain("2 recovered from auto-close")
    expect(result).not.toContain("skipped")
    expect(result).not.toContain("failed")
  })

  it("omits the recovered line when recovered is zero", () => {
    const result = formatLandSummary(5, 0, 0, 5, [], "master", 0)
    expect(result).not.toContain("recovered")
  })
})

describe("formatLandConflictResolution", () => {
  it("formats successful resolution", () => {
    const result = formatLandConflictResolution("Auth module", "minion/auth", true)
    expect(result).toContain("Resolved conflicts")
    expect(result).toContain("Auth module")
    expect(result).toContain("minion/auth")
  })

  it("formats failed resolution", () => {
    const result = formatLandConflictResolution("Auth module", "minion/auth", false)
    expect(result).toContain("Could not resolve")
    expect(result).toContain("Auth module")
  })
})
