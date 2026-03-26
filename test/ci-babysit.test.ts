import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { extractPRUrl, findPRByBranch, buildCIFixPrompt, buildQualityGateFixPrompt, buildMergeConflictPrompt, checkPRMergeability, waitForCI } from "../src/ci-babysit.js"
import type { CiConfig } from "../src/config-types.js"

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, execSync: vi.fn(actual.execSync) }
})

import { execSync } from "node:child_process"
const mockExecSync = vi.mocked(execSync)

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

  it("returns PR URL when gh pr list finds a match", () => {
    mockExecSync.mockReturnValue(Buffer.from("https://github.com/org/repo/pull/42\n"))
    expect(findPRByBranch("minion/test-slug", "/tmp")).toBe("https://github.com/org/repo/pull/42")
  })

  it("returns null when gh pr list returns empty output", () => {
    mockExecSync.mockReturnValue(Buffer.from("\n"))
    expect(findPRByBranch("minion/test-slug", "/tmp")).toBeNull()
  })

  it("returns null when gh pr list throws", () => {
    mockExecSync.mockImplementation(() => { throw new Error("gh not found") })
    expect(findPRByBranch("minion/test-slug", "/tmp")).toBeNull()
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
})

describe("checkPRMergeability", () => {
  afterEach(() => { mockExecSync.mockReset() })

  it("returns MERGEABLE when gh reports mergeable", () => {
    mockExecSync.mockReturnValue(Buffer.from("MERGEABLE\n"))
    expect(checkPRMergeability("https://github.com/org/repo/pull/1", "/tmp")).toBe("MERGEABLE")
  })

  it("returns CONFLICTING when gh reports conflicts", () => {
    mockExecSync.mockReturnValue(Buffer.from("CONFLICTING\n"))
    expect(checkPRMergeability("https://github.com/org/repo/pull/1", "/tmp")).toBe("CONFLICTING")
  })

  it("returns UNKNOWN when gh reports unknown", () => {
    mockExecSync.mockReturnValue(Buffer.from("UNKNOWN\n"))
    expect(checkPRMergeability("https://github.com/org/repo/pull/1", "/tmp")).toBe("UNKNOWN")
  })

  it("returns null when gh command fails", () => {
    mockExecSync.mockImplementation(() => { throw new Error("gh failed") })
    expect(checkPRMergeability("https://github.com/org/repo/pull/1", "/tmp")).toBeNull()
  })

  it("returns null for unexpected output", () => {
    mockExecSync.mockReturnValue(Buffer.from("SOMETHING_ELSE\n"))
    expect(checkPRMergeability("https://github.com/org/repo/pull/1", "/tmp")).toBeNull()
  })
})

describe("waitForCI", () => {
  const testConfig: CiConfig = {
    pollIntervalMs: 10, // Fast polling for tests
    pollTimeoutMs: 100, // Short timeout for tests
    maxRetries: 2,
  }

  beforeEach(() => { mockExecSync.mockReset() })

  it("returns success when all checks pass immediately", async () => {
    mockExecSync.mockReturnValue(Buffer.from(
      JSON.stringify([
        { name: "test", state: "success", bucket: "pass" },
        { name: "lint", state: "success", bucket: "pass" },
      ])
    ))

    const result = await waitForCI("https://github.com/org/repo/pull/1", "/tmp", testConfig)

    expect(result.passed).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.checks).toHaveLength(2)
  })

  it("returns failure when some checks fail", async () => {
    mockExecSync.mockReturnValue(Buffer.from(
      JSON.stringify([
        { name: "test", state: "success", bucket: "pass" },
        { name: "lint", state: "failure", bucket: "fail" },
      ])
    ))

    const result = await waitForCI("https://github.com/org/repo/pull/1", "/tmp", testConfig)

    expect(result.passed).toBe(false)
    expect(result.timedOut).toBe(false)
    expect(result.checks).toHaveLength(2)
  })

  it("continues polling when checks are pending", async () => {
    let callCount = 0
    mockExecSync.mockImplementation(() => {
      callCount++
      if (callCount < 3) {
        return Buffer.from(JSON.stringify([
          { name: "test", state: "pending", bucket: "pending" },
        ]))
      }
      return Buffer.from(JSON.stringify([
        { name: "test", state: "success", bucket: "pass" },
      ]))
    })

    const result = await waitForCI("https://github.com/org/repo/pull/1", "/tmp", testConfig)

    expect(result.passed).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(callCount).toBeGreaterThanOrEqual(3)
  })

  it("continues polling on transient errors (null returns)", async () => {
    let callCount = 0
    mockExecSync.mockImplementation(() => {
      callCount++
      if (callCount < 3) {
        throw new Error("Transient network error")
      }
      return Buffer.from(JSON.stringify([
        { name: "test", state: "success", bucket: "pass" },
      ]))
    })

    const result = await waitForCI("https://github.com/org/repo/pull/1", "/tmp", testConfig)

    expect(result.passed).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(callCount).toBeGreaterThanOrEqual(3)
  })

  it("times out when checks never complete", async () => {
    mockExecSync.mockReturnValue(Buffer.from(JSON.stringify([
      { name: "test", state: "pending", bucket: "pending" },
    ])))

    const result = await waitForCI("https://github.com/org/repo/pull/1", "/tmp", testConfig)

    expect(result.timedOut).toBe(true)
    expect(result.passed).toBe(false)
  })

  it("times out when all calls fail", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("Permanent failure")
    })

    const result = await waitForCI("https://github.com/org/repo/pull/1", "/tmp", testConfig)

    expect(result.timedOut).toBe(true)
    expect(result.passed).toBe(false)
    expect(result.checks).toEqual([])
  })
})
