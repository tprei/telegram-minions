import { describe, it, expect, vi, beforeEach } from "vitest"
import type { SessionMeta, TopicSession, SessionDoneState } from "../../src/domain/session-types.js"
import type { SessionCompletionContext } from "../../src/handlers/handler-types.js"
import { LoopCompletionHandler, type LoopOutcomeRecorder, type LoopSchedulerProvider, type LoopTelegramNotifier } from "../../src/handlers/loop-completion-handler.js"
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
}))

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
  }
}

describe("LoopCompletionHandler", () => {
  let telegram: LoopTelegramNotifier

  beforeEach(() => {
    telegram = makeTelegram()
  })

  it("skips non-loop sessions", async () => {
    const scheduler = makeScheduler()
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram)
    const ctx = makeCtx()

    await handler.handle(ctx)

    expect(ctx.handled).toBe(false)
    expect(scheduler.recordOutcome).not.toHaveBeenCalled()
  })

  it("skips when scheduler is null", async () => {
    const handler = new LoopCompletionHandler(makeProvider(null), telegram)
    const ctx = makeCtx({
      topicSession: makeTopicSession({ loopId: "lint-sweep" }),
    })

    await handler.handle(ctx)

    expect(ctx.handled).toBe(false)
  })

  it("records pr_opened when PR found in conversation", async () => {
    const states = new Map([["lint-sweep", makeLoopState()]])
    const scheduler = makeScheduler(states)
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram)
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
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram)
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
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram)
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
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram)
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
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram)
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
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram)
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
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram)
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
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram)
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
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram)
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
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram)
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
    const handler = new LoopCompletionHandler(makeProvider(scheduler), telegram)
    const ctx = makeCtx({
      topicSession: makeTopicSession({ loopId: "lint-sweep" }),
      state: "errored",
    })

    // Should not throw
    await handler.handle(ctx)
    expect(ctx.handled).toBe(true)
  })
})
