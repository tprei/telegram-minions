import { describe, it, expect } from "vitest"
import { buildLoopPrompt } from "../../src/loops/loop-prompt-builder.js"
import type { LoopDefinition, LoopState, LoopOutcome } from "../../src/loops/domain-types.js"

function makeDef(overrides?: Partial<LoopDefinition>): LoopDefinition {
  return {
    id: "test-loop",
    name: "Test Loop",
    repo: "https://github.com/org/repo",
    intervalMs: 600_000,
    prompt: "Find and fix lint warnings.",
    enabled: true,
    ...overrides,
  }
}

function makeOutcome(overrides?: Partial<LoopOutcome>): LoopOutcome {
  return {
    runNumber: 1,
    startedAt: Date.UTC(2026, 0, 15, 10, 0),
    finishedAt: Date.UTC(2026, 0, 15, 10, 5),
    result: "pr_opened",
    ...overrides,
  }
}

function makeState(overrides?: Partial<LoopState>): LoopState {
  return {
    loopId: "test-loop",
    enabled: true,
    consecutiveFailures: 0,
    totalRuns: 1,
    outcomes: [makeOutcome()],
    ...overrides,
  }
}

describe("buildLoopPrompt", () => {
  it("includes the repository URL", () => {
    const prompt = buildLoopPrompt({ definition: makeDef(), repo: "https://github.com/org/repo" })
    expect(prompt).toContain("Repository: https://github.com/org/repo")
  })

  it("includes the loop definition prompt", () => {
    const prompt = buildLoopPrompt({ definition: makeDef({ prompt: "Fix typos in docs." }), repo: "r" })
    expect(prompt).toContain("Fix typos in docs.")
  })

  it("includes deduplication rules", () => {
    const prompt = buildLoopPrompt({ definition: makeDef(), repo: "r" })
    expect(prompt).toContain("Deduplication rules")
    expect(prompt).toContain("gh pr list")
  })

  it("includes the reporting footer", () => {
    const prompt = buildLoopPrompt({ definition: makeDef(), repo: "r" })
    expect(prompt).toContain("Reporting outcome")
    expect(prompt).toContain("NO_FINDINGS")
  })

  it("omits run history when state has no runs", () => {
    const state = makeState({ totalRuns: 0, outcomes: [] })
    const prompt = buildLoopPrompt({ definition: makeDef(), repo: "r", state })
    expect(prompt).not.toContain("Previous run history")
  })

  it("includes run history when state has runs", () => {
    const state = makeState({ totalRuns: 3, outcomes: [makeOutcome({ runNumber: 3 })] })
    const prompt = buildLoopPrompt({ definition: makeDef(), repo: "r", state })
    expect(prompt).toContain("Previous run history")
    expect(prompt).toContain("Total runs so far: 3")
    expect(prompt).toContain("Run #3")
  })

  it("shows consecutive failures count", () => {
    const state = makeState({ totalRuns: 5, consecutiveFailures: 2 })
    const prompt = buildLoopPrompt({ definition: makeDef(), repo: "r", state })
    expect(prompt).toContain("Consecutive failures: 2")
  })

  it("shows PR URL in outcome", () => {
    const state = makeState({
      totalRuns: 1,
      outcomes: [makeOutcome({ prUrl: "https://github.com/org/repo/pull/42" })],
    })
    const prompt = buildLoopPrompt({ definition: makeDef(), repo: "r", state })
    expect(prompt).toContain("PR: https://github.com/org/repo/pull/42")
  })

  it("shows truncated error in outcome", () => {
    const longError = "x".repeat(200)
    const state = makeState({
      totalRuns: 1,
      outcomes: [makeOutcome({ result: "errored", error: longError })],
    })
    const prompt = buildLoopPrompt({ definition: makeDef(), repo: "r", state })
    expect(prompt).toContain("error: " + "x".repeat(120) + "...")
  })

  it("shows lastPrUrl in deduplication guard", () => {
    const state = makeState({ lastPrUrl: "https://github.com/org/repo/pull/99", totalRuns: 0 })
    const prompt = buildLoopPrompt({ definition: makeDef(), repo: "r", state })
    expect(prompt).toContain("https://github.com/org/repo/pull/99")
    expect(prompt).toContain("do NOT open a PR for the same change")
  })

  it("shows lastPrUrl in run history section", () => {
    const state = makeState({
      totalRuns: 1,
      lastPrUrl: "https://github.com/org/repo/pull/7",
    })
    const prompt = buildLoopPrompt({ definition: makeDef(), repo: "r", state })
    expect(prompt).toContain("Most recent PR: https://github.com/org/repo/pull/7")
  })

  it("limits outcomes to last 5", () => {
    const outcomes = Array.from({ length: 8 }, (_, i) =>
      makeOutcome({ runNumber: i + 1 }),
    )
    const state = makeState({ totalRuns: 8, outcomes })
    const prompt = buildLoopPrompt({ definition: makeDef(), repo: "r", state })
    // Should NOT contain run #1-3, should contain #4-8
    expect(prompt).not.toContain("Run #1 ")
    expect(prompt).toContain("Run #4")
    expect(prompt).toContain("Run #8")
  })
})
