import { describe, it, expect } from "vitest"
import { extractPRUrl, buildCIFixPrompt, buildQualityGateFixPrompt } from "../src/ci-babysit.js"

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
