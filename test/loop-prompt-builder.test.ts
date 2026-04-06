import { describe, it, expect } from "vitest"
import { buildLoopPrompt } from "../src/loops/loop-prompt-builder.js"
import type { LoopDefinition, LoopState } from "../src/loops/domain-types.js"

function makeDef(overrides: Partial<LoopDefinition> = {}): LoopDefinition {
  return {
    id: "test-loop",
    name: "Test Loop",
    repo: "org/repo",
    intervalMs: 3600000,
    prompt: "Find exactly ONE thing and fix it.",
    enabled: true,
    ...overrides,
  }
}

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    loopId: "test-loop",
    enabled: true,
    consecutiveFailures: 0,
    totalRuns: 0,
    outcomes: [],
    ...overrides,
  }
}

describe("buildLoopPrompt", () => {
  it("includes the definition prompt text", () => {
    const result = buildLoopPrompt({
      definition: makeDef({ prompt: "Custom loop task instructions here." }),
      repo: "org/repo",
    })
    expect(result).toContain("Custom loop task instructions here.")
  })

  it("includes the repo name in preamble", () => {
    const result = buildLoopPrompt({
      definition: makeDef(),
      repo: "myorg/myrepo",
    })
    expect(result).toContain("Repository: myorg/myrepo")
  })

  it("includes standard session instructions", () => {
    const result = buildLoopPrompt({
      definition: makeDef(),
      repo: "org/repo",
    })
    expect(result).toContain("gh pr create")
    expect(result).toContain("post-task-router")
    expect(result).toContain("conventional commit")
  })

  it("includes loop context explaining automated nature", () => {
    const result = buildLoopPrompt({
      definition: makeDef(),
      repo: "org/repo",
    })
    expect(result).toContain("automated loop run")
    expect(result).toContain("VALID outcome")
  })

  it("omits run history when state has zero runs", () => {
    const result = buildLoopPrompt({
      definition: makeDef(),
      repo: "org/repo",
      state: makeState({ totalRuns: 0 }),
    })
    expect(result).not.toContain("Previous run history")
  })

  it("omits run history when no state provided", () => {
    const result = buildLoopPrompt({
      definition: makeDef(),
      repo: "org/repo",
    })
    expect(result).not.toContain("Previous run history")
  })

  it("includes run history when state has runs", () => {
    const result = buildLoopPrompt({
      definition: makeDef(),
      repo: "org/repo",
      state: makeState({
        totalRuns: 3,
        outcomes: [
          {
            runNumber: 1,
            startedAt: 1700000000000,
            finishedAt: 1700003600000,
            result: "pr_opened",
            prUrl: "https://github.com/org/repo/pull/42",
          },
          {
            runNumber: 2,
            startedAt: 1700100000000,
            finishedAt: 1700103600000,
            result: "no_findings",
          },
          {
            runNumber: 3,
            startedAt: 1700200000000,
            finishedAt: 1700203600000,
            result: "errored",
            error: "Process exited with code 1",
          },
        ],
      }),
    })
    expect(result).toContain("Previous run history")
    expect(result).toContain("Total runs so far: 3")
    expect(result).toContain("pr_opened")
    expect(result).toContain("no_findings")
    expect(result).toContain("errored")
    expect(result).toContain("https://github.com/org/repo/pull/42")
  })

  it("shows lastPrUrl in history section", () => {
    const result = buildLoopPrompt({
      definition: makeDef(),
      repo: "org/repo",
      state: makeState({
        totalRuns: 1,
        lastPrUrl: "https://github.com/org/repo/pull/99",
        outcomes: [
          {
            runNumber: 1,
            startedAt: 1700000000000,
            finishedAt: 1700003600000,
            result: "pr_opened",
            prUrl: "https://github.com/org/repo/pull/99",
          },
        ],
      }),
    })
    expect(result).toContain("Most recent PR: https://github.com/org/repo/pull/99")
  })

  it("includes deduplication guard", () => {
    const result = buildLoopPrompt({
      definition: makeDef(),
      repo: "org/repo",
    })
    expect(result).toContain("Deduplication rules")
    expect(result).toContain("gh pr list")
  })

  it("includes lastPrUrl in deduplication guard when available", () => {
    const result = buildLoopPrompt({
      definition: makeDef(),
      repo: "org/repo",
      state: makeState({
        lastPrUrl: "https://github.com/org/repo/pull/50",
      }),
    })
    expect(result).toContain("https://github.com/org/repo/pull/50")
    expect(result).toContain("do NOT open a PR for the same change")
  })

  it("includes no_findings reporting instructions", () => {
    const result = buildLoopPrompt({
      definition: makeDef(),
      repo: "org/repo",
    })
    expect(result).toContain("NO_FINDINGS")
  })

  it("truncates long error messages in history", () => {
    const longError = "x".repeat(200)
    const result = buildLoopPrompt({
      definition: makeDef(),
      repo: "org/repo",
      state: makeState({
        totalRuns: 1,
        outcomes: [
          {
            runNumber: 1,
            startedAt: 1700000000000,
            finishedAt: 1700003600000,
            result: "errored",
            error: longError,
          },
        ],
      }),
    })
    expect(result).toContain("...")
    expect(result).not.toContain(longError)
  })

  it("only shows last 5 outcomes", () => {
    const outcomes = Array.from({ length: 8 }, (_, i) => ({
      runNumber: i + 1,
      startedAt: 1700000000000 + i * 100000000,
      finishedAt: 1700000000000 + i * 100000000 + 3600000,
      result: "no_findings" as const,
    }))
    const result = buildLoopPrompt({
      definition: makeDef(),
      repo: "org/repo",
      state: makeState({ totalRuns: 8, outcomes }),
    })
    expect(result).not.toContain("Run #1")
    expect(result).not.toContain("Run #3")
    expect(result).toContain("Run #4")
    expect(result).toContain("Run #8")
  })

  it("shows consecutive failures count", () => {
    const result = buildLoopPrompt({
      definition: makeDef(),
      repo: "org/repo",
      state: makeState({
        totalRuns: 5,
        consecutiveFailures: 2,
        outcomes: [
          {
            runNumber: 5,
            startedAt: 1700000000000,
            finishedAt: 1700003600000,
            result: "errored",
          },
        ],
      }),
    })
    expect(result).toContain("Consecutive failures: 2")
  })

  it("instructs agent to avoid duplicating previous work", () => {
    const result = buildLoopPrompt({
      definition: makeDef(),
      repo: "org/repo",
      state: makeState({
        totalRuns: 1,
        outcomes: [
          {
            runNumber: 1,
            startedAt: 1700000000000,
            finishedAt: 1700003600000,
            result: "pr_opened",
          },
        ],
      }),
    })
    expect(result).toContain("DIFFERENT target")
  })
})
