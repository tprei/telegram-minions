import { describe, it, expect, vi, beforeEach } from "vitest"
import type { SessionMeta, TopicSession, SessionDoneState } from "../../src/domain/session-types.js"
import type { SessionCompletionContext } from "../../src/handlers/handler-types.js"
import { LoopCompletionHandler, type LoopOutcomeRecorder, type LoopSchedulerProvider, type LoopTelegramNotifier, type LoopThreadCleaner } from "../../src/handlers/loop-completion-handler.js"
import { findPRByBranch } from "../../src/ci/ci-babysit.js"
import type { LoopState, LoopDefinition } from "../../src/loops/domain-types.js"

vi.mock("../../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock("../../src/ci/ci-babysit.js", () => ({
  extractPRUrl: vi.fn((text: string) => {
    const match = text.match(/https:\/\/github\.com\/[^\s)*\]>]+\/pull\/\d+/)
    return match ? match[0] : null
  }),
  findPRByBranch: vi.fn().mockResolvedValue(null),
}))

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}))

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}))

vi.mock("node:util", async () => {
  const actual = await vi.importActual<typeof import("node:util")>("node:util")
  return {
    ...actual,
    promisify: () => (...args: unknown[]) => mockExecFile(...args),
  }
})

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "s-1",
    threadId: 100,
    topicName: "test-topic",
    repo: "org/repo",
    cwd: "/tmp/repo",
    startedAt: Date.now() - 5000,
    mode: "task",
    ...overrides,
  }
}

function makeTopicSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 100,
    repo: "org/repo",
    cwd: "/tmp/repo",
    slug: "test-slug",
    conversation: [],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    activeSessionId: "s-1",
    ...overrides,
  }
}

function makeCtx(overrides: Partial<SessionCompletionContext> = {}): SessionCompletionContext {
  return {
    topicSession: makeTopicSession(),
    meta: makeMeta(),
    state: "completed" as SessionDoneState,
    sessionId: "s-1",
    durationMs: 5000,
    handled: false,
    ...overrides,
  }
}

function makeLoopState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    loopId: "lint-sweep",
    enabled: true,
    consecutiveFailures: 0,
    totalRuns: 5,
    outcomes: [],
    ...overrides,
  }
}

function makeLoopDef(overrides: Partial<LoopDefinition> = {}): LoopDefinition {
  return {
    id: "lint-sweep",
    name: "Lint Sweep",
    repo: "https://github.com/org/repo",
    intervalMs: 3600_000,
    prompt: "Find and fix one lint issue",
    enabled: true,
    ...overrides,
  }
}

function makeScheduler(
  states: Map<string, LoopState> = new Map(),
  definitions: Map<string, LoopDefinition> = new Map(),
): LoopOutcomeRecorder {
  return {
    recordOutcome: vi.fn(),
    getStates: () => states,
    getDefinitions: () => definitions,
  }
}

function makeProvider(scheduler: LoopOutcomeRecorder | null): LoopSchedulerProvider {
  return { get: () => scheduler }
}

function makeTelegram(): LoopTelegramNotifier {
  return {
    sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: 1 }),
    deleteForumTopic: vi.fn().mockResolvedValue(undefined),
  }
}

function makeCleaner(): LoopThreadCleaner {
  return {
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    deleteTopicSession: vi.fn(),
    broadcastSessionDeleted: vi.fn(),
  }
}

describe("LoopCompletionHandler", () => {
  let telegram: LoopTelegramNotifier
  let cleaner: LoopThreadCleaner

  beforeEach(() => {
    telegram = makeTelegram()
    cleaner = makeCleaner()
    mockExecFile.mockReset()
    vi.mocked(findPRByBranch).mockReset().mockResolvedValue(null)
  })

  it("skips non-loop sessions", async () => {
    const scheduler = makeScheduler()
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
    const ctx = makeCtx()

    await handler.handle(ctx)

    expect(ctx.handled).toBe(false)
    expect(scheduler.recordOutcome).not.toHaveBeenCalled()
  })

  it("skips when scheduler is null", async () => {
    const handler = new LoopCompletionHandler(makeProvider(null), telegram, cleaner)
    const ctx = makeCtx({
      topicSession: makeTopicSession({ loopId: "lint-sweep" }),
    })

    await handler.handle(ctx)

    expect(ctx.handled).toBe(false)
  })

  it("records pr_opened when PR found in conversation", async () => {
    const states = new Map([["lint-sweep", makeLoopState()]])
    const scheduler = makeScheduler(states)
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
    const ctx = makeCtx({
      topicSession: makeTopicSession({
        loopId: "lint-sweep",
        conversation: [
          { role: "user", text: "Fix a lint issue" },
          { role: "assistant", text: "I opened a PR: https://github.com/org/repo/pull/42" },
        ],
      }),
    })

    await handler.handle(ctx)

    expect(ctx.handled).toBe(true)
    expect(scheduler.recordOutcome).toHaveBeenCalledWith("lint-sweep", expect.objectContaining({
      result: "pr_opened",
      prUrl: "https://github.com/org/repo/pull/42",
      runNumber: 6,
    }))
  })

  it("records pr_opened when ctx.prUrl is already set", async () => {
    const states = new Map([["lint-sweep", makeLoopState()]])
    const scheduler = makeScheduler(states)
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
    const ctx = makeCtx({
      topicSession: makeTopicSession({ loopId: "lint-sweep" }),
      prUrl: "https://github.com/org/repo/pull/99",
    })

    await handler.handle(ctx)

    expect(scheduler.recordOutcome).toHaveBeenCalledWith("lint-sweep", expect.objectContaining({
      result: "pr_opened",
      prUrl: "https://github.com/org/repo/pull/99",
    }))
  })

  it("records no_findings when completed without PR", async () => {
    const states = new Map([["lint-sweep", makeLoopState()]])
    const scheduler = makeScheduler(states)
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
    const ctx = makeCtx({
      topicSession: makeTopicSession({ loopId: "lint-sweep" }),
    })

    await handler.handle(ctx)

    expect(scheduler.recordOutcome).toHaveBeenCalledWith("lint-sweep", expect.objectContaining({
      result: "no_findings",
      prUrl: undefined,
    }))
    expect(ctx.handled).toBe(true)
  })

  it("records errored on session error", async () => {
    const states = new Map([["lint-sweep", makeLoopState({ consecutiveFailures: 1 })]])
    const scheduler = makeScheduler(states)
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
    const ctx = makeCtx({
      topicSession: makeTopicSession({ loopId: "lint-sweep" }),
      state: "errored",
    })

    await handler.handle(ctx)

    expect(scheduler.recordOutcome).toHaveBeenCalledWith("lint-sweep", expect.objectContaining({
      result: "errored",
      error: "session errored",
    }))
  })

  it("records quota_exhausted", async () => {
    const states = new Map([["lint-sweep", makeLoopState({ consecutiveFailures: 1 })]])
    const scheduler = makeScheduler(states)
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
    const ctx = makeCtx({
      topicSession: makeTopicSession({ loopId: "lint-sweep" }),
      state: "quota_exhausted",
    })

    await handler.handle(ctx)

    expect(scheduler.recordOutcome).toHaveBeenCalledWith("lint-sweep", expect.objectContaining({
      result: "quota_exhausted",
    }))
  })

  it("sends alert when consecutive failures reach threshold", async () => {
    const state = makeLoopState({
      consecutiveFailures: 3,
      outcomes: [
        { runNumber: 3, startedAt: 1000, finishedAt: 2000, result: "errored", error: "session errored" },
        { runNumber: 4, startedAt: 3000, finishedAt: 4000, result: "errored", error: "session errored" },
        { runNumber: 5, startedAt: 5000, finishedAt: 6000, result: "errored", error: "session errored" },
      ],
    })
    const def = makeLoopDef()
    const states = new Map([["lint-sweep", state]])
    const defs = new Map([["lint-sweep", def]])
    const scheduler = makeScheduler(states, defs)
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
    const ctx = makeCtx({
      topicSession: makeTopicSession({ loopId: "lint-sweep" }),
      state: "errored",
    })

    await handler.handle(ctx)

    expect(telegram.sendMessage).toHaveBeenCalledOnce()
    const html = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(html).toContain("Loop alert: Lint Sweep")
    expect(html).toContain("3 consecutive failures")
  })

  it("shows auto-disabled message when loop is disabled", async () => {
    const state = makeLoopState({
      enabled: false,
      consecutiveFailures: 5,
      outcomes: [
        { runNumber: 3, startedAt: 1000, finishedAt: 2000, result: "errored" },
        { runNumber: 4, startedAt: 3000, finishedAt: 4000, result: "errored" },
        { runNumber: 5, startedAt: 5000, finishedAt: 6000, result: "errored" },
      ],
    })
    const def = makeLoopDef({ maxConsecutiveFailures: 5 })
    const states = new Map([["lint-sweep", state]])
    const defs = new Map([["lint-sweep", def]])
    const scheduler = makeScheduler(states, defs)
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
    const ctx = makeCtx({
      topicSession: makeTopicSession({ loopId: "lint-sweep" }),
      state: "errored",
    })

    await handler.handle(ctx)

    const html = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(html).toContain("Auto-disabled")
    expect(html).toContain("5/5")
  })

  it("does not alert when failures below threshold", async () => {
    const state = makeLoopState({ consecutiveFailures: 2 })
    const states = new Map([["lint-sweep", state]])
    const scheduler = makeScheduler(states)
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
    const ctx = makeCtx({
      topicSession: makeTopicSession({ loopId: "lint-sweep" }),
      state: "errored",
    })

    await handler.handle(ctx)

    expect(telegram.sendMessage).not.toHaveBeenCalled()
  })

  it("uses topicSession.prUrl when available", async () => {
    const states = new Map([["lint-sweep", makeLoopState()]])
    const scheduler = makeScheduler(states)
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
    const ctx = makeCtx({
      topicSession: makeTopicSession({
        loopId: "lint-sweep",
        prUrl: "https://github.com/org/repo/pull/77",
      }),
    })

    await handler.handle(ctx)

    expect(scheduler.recordOutcome).toHaveBeenCalledWith("lint-sweep", expect.objectContaining({
      result: "pr_opened",
      prUrl: "https://github.com/org/repo/pull/77",
    }))
  })

  it("includes threadId in outcome", async () => {
    const states = new Map([["lint-sweep", makeLoopState()]])
    const scheduler = makeScheduler(states)
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
    const ctx = makeCtx({
      topicSession: makeTopicSession({ loopId: "lint-sweep", threadId: 42 }),
      meta: makeMeta({ threadId: 42 }),
    })

    await handler.handle(ctx)

    expect(scheduler.recordOutcome).toHaveBeenCalledWith("lint-sweep", expect.objectContaining({
      threadId: 42,
    }))
  })

  it("handles telegram send failure gracefully", async () => {
    const state = makeLoopState({
      consecutiveFailures: 3,
      outcomes: [
        { runNumber: 3, startedAt: 1000, finishedAt: 2000, result: "errored" },
        { runNumber: 4, startedAt: 3000, finishedAt: 4000, result: "errored" },
        { runNumber: 5, startedAt: 5000, finishedAt: 6000, result: "errored" },
      ],
    })
    const states = new Map([["lint-sweep", state]])
    const defs = new Map([["lint-sweep", makeLoopDef()]])
    const scheduler = makeScheduler(states, defs)
    ;(telegram.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network error"))
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
    const ctx = makeCtx({
      topicSession: makeTopicSession({ loopId: "lint-sweep" }),
      state: "errored",
    })

    // Should not throw
    await handler.handle(ctx)
    expect(ctx.handled).toBe(true)
  })

  it("auto-closes the loop thread after completion", async () => {
    const states = new Map([["lint-sweep", makeLoopState()]])
    const scheduler = makeScheduler(states)
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
    const ctx = makeCtx({
      topicSession: makeTopicSession({ loopId: "lint-sweep", threadId: 42 }),
      meta: makeMeta({ threadId: 42 }),
    })

    await handler.handle(ctx)

    // Allow the async closeThread to settle
    await vi.waitFor(() => {
      expect(cleaner.deleteTopicSession).toHaveBeenCalledWith(42)
    })
    expect(cleaner.broadcastSessionDeleted).toHaveBeenCalledWith("test-slug")
    expect(telegram.deleteForumTopic).toHaveBeenCalledWith(42)
    expect(cleaner.removeWorkspace).toHaveBeenCalledWith(ctx.topicSession)
  })

  it("does not auto-close non-loop sessions", async () => {
    const scheduler = makeScheduler()
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
    const ctx = makeCtx()

    await handler.handle(ctx)

    expect(cleaner.deleteTopicSession).not.toHaveBeenCalled()
    expect(telegram.deleteForumTopic).not.toHaveBeenCalled()
  })

  describe("ensurePR", () => {
    function setupGitMocks(opts: {
      branch?: string
      hasUpstream?: boolean
      unpushedCount?: number
      commitMsg?: string
      prCreateUrl?: string
    }) {
      const {
        branch = "minion/test-slug",
        hasUpstream = false,
        unpushedCount = 1,
        commitMsg = "fix: resolve lint issue",
        prCreateUrl = "https://github.com/org/repo/pull/123",
      } = opts

      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cmd = args[0] as string
        const cmdArgs = args[1] as string[]

        if (cmd === "git" && cmdArgs[0] === "branch" && cmdArgs[1] === "--show-current") {
          return Promise.resolve({ stdout: `${branch}\n`, stderr: "" })
        }
        if (cmd === "git" && cmdArgs[0] === "rev-parse" && cmdArgs[1] === "--abbrev-ref") {
          if (hasUpstream) return Promise.resolve({ stdout: `origin/${branch}\n`, stderr: "" })
          return Promise.reject(new Error("no upstream"))
        }
        if (cmd === "git" && cmdArgs[0] === "rev-list" && cmdArgs[1] === "--count") {
          return Promise.resolve({ stdout: `${unpushedCount}\n`, stderr: "" })
        }
        if (cmd === "git" && cmdArgs[0] === "push") {
          return Promise.resolve({ stdout: "", stderr: "" })
        }
        if (cmd === "git" && cmdArgs[0] === "log") {
          return Promise.resolve({ stdout: `${commitMsg}\n`, stderr: "" })
        }
        if (cmd === "gh" && cmdArgs[0] === "pr" && cmdArgs[1] === "create") {
          return Promise.resolve({ stdout: `${prCreateUrl}\n`, stderr: "" })
        }
        return Promise.reject(new Error(`unexpected command: ${cmd} ${cmdArgs.join(" ")}`))
      })
    }

    it("pushes and creates PR when session has unpushed commits", async () => {
      setupGitMocks({})
      const states = new Map([["lint-sweep", makeLoopState()]])
      const scheduler = makeScheduler(states)
      const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
      const ctx = makeCtx({
        topicSession: makeTopicSession({ loopId: "lint-sweep" }),
      })

      await handler.handle(ctx)

      expect(scheduler.recordOutcome).toHaveBeenCalledWith("lint-sweep", expect.objectContaining({
        result: "pr_opened",
        prUrl: "https://github.com/org/repo/pull/123",
      }))
    })

    it("skips ensurePR when session errored", async () => {
      setupGitMocks({})
      const states = new Map([["lint-sweep", makeLoopState({ consecutiveFailures: 1 })]])
      const scheduler = makeScheduler(states)
      const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
      const ctx = makeCtx({
        topicSession: makeTopicSession({ loopId: "lint-sweep" }),
        state: "errored",
      })

      await handler.handle(ctx)

      expect(mockExecFile).not.toHaveBeenCalled()
      expect(scheduler.recordOutcome).toHaveBeenCalledWith("lint-sweep", expect.objectContaining({
        result: "errored",
      }))
    })

    it("skips ensurePR when PR already found in conversation", async () => {
      setupGitMocks({})
      const states = new Map([["lint-sweep", makeLoopState()]])
      const scheduler = makeScheduler(states)
      const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
      const ctx = makeCtx({
        topicSession: makeTopicSession({
          loopId: "lint-sweep",
          conversation: [
            { role: "assistant", text: "PR: https://github.com/org/repo/pull/42" },
          ],
        }),
      })

      await handler.handle(ctx)

      expect(mockExecFile).not.toHaveBeenCalled()
    })

    it("returns existing PR when branch already has one", async () => {
      setupGitMocks({})
      vi.mocked(findPRByBranch).mockResolvedValueOnce("https://github.com/org/repo/pull/existing")
      const states = new Map([["lint-sweep", makeLoopState()]])
      const scheduler = makeScheduler(states)
      const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
      const ctx = makeCtx({
        topicSession: makeTopicSession({ loopId: "lint-sweep" }),
      })

      await handler.handle(ctx)

      expect(scheduler.recordOutcome).toHaveBeenCalledWith("lint-sweep", expect.objectContaining({
        result: "pr_opened",
        prUrl: "https://github.com/org/repo/pull/existing",
      }))
    })

    it("records no_findings when no unpushed commits", async () => {
      setupGitMocks({ unpushedCount: 0 })
      const states = new Map([["lint-sweep", makeLoopState()]])
      const scheduler = makeScheduler(states)
      const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
      const ctx = makeCtx({
        topicSession: makeTopicSession({ loopId: "lint-sweep" }),
      })

      await handler.handle(ctx)

      expect(scheduler.recordOutcome).toHaveBeenCalledWith("lint-sweep", expect.objectContaining({
        result: "no_findings",
      }))
    })

    it("handles ensurePR failure gracefully", async () => {
      mockExecFile.mockRejectedValue(new Error("git not found"))
      const states = new Map([["lint-sweep", makeLoopState()]])
      const scheduler = makeScheduler(states)
      const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram, cleaner)
      const ctx = makeCtx({
        topicSession: makeTopicSession({ loopId: "lint-sweep" }),
      })

      await handler.handle(ctx)

      expect(scheduler.recordOutcome).toHaveBeenCalledWith("lint-sweep", expect.objectContaining({
        result: "no_findings",
      }))
      expect(ctx.handled).toBe(true)
    })
  })
})
