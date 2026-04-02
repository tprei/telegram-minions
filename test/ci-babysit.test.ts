import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { extractPRUrl, findPRByBranch, buildCIFixPrompt, buildQualityGateFixPrompt, buildMergeConflictPrompt, checkPRMergeability, waitForCI } from "../src/ci/ci-babysit.js"
import type { CiConfig } from "../src/config/config-types.js"

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, execFile: vi.fn() }
})

import { execFile } from "node:child_process"
const mockExecFile = vi.mocked(execFile)

/* eslint-disable @typescript-eslint/no-explicit-any */
function mockSuccess(output: string): void {
  mockExecFile.mockImplementation((...allArgs: any[]) => {
    const cb = allArgs[allArgs.length - 1] as (err: Error | null, stdout: string, stderr: string) => void
    cb(null, output, "")
    return undefined as any
  })
}

function mockError(stderr = "gh failed"): void {
  const err = Object.assign(new Error("Command failed"), { stderr })
  mockExecFile.mockImplementation((...allArgs: any[]) => {
    const cb = allArgs[allArgs.length - 1] as (err: Error | null, stdout: string, stderr: string) => void
    cb(err, "", stderr)
    return undefined as any
  })
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("extractPRUrl", () => {
  it("extracts a PR URL from conversation text", () => {
    const text = "I opened a PR: https://github.com/org/repo/pull/42 for review"
    expect(extractPRUrl(text)).toBe("https://github.com/org/repo/pull/42")
  })

  it("returns null when no PR URL is present", () => {
    expect(extractPRUrl("no links here")).toBeNull()
  })

  it("extracts the first PR URL when multiple are present", () => {
    const text = "See https://github.com/org/repo/pull/1 and https://github.com/org/repo/pull/2"
    expect(extractPRUrl(text)).toBe("https://github.com/org/repo/pull/1")
  })

  it("handles URL at end of string", () => {
    const text = "PR created: https://github.com/org/repo/pull/99"
    expect(extractPRUrl(text)).toBe("https://github.com/org/repo/pull/99")
  })

  it("handles URL in parentheses", () => {
    const text = "(https://github.com/org/repo/pull/5)"
    expect(extractPRUrl(text)).toBe("https://github.com/org/repo/pull/5")
  })

  it("strips markdown bold formatting from URL", () => {
    const text = "PR created: **https://github.com/org/repo/pull/75**"
    expect(extractPRUrl(text)).toBe("https://github.com/org/repo/pull/75")
  })

  it("strips markdown link brackets from URL", () => {
    const text = "See [PR](https://github.com/org/repo/pull/75)"
    expect(extractPRUrl(text)).toBe("https://github.com/org/repo/pull/75")
  })
})

describe("findPRByBranch", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns PR URL when gh pr list finds a match", async () => {
    mockSuccess("https://github.com/org/repo/pull/42\n")
    expect(await findPRByBranch("minion/test-slug", "/tmp")).toBe("https://github.com/org/repo/pull/42")
  })

  it("returns null when gh pr list returns empty output", async () => {
    mockSuccess("\n")
    expect(await findPRByBranch("minion/test-slug", "/tmp")).toBeNull()
  })

  it("returns null when gh pr list throws", async () => {
    mockError("gh not found")
    expect(await findPRByBranch("minion/test-slug", "/tmp")).toBeNull()
  })
})

describe("buildCIFixPrompt", () => {
  it("includes PR URL and attempt info", () => {
    const prompt = buildCIFixPrompt(
      "https://github.com/org/repo/pull/42",
      [{ name: "test", state: "failure", bucket: "fail" }],
      [],
      1,
      3,
    )
    expect(prompt).toContain("https://github.com/org/repo/pull/42")
    expect(prompt).toContain("Attempt: 1/3")
  })

  it("lists failed checks", () => {
    const prompt = buildCIFixPrompt(
      "https://github.com/org/repo/pull/1",
      [
        { name: "test", state: "failure", bucket: "fail" },
        { name: "lint", state: "failure", bucket: "fail" },
      ],
      [],
      1,
      2,
    )
    expect(prompt).toContain("**test**")
    expect(prompt).toContain("**lint**")
  })

  it("includes failure logs when available", () => {
    const prompt = buildCIFixPrompt(
      "https://github.com/org/repo/pull/1",
      [{ name: "test", state: "failure", bucket: "fail" }],
      [{ checkName: "test", logs: "Error: assertion failed at line 42" }],
      1,
      2,
    )
    expect(prompt).toContain("Failure logs")
    expect(prompt).toContain("assertion failed at line 42")
  })

  it("omits failure logs section when none available", () => {
    const prompt = buildCIFixPrompt(
      "https://github.com/org/repo/pull/1",
      [{ name: "test", state: "failure", bucket: "fail" }],
      [],
      1,
      2,
    )
    expect(prompt).not.toContain("Failure logs")
  })

  it("includes fix instruction", () => {
    const prompt = buildCIFixPrompt(
      "https://github.com/org/repo/pull/1",
      [{ name: "test", state: "failure", bucket: "fail" }],
      [],
      1,
      1,
    )
    expect(prompt).toContain("Fix the failures above")
  })
})

describe("buildQualityGateFixPrompt", () => {
  it("includes PR URL and attempt info", () => {
    const prompt = buildQualityGateFixPrompt(
      "https://github.com/org/repo/pull/42",
      {
        allPassed: false,
        results: [{ gate: "tests", passed: false, output: "test error" }],
      },
      1,
      3,
    )
    expect(prompt).toContain("https://github.com/org/repo/pull/42")
    expect(prompt).toContain("Attempt: 1/3")
  })

  it("lists only failed gates", () => {
    const prompt = buildQualityGateFixPrompt(
      "https://github.com/org/repo/pull/1",
      {
        allPassed: false,
        results: [
          { gate: "tests", passed: false, output: "test error" },
          { gate: "lint", passed: true, output: "" },
          { gate: "typecheck", passed: false, output: "type error" },
        ],
      },
      1,
      2,
    )
    expect(prompt).toContain("**tests**")
    expect(prompt).toContain("**typecheck**")
    expect(prompt).not.toContain("**lint**")
  })

  it("includes failure output in code blocks", () => {
    const prompt = buildQualityGateFixPrompt(
      "https://github.com/org/repo/pull/1",
      {
        allPassed: false,
        results: [{ gate: "tests", passed: false, output: "Expected 2 got 3" }],
      },
      1,
      2,
    )
    expect(prompt).toContain("```")
    expect(prompt).toContain("Expected 2 got 3")
  })

  it("trims long failure output to last 1500 chars", () => {
    const longOutput = "x".repeat(2000)
    const prompt = buildQualityGateFixPrompt(
      "https://github.com/org/repo/pull/1",
      {
        allPassed: false,
        results: [{ gate: "tests", passed: false, output: longOutput }],
      },
      1,
      2,
    )
    expect(prompt).not.toContain("x".repeat(2000))
    expect(prompt).toContain("x".repeat(1500))
  })

  it("omits output for gates with empty output", () => {
    const prompt = buildQualityGateFixPrompt(
      "https://github.com/org/repo/pull/1",
      {
        allPassed: false,
        results: [{ gate: "tests", passed: false, output: "" }],
      },
      1,
      2,
    )
    expect(prompt).toContain("**tests**")
    expect(prompt).not.toContain("```")
  })

  it("includes fix instruction", () => {
    const prompt = buildQualityGateFixPrompt(
      "https://github.com/org/repo/pull/1",
      {
        allPassed: false,
        results: [{ gate: "tests", passed: false, output: "error" }],
      },
      1,
      1,
    )
    expect(prompt).toContain("Fix the local quality gate failures above")
  })

  it("includes Local quality gate failures header", () => {
    const prompt = buildQualityGateFixPrompt(
      "https://github.com/org/repo/pull/1",
      {
        allPassed: false,
        results: [{ gate: "tests", passed: false, output: "error" }],
      },
      2,
      3,
    )
    expect(prompt).toContain("## Local quality gate failures")
  })
})

describe("buildMergeConflictPrompt", () => {
  it("includes PR URL and attempt info", () => {
    const prompt = buildMergeConflictPrompt(
      "https://github.com/org/repo/pull/42",
      1,
      3,
    )
    expect(prompt).toContain("https://github.com/org/repo/pull/42")
    expect(prompt).toContain("Attempt: 1/3")
  })

  it("includes merge conflict resolution header", () => {
    const prompt = buildMergeConflictPrompt(
      "https://github.com/org/repo/pull/1",
      1,
      2,
    )
    expect(prompt).toContain("## Merge conflict resolution")
  })

  it("includes instructions for resolving conflicts", () => {
    const prompt = buildMergeConflictPrompt(
      "https://github.com/org/repo/pull/1",
      1,
      2,
    )
    expect(prompt).toContain("git fetch")
    expect(prompt).toContain("git merge")
    expect(prompt).toContain("Resolve any conflicts")
  })

  it("includes instruction to run local quality gates", () => {
    const prompt = buildMergeConflictPrompt(
      "https://github.com/org/repo/pull/1",
      1,
      2,
    )
    expect(prompt).toContain("Run local quality gates")
    expect(prompt).toContain("tests pass locally")
  })

  it("uses custom baseBranch in git commands", () => {
    const prompt = buildMergeConflictPrompt(
      "https://github.com/org/repo/pull/1",
      1,
      2,
      "master",
    )
    expect(prompt).toContain("git fetch origin master")
    expect(prompt).toContain("origin/master")
    expect(prompt).not.toContain("origin/main")
  })
})

describe("checkPRMergeability", () => {
  afterEach(() => { mockExecFile.mockReset() })

  it("returns MERGEABLE when gh reports mergeable", async () => {
    mockSuccess("MERGEABLE\n")
    expect(await checkPRMergeability("https://github.com/org/repo/pull/1", "/tmp")).toBe("MERGEABLE")
  })

  it("returns CONFLICTING when gh reports conflicts", async () => {
    mockSuccess("CONFLICTING\n")
    expect(await checkPRMergeability("https://github.com/org/repo/pull/1", "/tmp")).toBe("CONFLICTING")
  })

  it("returns UNKNOWN when gh reports unknown", async () => {
    mockSuccess("UNKNOWN\n")
    expect(await checkPRMergeability("https://github.com/org/repo/pull/1", "/tmp")).toBe("UNKNOWN")
  })

  it("returns null when gh command fails", async () => {
    mockError("gh failed")
    expect(await checkPRMergeability("https://github.com/org/repo/pull/1", "/tmp")).toBeNull()
  })

  it("returns null for unexpected output", async () => {
    mockSuccess("SOMETHING_ELSE\n")
    expect(await checkPRMergeability("https://github.com/org/repo/pull/1", "/tmp")).toBeNull()
  })
})

describe("waitForCI", () => {
  const testConfig: CiConfig = {
    pollIntervalMs: 10,
    pollTimeoutMs: 500,
    maxRetries: 2,
  }

  beforeEach(() => { mockExecFile.mockReset() })

  it("returns success when all checks pass immediately", async () => {
    mockSuccess(JSON.stringify([
      { name: "test", state: "success", bucket: "pass" },
      { name: "lint", state: "success", bucket: "pass" },
    ]))

    const result = await waitForCI("https://github.com/org/repo/pull/1", "/tmp", testConfig)

    expect(result.passed).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.checks).toHaveLength(2)
  })

  it("returns failure when some checks fail", async () => {
    mockSuccess(JSON.stringify([
      { name: "test", state: "success", bucket: "pass" },
      { name: "lint", state: "failure", bucket: "fail" },
    ]))

    const result = await waitForCI("https://github.com/org/repo/pull/1", "/tmp", testConfig)

    expect(result.passed).toBe(false)
    expect(result.timedOut).toBe(false)
    expect(result.checks).toHaveLength(2)
  })

  it("continues polling when checks are pending", async () => {
    let callCount = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockImplementation((...allArgs: any[]) => {
      callCount++
      const cb = allArgs[allArgs.length - 1] as (err: Error | null, stdout: string, stderr: string) => void
      const output = callCount < 3
        ? JSON.stringify([{ name: "test", state: "pending", bucket: "pending" }])
        : JSON.stringify([{ name: "test", state: "success", bucket: "pass" }])
      cb(null, output, "")
      return undefined as any // eslint-disable-line @typescript-eslint/no-explicit-any
    })

    const result = await waitForCI("https://github.com/org/repo/pull/1", "/tmp", testConfig)

    expect(result.passed).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(callCount).toBeGreaterThanOrEqual(3)
  })

  it("continues polling on transient errors (null returns)", async () => {
    let callCount = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockImplementation((...allArgs: any[]) => {
      callCount++
      const cb = allArgs[allArgs.length - 1] as (err: Error | null, stdout: string, stderr: string) => void
      if (callCount < 3) {
        const err = Object.assign(new Error("Transient network error"), { stderr: "network timeout" })
        cb(err, "", "network timeout")
      } else {
        cb(null, JSON.stringify([{ name: "test", state: "success", bucket: "pass" }]), "")
      }
      return undefined as any // eslint-disable-line @typescript-eslint/no-explicit-any
    })

    const result = await waitForCI("https://github.com/org/repo/pull/1", "/tmp", testConfig)

    expect(result.passed).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(callCount).toBeGreaterThanOrEqual(3)
  })

  it("times out when checks never complete", async () => {
    mockSuccess(JSON.stringify([{ name: "test", state: "pending", bucket: "pending" }]))

    const result = await waitForCI("https://github.com/org/repo/pull/1", "/tmp", testConfig)

    expect(result.timedOut).toBe(true)
    expect(result.passed).toBe(false)
  })

  it("times out when all calls fail with transient errors", async () => {
    mockError("Permanent network failure")

    const result = await waitForCI("https://github.com/org/repo/pull/1", "/tmp", testConfig)

    expect(result.timedOut).toBe(true)
    expect(result.passed).toBe(false)
    expect(result.checks).toEqual([])
  })

  it("treats 'no checks reported' as passed after grace period", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockImplementation((...allArgs: any[]) => {
      const cb = allArgs[allArgs.length - 1] as (err: Error | null, stdout: string, stderr: string) => void
      const err = Object.assign(
        new Error("Command failed: gh pr checks ...\nno checks reported on the 'minion/near-fir' branch\n"),
        { code: 1, stderr: "no checks reported on the 'minion/near-fir' branch\n" },
      )
      cb(err, "", err.stderr)
      return undefined as any // eslint-disable-line @typescript-eslint/no-explicit-any
    })

    const noChecksConfig: CiConfig = { ...testConfig, noChecksGraceMs: 30 }
    const result = await waitForCI("https://github.com/org/repo/pull/1", "/tmp", noChecksConfig)

    expect(result.passed).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.checks).toEqual([])
  })

  it("uses exponential backoff between polls", async () => {
    const pollTimes: number[] = []
    let callCount = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockImplementation((...allArgs: any[]) => {
      callCount++
      pollTimes.push(Date.now())
      const cb = allArgs[allArgs.length - 1] as (err: Error | null, stdout: string, stderr: string) => void
      if (callCount < 4) {
        cb(null, JSON.stringify([{ name: "test", state: "pending", bucket: "pending" }]), "")
      } else {
        cb(null, JSON.stringify([{ name: "test", state: "success", bucket: "pass" }]), "")
      }
      return undefined as any // eslint-disable-line @typescript-eslint/no-explicit-any
    })

    const backoffConfig: CiConfig = { ...testConfig, pollIntervalMs: 50, pollTimeoutMs: 5000 }
    const result = await waitForCI("https://github.com/org/repo/pull/1", "/tmp", backoffConfig)

    expect(result.passed).toBe(true)
    expect(callCount).toBe(4)

    // Verify delays grow: gap between poll 2-3 should be >= gap between poll 1-2
    const gap1 = pollTimes[1] - pollTimes[0]
    const gap2 = pollTimes[2] - pollTimes[1]
    expect(gap2).toBeGreaterThanOrEqual(gap1)
  })

  it("aborts immediately on terminal error without retrying", async () => {
    let callCount = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockImplementation((...allArgs: any[]) => {
      callCount++
      const cb = allArgs[allArgs.length - 1] as (err: Error | null, stdout: string, stderr: string) => void
      const stderr = "GraphQL: Could not resolve to a Repository with the name 'cfbarber/telegram-minions'."
      const err = Object.assign(new Error("Command failed"), { stderr })
      cb(err, "", stderr)
      return undefined as any // eslint-disable-line @typescript-eslint/no-explicit-any
    })

    const result = await waitForCI("https://github.com/org/repo/pull/1", "/tmp", testConfig)

    expect(result.passed).toBe(false)
    expect(result.timedOut).toBe(false)
    expect(callCount).toBe(1) // must not retry
  })
})
