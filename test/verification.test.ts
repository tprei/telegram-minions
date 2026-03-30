import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("../src/ci/ci-babysit.js", () => ({
  checkPRMergeability: vi.fn(),
  waitForCI: vi.fn(),
}))

vi.mock("../src/ci/quality-gates.js", () => ({
  runQualityGates: vi.fn(),
}))

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, execSync: vi.fn() }
})

import { execSync } from "node:child_process"
import { checkPRMergeability, waitForCI } from "../src/ci/ci-babysit.js"
import { runQualityGates } from "../src/ci/quality-gates.js"
import {
  checkMergeConflicts,
  checkCI,
  checkTests,
  buildCompletenessReviewPrompt,
  parseCompletenessResult,
  rebaseOntoMain,
} from "../src/ci/verification.js"
import type { CiConfig } from "../src/config/config-types.js"

const mockCheckPRMergeability = vi.mocked(checkPRMergeability)
const mockWaitForCI = vi.mocked(waitForCI)
const mockRunQualityGates = vi.mocked(runQualityGates)
const mockExecSync = vi.mocked(execSync)

const ciConfig: CiConfig = {
  babysitEnabled: true,
  maxRetries: 2,
  pollIntervalMs: 1000,
  pollTimeoutMs: 60000,
  dagCiPolicy: "per-node",
}

describe("checkMergeConflicts", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("returns passed when PR is mergeable", async () => {
    mockCheckPRMergeability.mockResolvedValue("MERGEABLE")
    const result = await checkMergeConflicts("https://github.com/org/repo/pull/1", "/tmp")
    expect(result.passed).toBe(true)
    expect(result.state).toBe("MERGEABLE")
  })

  it("returns failed when PR has conflicts", async () => {
    mockCheckPRMergeability.mockResolvedValue("CONFLICTING")
    const result = await checkMergeConflicts("https://github.com/org/repo/pull/1", "/tmp")
    expect(result.passed).toBe(false)
    expect(result.state).toBe("CONFLICTING")
    expect(result.details).toContain("merge conflicts")
  })

  it("retries on UNKNOWN and passes if second check is MERGEABLE", async () => {
    mockCheckPRMergeability
      .mockResolvedValueOnce("UNKNOWN")
      .mockResolvedValueOnce("MERGEABLE")

    const promise = checkMergeConflicts("https://github.com/org/repo/pull/1", "/tmp")
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await promise

    expect(result.passed).toBe(true)
    expect(result.state).toBe("MERGEABLE")
  })

  it("returns failed when mergeability check returns null", async () => {
    mockCheckPRMergeability.mockResolvedValue(null)
    const result = await checkMergeConflicts("https://github.com/org/repo/pull/1", "/tmp")
    expect(result.passed).toBe(false)
    expect(result.state).toBeNull()
  })
})

describe("checkCI", () => {
  afterEach(() => vi.restoreAllMocks())

  it("returns passed when all CI checks pass", async () => {
    mockWaitForCI.mockResolvedValue({
      passed: true,
      checks: [
        { name: "build", state: "success", bucket: "pass" },
        { name: "test", state: "success", bucket: "pass" },
      ],
      timedOut: false,
    })

    const result = await checkCI("https://github.com/org/repo/pull/1", "/tmp", ciConfig)
    expect(result.passed).toBe(true)
    expect(result.details).toContain("2 CI check(s) passed")
  })

  it("returns failed when CI checks fail", async () => {
    mockWaitForCI.mockResolvedValue({
      passed: false,
      checks: [
        { name: "build", state: "failure", bucket: "fail" },
      ],
      timedOut: false,
    })

    const result = await checkCI("https://github.com/org/repo/pull/1", "/tmp", ciConfig)
    expect(result.passed).toBe(false)
    expect(result.details).toContain("build")
  })

  it("returns failed when CI times out", async () => {
    mockWaitForCI.mockResolvedValue({
      passed: false,
      checks: [
        { name: "slow-test", state: "pending", bucket: "pending" },
      ],
      timedOut: true,
    })

    const result = await checkCI("https://github.com/org/repo/pull/1", "/tmp", ciConfig)
    expect(result.passed).toBe(false)
    expect(result.details).toContain("timed out")
  })
})

describe("checkTests", () => {
  afterEach(() => vi.restoreAllMocks())

  it("returns passed when all quality gates pass", () => {
    mockRunQualityGates.mockReturnValue({
      allPassed: true,
      results: [
        { gate: "typecheck", passed: true, output: "ok" },
        { gate: "test", passed: true, output: "ok" },
      ],
    })

    const result = checkTests("/tmp/workspace")
    expect(result.passed).toBe(true)
    expect(result.details).toContain("All quality gates passed")
  })

  it("returns failed when quality gates fail", () => {
    mockRunQualityGates.mockReturnValue({
      allPassed: false,
      results: [
        { gate: "typecheck", passed: false, output: "error" },
        { gate: "test", passed: true, output: "ok" },
      ],
    })

    const result = checkTests("/tmp/workspace")
    expect(result.passed).toBe(false)
    expect(result.details).toContain("typecheck")
  })
})

describe("buildCompletenessReviewPrompt", () => {
  it("includes node details in the prompt", () => {
    const prompt = buildCompletenessReviewPrompt(
      "Add auth middleware",
      "Implement JWT-based auth",
      "minion/cool-fox",
      "https://github.com/org/repo/pull/42",
    )
    expect(prompt).toContain("Add auth middleware")
    expect(prompt).toContain("Implement JWT-based auth")
    expect(prompt).toContain("minion/cool-fox")
    expect(prompt).toContain("https://github.com/org/repo/pull/42")
    expect(prompt).toContain("VERIFICATION PASSED")
  })
})

describe("parseCompletenessResult", () => {
  it("detects VERIFICATION PASSED", () => {
    const result = parseCompletenessResult("Some analysis...\n\nVERIFICATION PASSED\n")
    expect(result.passed).toBe(true)
  })

  it("detects failure when sentinel is missing", () => {
    const result = parseCompletenessResult("Found issues:\n1. Missing test\n2. Type error")
    expect(result.passed).toBe(false)
  })
})

describe("rebaseOntoMain", () => {
  afterEach(() => vi.restoreAllMocks())

  it("returns passed on successful rebase", () => {
    mockExecSync.mockReturnValue(Buffer.from("ok"))

    const result = rebaseOntoMain("minion/cool-fox", "/tmp/workspace")
    expect(result.passed).toBe(true)
    expect(result.details).toContain("Rebased")
  })

  it("returns failed when fetch fails", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("network error")
    })

    const result = rebaseOntoMain("minion/cool-fox", "/tmp/workspace")
    expect(result.passed).toBe(false)
    expect(result.details).toContain("git fetch failed")
  })
})
