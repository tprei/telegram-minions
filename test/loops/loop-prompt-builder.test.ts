import { describe, it, expect } from "vitest"
import { buildLoopPrompt, type LoopPromptContext } from "../../src/loops/loop-prompt-builder.js"
import type { LoopDefinition, LoopState, LoopOutcome } from "../../src/loops/domain-types.js"

function makeDefinition(overrides?: Partial<LoopDefinition>): LoopDefinition {
  return {
    id: "test-loop",
    name: "Test Loop",
    repo: "owner/repo",
    intervalMs: 60_000,
    prompt: "Find and fix lint warnings.",
    enabled: true,
    ...overrides,
  }
}

function makeOutcome(overrides?: Partial<LoopOutcome>): LoopOutcome {
  return {
    runNumber: 1,
    startedAt: Date.parse("2026-03-01T10:00:00Z"),
    finishedAt: Date.parse("2026-03-01T10:05:00Z"),
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
  it("includes the repository name", () => {
    const ctx: LoopPromptContext = { definition: makeDefinition(), repo: "owner/repo" }
    const prompt = buildLoopPrompt(ctx)
    expect(prompt).toContain("Repository: owner/repo")
  })

  it("includes the loop definition prompt", () => {
    const ctx: LoopPromptContext = {
      definition: makeDefinition({ prompt: "Run type-checker and fix errors." }),
      repo: "owner/repo",
    }
    const prompt = buildLoopPrompt(ctx)
    expect(prompt).toContain("Run type-checker and fix errors.")
  })

  it("includes deduplication rules", () => {
    const ctx: LoopPromptContext = { definition: makeDefinition(), repo: "owner/repo" }
    const prompt = buildLoopPrompt(ctx)
    expect(prompt).toContain("Deduplication rules")
    expect(prompt).toContain("gh pr list --state open --label minions")
  })

  it("includes reporting footer", () => {
    const ctx: LoopPromptContext = { definition: makeDefinition(), repo: "owner/repo" }
    const prompt = buildLoopPrompt(ctx)
    expect(prompt).toContain("Reporting outcome")
    expect(prompt).toContain("NO_FINDINGS")
  })

  it("omits run history when no state is provided", () => {
    const ctx: LoopPromptContext = { definition: makeDefinition(), repo: "owner/repo" }
    const prompt = buildLoopPrompt(ctx)
    expect(prompt).not.toContain("Previous run history")
  })

  it("omits run history when totalRuns is 0", () => {
    const ctx: LoopPromptContext = {
      definition: makeDefinition(),
      repo: "owner/repo",
      state: makeState({ totalRuns: 0 }),
    }
    const prompt = buildLoopPrompt(ctx)
    expect(prompt).not.toContain("Previous run history")
  })

  it("includes run history when state has runs", () => {
    const ctx: LoopPromptContext = {
      definition: makeDefinition(),
      repo: "owner/repo",
      state: makeState({ totalRuns: 3, consecutiveFailures: 1 }),
    }
    const prompt = buildLoopPrompt(ctx)
    expect(prompt).toContain("Previous run history")
    expect(prompt).toContain("Total runs so far: 3")
    expect(prompt).toContain("Consecutive failures: 1")
  })

  it("formats outcome with PR url", () => {
    const ctx: LoopPromptContext = {
      definition: makeDefinition(),
      repo: "owner/repo",
      state: makeState({
        totalRuns: 1,
        outcomes: [makeOutcome({ runNumber: 2, prUrl: "https://github.com/owner/repo/pull/42" })],
      }),
    }
    const prompt = buildLoopPrompt(ctx)
    expect(prompt).toContain("Run #2")
    expect(prompt).toContain("pr_opened")
    expect(prompt).toContain("https://github.com/owner/repo/pull/42")
  })

  it("truncates long error messages in outcomes", () => {
    const longError = "x".repeat(200)
    const ctx: LoopPromptContext = {
      definition: makeDefinition(),
      repo: "owner/repo",
      state: makeState({
        totalRuns: 1,
        outcomes: [makeOutcome({ result: "errored", error: longError })],
      }),
    }
    const prompt = buildLoopPrompt(ctx)
    expect(prompt).toContain("error: " + "x".repeat(120) + "...")
    expect(prompt).not.toContain("x".repeat(200))
  })

  it("includes lastPrUrl in deduplication rules when present", () => {
    const ctx: LoopPromptContext = {
      definition: makeDefinition(),
      repo: "owner/repo",
      state: makeState({ lastPrUrl: "https://github.com/owner/repo/pull/99" }),
    }
    const prompt = buildLoopPrompt(ctx)
    expect(prompt).toContain("https://github.com/owner/repo/pull/99")
    expect(prompt).toContain("do NOT open a PR for the same change")
  })

  it("shows only the last 5 outcomes", () => {
    const outcomes = Array.from({ length: 8 }, (_, i) =>
      makeOutcome({ runNumber: i + 1 }),
    )
    const ctx: LoopPromptContext = {
      definition: makeDefinition(),
      repo: "owner/repo",
      state: makeState({ totalRuns: 8, outcomes }),
    }
    const prompt = buildLoopPrompt(ctx)
    expect(prompt).not.toContain("Run #1")
    expect(prompt).not.toContain("Run #3")
    expect(prompt).toContain("Run #4")
    expect(prompt).toContain("Run #8")
  })
})
