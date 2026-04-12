import { describe, it, expect, vi, beforeEach } from "vitest"
import type { SessionMeta, TopicSession, SessionDoneState } from "../../src/domain/session-types.js"
import type { SessionCompletionContext } from "../../src/handlers/handler-types.js"
import { StatsHandler } from "../../src/handlers/stats-handler.js"
import { QuotaHandler } from "../../src/handlers/quota-handler.js"
import { ShipAdvanceHandler } from "../../src/handlers/ship-advance-handler.js"
import { ModeCompletionHandler } from "../../src/handlers/mode-completion-handler.js"
import { TaskCompletionHandler } from "../../src/handlers/task-completion-handler.js"
import { QualityGateHandler } from "../../src/handlers/quality-gate-handler.js"
import { CIBabysitHandler } from "../../src/handlers/ci-babysit-handler.js"
import { DigestHandler } from "../../src/handlers/digest-handler.js"
import { ParentNotifyHandler } from "../../src/handlers/parent-notify-handler.js"
import { PendingFeedbackHandler } from "../../src/handlers/pending-feedback-handler.js"
import { CompletionHandlerChain } from "../../src/handlers/completion-handler-chain.js"
import { EventBus } from "../../src/events/event-bus.js"
import { makeMockTelegram, makeMockPlatform, makeMockObserver, makeMockStats } from "../test-helpers.js"

vi.mock("../../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
  loggers: {
    observer: { error: vi.fn() },
    ship: { error: vi.fn() },
  },
}))

vi.mock("../../src/sentry.js", () => ({
  captureException: vi.fn(),
}))

vi.mock("../../src/session/session-log.js", () => ({
  writeSessionLog: vi.fn(),
}))

vi.mock("../../src/ci/quality-gates.js", () => ({
  runQualityGates: vi.fn().mockReturnValue({ results: [], allPassed: true }),
}))

vi.mock("../../src/telegram/format.js", () => ({
  formatThinkComplete: vi.fn((slug: string) => `think done: ${slug}`),
  formatReviewComplete: vi.fn((slug: string) => `review done: ${slug}`),
  formatDagReviewComplete: vi.fn((slug: string) => `dag-review done: ${slug}`),
  formatPlanComplete: vi.fn((slug: string) => `plan done: ${slug}`),
  formatTaskComplete: vi.fn((slug: string) => `task done: ${slug}`),
  formatQualityReport: vi.fn(() => "quality report"),
  formatQualityReportForContext: vi.fn(() => "quality context"),
  formatPinnedStatus: vi.fn(() => "pinned status"),
}))

vi.mock("../../src/ci/ci-babysit.js", () => ({
  extractPRUrl: vi.fn(),
}))

vi.mock("../../src/conversation-digest.js", () => ({
  buildConversationDigest: vi.fn(),
  buildChildSessionDigest: vi.fn(),
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

// ── StatsHandler ──────────────────────────────────────────────────────

describe("StatsHandler", () => {
  it("records session stats", async () => {
    const stats = makeMockStats({ record: vi.fn().mockResolvedValue(undefined) })
    const handler = new StatsHandler(stats)
    const ctx = makeCtx()

    await handler.handle(ctx)

    expect(stats.record).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "test-slug",
        repo: "org/repo",
        mode: "task",
        state: "completed",
        durationMs: 5000,
      }),
    )
  })

  it("maps quota_exhausted state to errored", async () => {
    const stats = makeMockStats({ record: vi.fn().mockResolvedValue(undefined) })
    const handler = new StatsHandler(stats)
    const ctx = makeCtx({ state: "quota_exhausted" })

    await handler.handle(ctx)

    expect(stats.record).toHaveBeenCalledWith(
      expect.objectContaining({ state: "errored" }),
    )
  })
})

// ── QuotaHandler ──────────────────────────────────────────────────────

describe("QuotaHandler", () => {
  it("handles quota exhaustion with event present", async () => {
    const observer = makeMockObserver({ onSessionComplete: vi.fn().mockResolvedValue(undefined) })
    const quotaEvents = new Map([[100, { rawMessage: "rate limit" }]])
    const sleepHandler = { handleQuotaSleep: vi.fn() }
    const handler = new QuotaHandler(observer, quotaEvents, sleepHandler)
    const ctx = makeCtx({ state: "quota_exhausted" })

    await handler.handle(ctx)

    expect(ctx.handled).toBe(true)
    expect(sleepHandler.handleQuotaSleep).toHaveBeenCalledWith(ctx.topicSession, "rate limit")
    expect(quotaEvents.has(100)).toBe(false)
  })

  it("sets handled for quota_exhausted without event", async () => {
    const observer = makeMockObserver({ onSessionComplete: vi.fn() })
    const quotaEvents = new Map<number, { rawMessage: string }>()
    const sleepHandler = { handleQuotaSleep: vi.fn() }
    const handler = new QuotaHandler(observer, quotaEvents, sleepHandler)
    const ctx = makeCtx({ state: "quota_exhausted" })

    await handler.handle(ctx)

    expect(ctx.handled).toBe(true)
    expect(sleepHandler.handleQuotaSleep).not.toHaveBeenCalled()
  })

  it("passes through for non-quota states", async () => {
    const observer = makeMockObserver({ onSessionComplete: vi.fn() })
    const quotaEvents = new Map<number, { rawMessage: string }>()
    const sleepHandler = { handleQuotaSleep: vi.fn() }
    const handler = new QuotaHandler(observer, quotaEvents, sleepHandler)
    const ctx = makeCtx({ state: "completed" })

    await handler.handle(ctx)

    expect(ctx.handled).toBe(false)
  })
})

// ── ShipAdvanceHandler ────────────────────────────────────────────────

describe("ShipAdvanceHandler", () => {
  function makeShipDeps() {
    return {
      platform: makeMockPlatform(),
      observer: makeMockObserver({
        flushAndComplete: vi.fn().mockResolvedValue(undefined),
        onSessionComplete: vi.fn().mockResolvedValue(undefined),
      }),
      shipPipeline: { handleShipAdvance: vi.fn().mockResolvedValue(undefined) },
      pinnedMessages: { updateTopicTitle: vi.fn().mockResolvedValue(undefined) },
      artifactCleaner: { cleanBuildArtifacts: vi.fn() },
      sessionPersister: { persistTopicSessions: vi.fn().mockResolvedValue(undefined) },
    }
  }

  it("skips non-ship modes", async () => {
    const deps = makeShipDeps()
    const handler = new ShipAdvanceHandler(
      deps.platform, deps.observer, deps.shipPipeline,
      deps.pinnedMessages, deps.artifactCleaner, deps.sessionPersister,
    )
    const ctx = makeCtx()

    await handler.handle(ctx)

    expect(ctx.handled).toBe(false)
    expect(deps.shipPipeline.handleShipAdvance).not.toHaveBeenCalled()
  })

  it("advances ship pipeline on completion", async () => {
    const deps = makeShipDeps()
    const handler = new ShipAdvanceHandler(
      deps.platform, deps.observer, deps.shipPipeline,
      deps.pinnedMessages, deps.artifactCleaner, deps.sessionPersister,
    )
    const ts = makeTopicSession({
      mode: "ship-think",
      autoAdvance: { phase: "think", featureDescription: "feat", autoLand: false },
    })
    const ctx = makeCtx({ topicSession: ts, state: "completed" })

    await handler.handle(ctx)

    expect(ctx.handled).toBe(true)
    expect(deps.shipPipeline.handleShipAdvance).toHaveBeenCalledWith(ts)
  })

  it("sends paused message on error state", async () => {
    const deps = makeShipDeps()
    const handler = new ShipAdvanceHandler(
      deps.platform, deps.observer, deps.shipPipeline,
      deps.pinnedMessages, deps.artifactCleaner, deps.sessionPersister,
    )
    const ts = makeTopicSession({
      mode: "ship-plan",
      autoAdvance: { phase: "plan", featureDescription: "feat", autoLand: false },
    })
    const ctx = makeCtx({ topicSession: ts, state: "errored" })

    await handler.handle(ctx)

    expect(ctx.handled).toBe(true)
    expect(deps.platform.chat.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("Ship pipeline paused"),
      String(ts.threadId),
    )
    expect(deps.pinnedMessages.updateTopicTitle).toHaveBeenCalledWith(ts, "⚠️")
  })
})

// ── ModeCompletionHandler ─────────────────────────────────────────────

describe("ModeCompletionHandler", () => {
  function makeModeDeps() {
    return {
      platform: makeMockPlatform(),
      observer: makeMockObserver({ onSessionComplete: vi.fn().mockResolvedValue(undefined) }),
      pinnedMessages: { updateTopicTitle: vi.fn().mockResolvedValue(undefined) },
    }
  }

  it("handles think mode completion", async () => {
    const deps = makeModeDeps()
    const handler = new ModeCompletionHandler(deps.platform, deps.observer, deps.pinnedMessages)
    const ts = makeTopicSession({ mode: "think" })
    const ctx = makeCtx({ topicSession: ts })

    await handler.handle(ctx)

    expect(ctx.handled).toBe(true)
    expect(deps.pinnedMessages.updateTopicTitle).toHaveBeenCalledWith(ts, "💬")
    expect(deps.platform.chat.sendMessage).toHaveBeenCalledWith("think done: test-slug", String(ts.threadId))
  })

  it("handles review mode completion", async () => {
    const deps = makeModeDeps()
    const handler = new ModeCompletionHandler(deps.platform, deps.observer, deps.pinnedMessages)
    const ts = makeTopicSession({ mode: "review" })
    const ctx = makeCtx({ topicSession: ts })

    await handler.handle(ctx)

    expect(ctx.handled).toBe(true)
    expect(deps.platform.chat.sendMessage).toHaveBeenCalledWith("review done: test-slug", String(ts.threadId))
  })

  it("handles dag-review mode completion", async () => {
    const deps = makeModeDeps()
    const handler = new ModeCompletionHandler(deps.platform, deps.observer, deps.pinnedMessages)
    const ts = makeTopicSession({ mode: "dag-review" })
    const ctx = makeCtx({ topicSession: ts })

    await handler.handle(ctx)

    expect(ctx.handled).toBe(true)
    expect(deps.pinnedMessages.updateTopicTitle).toHaveBeenCalledWith(ts, "💬")
    expect(deps.platform.chat.sendMessage).toHaveBeenCalledWith("dag-review done: test-slug", String(ts.threadId))
  })

  it("handles plan mode completion", async () => {
    const deps = makeModeDeps()
    const handler = new ModeCompletionHandler(deps.platform, deps.observer, deps.pinnedMessages)
    const ts = makeTopicSession({ mode: "plan" })
    const ctx = makeCtx({ topicSession: ts })

    await handler.handle(ctx)

    expect(ctx.handled).toBe(true)
    expect(deps.platform.chat.sendMessage).toHaveBeenCalledWith("plan done: test-slug", String(ts.threadId))
  })

  it("handles errored state", async () => {
    const deps = makeModeDeps()
    const handler = new ModeCompletionHandler(deps.platform, deps.observer, deps.pinnedMessages)
    const ctx = makeCtx({ state: "errored" })

    await handler.handle(ctx)

    expect(ctx.handled).toBe(true)
    expect(ctx.topicSession.lastState).toBe("errored")
    expect(deps.pinnedMessages.updateTopicTitle).toHaveBeenCalledWith(ctx.topicSession, "❌")
  })

  it("passes through for completed task mode", async () => {
    const deps = makeModeDeps()
    const handler = new ModeCompletionHandler(deps.platform, deps.observer, deps.pinnedMessages)
    const ctx = makeCtx({ state: "completed" })

    await handler.handle(ctx)

    expect(ctx.handled).toBe(false)
  })
})

// ── QualityGateHandler ────────────────────────────────────────────────

describe("QualityGateHandler", () => {
  it("runs quality gates for completed sessions", async () => {
    const { runQualityGates } = await import("../../src/ci/quality-gates.js")
    const mockRunQG = vi.mocked(runQualityGates)
    mockRunQG.mockReturnValue({ results: [{ gate: "tsc", passed: true, output: "ok" }], allPassed: true })

    const platform = makeMockPlatform()
    const pusher = { pushToConversation: vi.fn() }
    const handler = new QualityGateHandler(platform, pusher)
    const ctx = makeCtx()

    await handler.handle(ctx)

    expect(ctx.qualityReport).toEqual({ results: [{ gate: "tsc", passed: true, output: "ok" }], allPassed: true })
    expect(platform.chat.sendMessage).toHaveBeenCalledWith("quality report", "100")
  })

  it("pushes context on failed quality gates", async () => {
    const { runQualityGates } = await import("../../src/ci/quality-gates.js")
    const mockRunQG = vi.mocked(runQualityGates)
    mockRunQG.mockReturnValue({ results: [{ gate: "tsc", passed: false, output: "errors" }], allPassed: false })

    const platform = makeMockPlatform()
    const pusher = { pushToConversation: vi.fn() }
    const handler = new QualityGateHandler(platform, pusher)
    const ctx = makeCtx()

    await handler.handle(ctx)

    expect(pusher.pushToConversation).toHaveBeenCalledWith(
      ctx.topicSession,
      expect.objectContaining({ role: "user" }),
    )
  })

  it("skips for non-completed state", async () => {
    const platform = makeMockPlatform()
    const pusher = { pushToConversation: vi.fn() }
    const handler = new QualityGateHandler(platform, pusher)
    const ctx = makeCtx({ state: "errored" })

    await handler.handle(ctx)

    expect(ctx.qualityReport).toBeUndefined()
  })
})

// ── CIBabysitHandler ──────────────────────────────────────────────────

describe("CIBabysitHandler", () => {
  it("babysits PR for standalone task", async () => {
    const ciBabysitter = {
      babysitPR: vi.fn().mockResolvedValue(undefined),
      queueDeferredBabysit: vi.fn(),
    }
    const handler = new CIBabysitHandler({ babysitEnabled: true }, ciBabysitter)
    const ctx = makeCtx({ prUrl: "https://github.com/org/repo/pull/1" })

    await handler.handle(ctx)

    expect(ciBabysitter.babysitPR).toHaveBeenCalledWith(
      ctx.topicSession,
      "https://github.com/org/repo/pull/1",
      undefined,
    )
  })

  it("queues deferred babysit for child sessions", async () => {
    const ciBabysitter = {
      babysitPR: vi.fn(),
      queueDeferredBabysit: vi.fn(),
    }
    const handler = new CIBabysitHandler({ babysitEnabled: true }, ciBabysitter)
    const ts = makeTopicSession({ parentThreadId: 50 })
    const ctx = makeCtx({ topicSession: ts, prUrl: "https://github.com/org/repo/pull/1" })

    await handler.handle(ctx)

    expect(ciBabysitter.queueDeferredBabysit).toHaveBeenCalledWith(50, expect.objectContaining({ prUrl: "https://github.com/org/repo/pull/1" }))
    expect(ciBabysitter.babysitPR).not.toHaveBeenCalled()
  })

  it("skips DAG children", async () => {
    const ciBabysitter = {
      babysitPR: vi.fn(),
      queueDeferredBabysit: vi.fn(),
    }
    const handler = new CIBabysitHandler({ babysitEnabled: true }, ciBabysitter)
    const ts = makeTopicSession({ dagId: "dag-1" })
    const ctx = makeCtx({ topicSession: ts, prUrl: "https://github.com/org/repo/pull/1" })

    await handler.handle(ctx)

    expect(ciBabysitter.babysitPR).not.toHaveBeenCalled()
    expect(ciBabysitter.queueDeferredBabysit).not.toHaveBeenCalled()
  })

  it("skips when CI babysit disabled", async () => {
    const ciBabysitter = { babysitPR: vi.fn(), queueDeferredBabysit: vi.fn() }
    const handler = new CIBabysitHandler({ babysitEnabled: false }, ciBabysitter)
    const ctx = makeCtx({ prUrl: "https://github.com/org/repo/pull/1" })

    await handler.handle(ctx)

    expect(ciBabysitter.babysitPR).not.toHaveBeenCalled()
  })

  it("skips when no PR URL", async () => {
    const ciBabysitter = { babysitPR: vi.fn(), queueDeferredBabysit: vi.fn() }
    const handler = new CIBabysitHandler({ babysitEnabled: true }, ciBabysitter)
    const ctx = makeCtx()

    await handler.handle(ctx)

    expect(ciBabysitter.babysitPR).not.toHaveBeenCalled()
  })
})

// ── DigestHandler ─────────────────────────────────────────────────────

describe("DigestHandler", () => {
  it("extracts PR and pins status for task mode", async () => {
    const { extractPRUrl } = await import("../../src/ci/ci-babysit.js")
    vi.mocked(extractPRUrl).mockReturnValue(null)

    const topicSessions = { get: vi.fn() }
    const profileStore = { get: vi.fn() }
    const pinnedMessages = { pinThreadMessage: vi.fn().mockResolvedValue(undefined) }
    const handler = new DigestHandler(topicSessions, profileStore, pinnedMessages)
    const ctx = makeCtx()

    await handler.handle(ctx)

    expect(pinnedMessages.pinThreadMessage).toHaveBeenCalledWith(
      ctx.topicSession,
      "pinned status",
    )
  })

  it("skips non-task modes", async () => {
    const topicSessions = { get: vi.fn() }
    const profileStore = { get: vi.fn() }
    const pinnedMessages = { pinThreadMessage: vi.fn() }
    const handler = new DigestHandler(topicSessions, profileStore, pinnedMessages)
    const ts = makeTopicSession({ mode: "plan" })
    const ctx = makeCtx({ topicSession: ts })

    await handler.handle(ctx)

    expect(pinnedMessages.pinThreadMessage).not.toHaveBeenCalled()
  })

  it("skips errored state", async () => {
    const topicSessions = { get: vi.fn() }
    const profileStore = { get: vi.fn() }
    const pinnedMessages = { pinThreadMessage: vi.fn() }
    const handler = new DigestHandler(topicSessions, profileStore, pinnedMessages)
    const ctx = makeCtx({ state: "errored" })

    await handler.handle(ctx)

    expect(pinnedMessages.pinThreadMessage).not.toHaveBeenCalled()
  })
})

// ── ParentNotifyHandler ───────────────────────────────────────────────

describe("ParentNotifyHandler", () => {
  it("notifies parent of child completion", async () => {
    const notifier = { notifyParentOfChildComplete: vi.fn().mockResolvedValue(undefined) }
    const handler = new ParentNotifyHandler(notifier)
    const ctx = makeCtx()

    await handler.handle(ctx)

    expect(notifier.notifyParentOfChildComplete).toHaveBeenCalledWith(ctx.topicSession, "completed")
  })

  it("catches and logs errors", async () => {
    const notifier = { notifyParentOfChildComplete: vi.fn().mockRejectedValue(new Error("nope")) }
    const handler = new ParentNotifyHandler(notifier)
    const ctx = makeCtx()

    await expect(handler.handle(ctx)).resolves.toBeUndefined()
  })
})

// ── PendingFeedbackHandler ────────────────────────────────────────────

describe("PendingFeedbackHandler", () => {
  it("processes pending feedback", async () => {
    const feedbackProcessor = { handleTopicFeedback: vi.fn().mockResolvedValue(undefined) }
    const handler = new PendingFeedbackHandler(feedbackProcessor)
    const ts = makeTopicSession({ pendingFeedback: ["fix this", "also that"] })
    const ctx = makeCtx({ topicSession: ts })

    await handler.handle(ctx)

    expect(feedbackProcessor.handleTopicFeedback).toHaveBeenCalledWith(ts, "fix this\n\nalso that")
    expect(ts.pendingFeedback).toEqual([])
  })

  it("skips when no pending feedback", async () => {
    const feedbackProcessor = { handleTopicFeedback: vi.fn() }
    const handler = new PendingFeedbackHandler(feedbackProcessor)
    const ctx = makeCtx()

    await handler.handle(ctx)

    expect(feedbackProcessor.handleTopicFeedback).not.toHaveBeenCalled()
  })

  it("catches and logs feedback errors", async () => {
    const feedbackProcessor = { handleTopicFeedback: vi.fn().mockRejectedValue(new Error("fail")) }
    const handler = new PendingFeedbackHandler(feedbackProcessor)
    const ts = makeTopicSession({ pendingFeedback: ["fix this"] })
    const ctx = makeCtx({ topicSession: ts })

    await expect(handler.handle(ctx)).resolves.toBeUndefined()
  })
})

// ── TaskCompletionHandler ─────────────────────────────────────────────

describe("TaskCompletionHandler", () => {
  function makeTaskDeps() {
    return {
      platform: makeMockPlatform(),
      observer: makeMockObserver({ flushAndComplete: vi.fn().mockResolvedValue(undefined) }),
      pinnedMessages: { updateTopicTitle: vi.fn().mockResolvedValue(undefined) },
      artifactCleaner: { cleanBuildArtifacts: vi.fn() },
    }
  }

  it("orchestrates flush, inner handlers, and cleanup", async () => {
    const deps = makeTaskDeps()
    const innerHandler = { name: "mock", handle: vi.fn().mockResolvedValue(undefined) }
    const handler = new TaskCompletionHandler(
      deps.platform, deps.observer,
      deps.pinnedMessages, deps.artifactCleaner, [innerHandler],
    )
    const ctx = makeCtx()

    await handler.handle(ctx)

    expect(ctx.handled).toBe(true)
    expect(ctx.topicSession.lastState).toBe("completed")
    expect(deps.observer.flushAndComplete).toHaveBeenCalled()
    expect(deps.platform.chat.sendMessage).toHaveBeenCalledWith("task done: test-slug", "100")
    expect(innerHandler.handle).toHaveBeenCalledWith(ctx)
    expect(deps.artifactCleaner.cleanBuildArtifacts).toHaveBeenCalledWith("/tmp/repo")
  })

  it("skips non-completed state", async () => {
    const deps = makeTaskDeps()
    const handler = new TaskCompletionHandler(
      deps.platform, deps.observer,
      deps.pinnedMessages, deps.artifactCleaner, [],
    )
    const ctx = makeCtx({ state: "errored" })

    await handler.handle(ctx)

    expect(ctx.handled).toBe(false)
    expect(deps.observer.flushAndComplete).not.toHaveBeenCalled()
  })

  it("cleans artifacts even when flush errors", async () => {
    const deps = makeTaskDeps()
    deps.observer.flushAndComplete.mockRejectedValue(new Error("flush error"))
    const handler = new TaskCompletionHandler(
      deps.platform, deps.observer,
      deps.pinnedMessages, deps.artifactCleaner, [],
    )
    const ctx = makeCtx()

    await handler.handle(ctx)

    expect(deps.artifactCleaner.cleanBuildArtifacts).toHaveBeenCalled()
  })
})

// ── CompletionHandlerChain ────────────────────────────────────────────

describe("CompletionHandlerChain", () => {
  function makeChainDeps() {
    return {
      topicSessions: { get: vi.fn() },
      sessions: { delete: vi.fn() },
      broadcaster: { broadcastSession: vi.fn() },
      pinnedSummary: { updatePinnedSummary: vi.fn() },
      sessionPersister: { persistTopicSessions: vi.fn().mockResolvedValue(undefined) },
      replyQueues: { getQueue: vi.fn() },
    }
  }

  it("runs handlers in registration order", async () => {
    const deps = makeChainDeps()
    const chain = new CompletionHandlerChain(
      deps.topicSessions, deps.sessions, deps.broadcaster,
      deps.pinnedSummary, deps.sessionPersister, deps.replyQueues,
    )

    const order: string[] = []
    chain.register({
      name: "first",
      handle: async () => { order.push("first") },
    })
    chain.register({
      name: "second",
      handle: async () => { order.push("second") },
    })

    await chain.run(makeCtx())

    expect(order).toEqual(["first", "second"])
  })

  it("stops on handled flag", async () => {
    const deps = makeChainDeps()
    const chain = new CompletionHandlerChain(
      deps.topicSessions, deps.sessions, deps.broadcaster,
      deps.pinnedSummary, deps.sessionPersister, deps.replyQueues,
    )

    const order: string[] = []
    chain.register({
      name: "early-exit",
      handle: async (ctx) => { order.push("early-exit"); ctx.handled = true },
    })
    chain.register({
      name: "skipped",
      handle: async () => { order.push("skipped") },
    })

    await chain.run(makeCtx())

    expect(order).toEqual(["early-exit"])
  })

  it("continues past handler errors", async () => {
    const deps = makeChainDeps()
    const chain = new CompletionHandlerChain(
      deps.topicSessions, deps.sessions, deps.broadcaster,
      deps.pinnedSummary, deps.sessionPersister, deps.replyQueues,
    )

    const order: string[] = []
    chain.register({
      name: "thrower",
      handle: async () => { order.push("thrower"); throw new Error("boom") },
    })
    chain.register({
      name: "survivor",
      handle: async () => { order.push("survivor") },
    })

    await chain.run(makeCtx())

    expect(order).toEqual(["thrower", "survivor"])
  })

  it("subscribes to EventBus and handles session.completed", async () => {
    const deps = makeChainDeps()
    const ts = makeTopicSession()
    deps.topicSessions.get.mockReturnValue(ts)

    const chain = new CompletionHandlerChain(
      deps.topicSessions, deps.sessions, deps.broadcaster,
      deps.pinnedSummary, deps.sessionPersister, deps.replyQueues,
    )

    const handled = vi.fn()
    chain.register({
      name: "test-handler",
      handle: async (ctx) => { handled(ctx.state) },
    })

    const bus = new EventBus()
    chain.subscribe(bus)

    await bus.emit({
      type: "session.completed",
      timestamp: Date.now(),
      meta: makeMeta(),
      state: "completed",
    })

    expect(handled).toHaveBeenCalledWith("completed")
    expect(deps.sessions.delete).toHaveBeenCalledWith(100)
    expect(deps.sessionPersister.persistTopicSessions).toHaveBeenCalled()
  })

  it("skips when activeSessionId does not match", async () => {
    const deps = makeChainDeps()
    const ts = makeTopicSession({ activeSessionId: "other-session" })
    deps.topicSessions.get.mockReturnValue(ts)

    const chain = new CompletionHandlerChain(
      deps.topicSessions, deps.sessions, deps.broadcaster,
      deps.pinnedSummary, deps.sessionPersister, deps.replyQueues,
    )

    const handled = vi.fn()
    chain.register({ name: "test", handle: handled })

    const bus = new EventBus()
    chain.subscribe(bus)

    await bus.emit({
      type: "session.completed",
      timestamp: Date.now(),
      meta: makeMeta(),
      state: "completed",
    })

    expect(handled).not.toHaveBeenCalled()
  })

  it("runs post-chain handlers even when ctx.handled is true", async () => {
    const deps = makeChainDeps()
    const chain = new CompletionHandlerChain(
      deps.topicSessions, deps.sessions, deps.broadcaster,
      deps.pinnedSummary, deps.sessionPersister, deps.replyQueues,
    )

    const order: string[] = []
    chain.register({
      name: "early-exit",
      handle: async (ctx) => { order.push("early-exit"); ctx.handled = true },
    })
    chain.register({
      name: "skipped",
      handle: async () => { order.push("skipped") },
    })
    chain.registerPostChain({
      name: "always-runs",
      handle: async () => { order.push("always-runs") },
    })

    await chain.run(makeCtx())

    // run() only runs chain handlers, not post-chain
    expect(order).toEqual(["early-exit"])

    // Full integration: post-chain handlers run via onSessionCompleted
    order.length = 0
    const ts = makeTopicSession()
    deps.topicSessions.get.mockReturnValue(ts)

    const bus = new EventBus()
    chain.subscribe(bus)

    await bus.emit({
      type: "session.completed",
      timestamp: Date.now(),
      meta: makeMeta(),
      state: "completed",
    })

    expect(order).toContain("early-exit")
    expect(order).not.toContain("skipped")
    expect(order).toContain("always-runs")
  })

  it("clears delivered replies after chain completes", async () => {
    const deps = makeChainDeps()
    const ts = makeTopicSession()
    deps.topicSessions.get.mockReturnValue(ts)
    const queue = { clearDelivered: vi.fn().mockResolvedValue(undefined) }
    deps.replyQueues.getQueue.mockReturnValue(queue)

    const chain = new CompletionHandlerChain(
      deps.topicSessions, deps.sessions, deps.broadcaster,
      deps.pinnedSummary, deps.sessionPersister, deps.replyQueues,
    )

    const bus = new EventBus()
    chain.subscribe(bus)

    await bus.emit({
      type: "session.completed",
      timestamp: Date.now(),
      meta: makeMeta(),
      state: "completed",
    })

    expect(queue.clearDelivered).toHaveBeenCalled()
  })
})
