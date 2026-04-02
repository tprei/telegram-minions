import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Dispatcher } from "../src/orchestration/dispatcher.js"
import type { TelegramClient } from "../src/telegram/telegram.js"
import { Observer } from "../src/telegram/observer.js"
import type { MinionConfig } from "../src/config/config-types.js"
import type { TopicSession, SessionMeta } from "../src/types.js"
import {
  formatQuotaSleep,
  formatQuotaResume,
  formatQuotaExhausted,
} from "../src/telegram/format.js"

function makeMockTelegram(): TelegramClient {
  return {
    deleteForumTopic: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1, date: 0, chat: { id: 1, type: "supergroup" } }),
    editMessage: vi.fn().mockResolvedValue(true),
    createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 42, name: "test" }),
    getUpdates: vi.fn().mockResolvedValue([]),
    downloadFile: vi.fn().mockResolvedValue(false),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    pinMessage: vi.fn().mockResolvedValue(true),
    editForumTopic: vi.fn().mockResolvedValue(true),
    sendChatAction: vi.fn().mockResolvedValue(true),
  } as unknown as TelegramClient
}

function makeConfig(overrides?: Partial<MinionConfig>): MinionConfig {
  return {
    telegram: { token: "test", chatId: "1", allowedUserIds: [1] },
    workspace: {
      root: "/tmp/test-workspace",
      maxConcurrentSessions: 2,
      maxDagConcurrency: 3,
      maxSplitItems: 10,
      sessionTokenBudget: 100_000,
      sessionBudgetUsd: 0,
      sessionTimeoutMs: 60_000,
      sessionInactivityTimeoutMs: 300_000,
      staleTtlMs: 86_400_000,
      cleanupIntervalMs: 3_600_000,
      maxConversationLength: 50,
      maxJudgeOptions: 6,
      judgeAdvocateTimeoutMs: 120_000,
      judgeTimeoutMs: 300_000,
    },
    repos: {},
    goose: { provider: "test", model: "test" },
    claude: { planModel: "test", thinkModel: "test", reviewModel: "test" },
    mcp: {
      browserEnabled: false,
      githubEnabled: false,
      context7Enabled: false,
      sentryEnabled: false,
      sentryOrgSlug: "",
      sentryProjectSlug: "",
      supabaseEnabled: false,
      supabaseProjectRef: "",
      zaiEnabled: false,
    },
    ci: {
      babysitEnabled: false,
      maxRetries: 0,
      pollIntervalMs: 10_000,
      pollTimeoutMs: 600_000,
      dagCiPolicy: "block",
    },
    quota: {
      retryMax: 3,
      defaultSleepMs: 1_800_000,
      sleepBufferMs: 60_000,
    },
    ...overrides,
  } as MinionConfig
}

function makeTopicSession(overrides?: Partial<TopicSession>): TopicSession {
  return {
    threadId: 100,
    repo: "test-repo",
    cwd: "/tmp/test-workspace/test-slug",
    slug: "test-slug",
    conversation: [{ role: "user", text: "fix the bug" }],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

function getPrivate(dispatcher: Dispatcher): {
  topicSessions: Map<number, TopicSession>
  sessions: Map<number, unknown>
  quotaEvents: Map<number, { resetAt?: number; rawMessage: string }>
  quotaSleepTimers: Map<number, ReturnType<typeof setTimeout>>
  handleSessionComplete: (ts: TopicSession, m: SessionMeta, state: "completed" | "errored" | "quota_exhausted", sid: string) => void
  handleQuotaSleep: (ts: TopicSession, rawMessage: string) => void
  scheduleQuotaResume: (ts: TopicSession, sleepMs: number) => void
  resumeAfterQuotaSleep: (ts: TopicSession) => Promise<void>
  clearQuotaSleepTimer: (threadId: number) => void
} {
  return dispatcher as unknown as ReturnType<typeof getPrivate>
}

describe("formatQuotaSleep", () => {
  it("includes slug, minutes, and attempt count", () => {
    const result = formatQuotaSleep("test-slug", 30 * 60_000, 1, 3)
    expect(result).toContain("test-slug")
    expect(result).toContain("30 min")
    expect(result).toContain("attempt 1/3")
    expect(result).toContain("Quota exhausted")
  })

  it("rounds minutes", () => {
    const result = formatQuotaSleep("s", 45 * 60_000 + 30_000, 2, 3)
    expect(result).toContain("46 min")
  })
})

describe("formatQuotaResume", () => {
  it("includes slug and attempt count", () => {
    const result = formatQuotaResume("test-slug", 2)
    expect(result).toContain("test-slug")
    expect(result).toContain("attempt 2")
    expect(result).toContain("Resuming")
  })
})

describe("formatQuotaExhausted", () => {
  it("includes slug and max retries", () => {
    const result = formatQuotaExhausted("test-slug", 3)
    expect(result).toContain("test-slug")
    expect(result).toContain("3/3")
    expect(result).toContain("retries exhausted")
  })
})

describe("quota sleep in dispatcher", () => {
  let telegram: TelegramClient
  let dispatcher: Dispatcher
  let priv: ReturnType<typeof getPrivate>

  beforeEach(() => {
    vi.useFakeTimers()
    telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, "1")
    dispatcher = new Dispatcher(telegram, observer, config)
    priv = getPrivate(dispatcher)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("handleSessionComplete triggers quota sleep when quota event is present", () => {
    const ts = makeTopicSession({ activeSessionId: "sess-1" })
    priv.topicSessions.set(100, ts)
    priv.quotaEvents.set(100, { rawMessage: "Usage limit reached. Resets in 30 minutes.", resetAt: undefined })

    const meta: SessionMeta = {
      sessionId: "sess-1",
      threadId: 100,
      topicName: "test-slug",
      repo: "test-repo",
      cwd: "/tmp/test",
      startedAt: Date.now() - 5000,
      mode: "task",
    }

    priv.handleSessionComplete(ts, meta, "quota_exhausted", "sess-1")

    expect(ts.lastState).toBe("quota_exhausted")
    expect(ts.quotaRetryCount).toBe(1)
    expect(ts.quotaSleepUntil).toBeGreaterThan(Date.now())
    expect(priv.quotaSleepTimers.has(100)).toBe(true)
    expect((telegram.sendMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.stringContaining("Quota exhausted"),
      100,
    )
  })

  it("does not trigger quota sleep on normal errors", () => {
    const ts = makeTopicSession({ activeSessionId: "sess-1" })
    priv.topicSessions.set(100, ts)
    // No quota event set

    const meta: SessionMeta = {
      sessionId: "sess-1",
      threadId: 100,
      topicName: "test-slug",
      repo: "test-repo",
      cwd: "/tmp/test",
      startedAt: Date.now() - 5000,
      mode: "task",
    }

    priv.handleSessionComplete(ts, meta, "errored", "sess-1")

    expect(ts.lastState).toBe("errored")
    expect(ts.quotaSleepUntil).toBeUndefined()
    expect(priv.quotaSleepTimers.has(100)).toBe(false)
  })

  it("does not trigger quota sleep on completion even if quota event exists", () => {
    const ts = makeTopicSession({ activeSessionId: "sess-1" })
    priv.topicSessions.set(100, ts)
    priv.quotaEvents.set(100, { rawMessage: "quota error", resetAt: undefined })

    const meta: SessionMeta = {
      sessionId: "sess-1",
      threadId: 100,
      topicName: "test-slug",
      repo: "test-repo",
      cwd: "/tmp/test",
      startedAt: Date.now() - 5000,
      mode: "task",
    }

    priv.handleSessionComplete(ts, meta, "completed", "sess-1")

    expect(ts.quotaSleepUntil).toBeUndefined()
    expect(priv.quotaSleepTimers.has(100)).toBe(false)
  })

  it("reports exhaustion when retryMax is exceeded", () => {
    const config = makeConfig({ quota: { retryMax: 1, defaultSleepMs: 60_000, sleepBufferMs: 60_000 } })
    const observer = new Observer(telegram, "1")
    dispatcher = new Dispatcher(telegram, observer, config)
    priv = getPrivate(dispatcher)

    const ts = makeTopicSession({ activeSessionId: "sess-1", quotaRetryCount: 1 })
    priv.topicSessions.set(100, ts)
    priv.quotaEvents.set(100, { rawMessage: "usage limit", resetAt: undefined })

    const meta: SessionMeta = {
      sessionId: "sess-1",
      threadId: 100,
      topicName: "test-slug",
      repo: "test-repo",
      cwd: "/tmp/test",
      startedAt: Date.now() - 5000,
      mode: "task",
    }

    priv.handleSessionComplete(ts, meta, "quota_exhausted", "sess-1")

    expect(ts.lastState).toBe("quota_exhausted")
    expect(ts.quotaRetryCount).toBe(2)
    expect(ts.quotaSleepUntil).toBeUndefined()
    expect(priv.quotaSleepTimers.has(100)).toBe(false)
    expect((telegram.sendMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.stringContaining("retries exhausted"),
      100,
    )
  })

  it("stop command cancels quota sleep", async () => {
    const ts = makeTopicSession({ quotaSleepUntil: Date.now() + 60_000, lastState: "quota_exhausted", quotaRetryCount: 1 })
    priv.topicSessions.set(100, ts)
    priv.quotaSleepTimers.set(100, setTimeout(() => {}, 60_000))

    await dispatcher.handleStopCommand(100)

    expect(ts.quotaSleepUntil).toBeUndefined()
    expect(ts.lastState).toBeUndefined()
    expect(priv.quotaSleepTimers.has(100)).toBe(false)
    expect((telegram.sendMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.stringContaining("Quota sleep cancelled"),
      100,
    )
  })

  it("close command clears quota sleep timer", async () => {
    const ts = makeTopicSession({ quotaSleepUntil: Date.now() + 60_000, lastState: "quota_exhausted" })
    priv.topicSessions.set(100, ts)
    const timerCb = vi.fn()
    priv.quotaSleepTimers.set(100, setTimeout(timerCb, 60_000))

    await dispatcher.handleCloseCommand(100)

    expect(priv.quotaSleepTimers.has(100)).toBe(false)
    expect(priv.topicSessions.has(100)).toBe(false)
  })

  it("clearQuotaSleepTimer is idempotent for non-existent timers", () => {
    priv.clearQuotaSleepTimer(999)
    expect(priv.quotaSleepTimers.has(999)).toBe(false)
  })

  it("scheduleQuotaResume replaces existing timer", () => {
    const ts = makeTopicSession()
    priv.topicSessions.set(100, ts)

    const firstTimer = setTimeout(() => {}, 100_000)
    priv.quotaSleepTimers.set(100, firstTimer)

    priv.scheduleQuotaResume(ts, 60_000)

    const newTimer = priv.quotaSleepTimers.get(100)
    expect(newTimer).toBeDefined()
    expect(newTimer).not.toBe(firstTimer)
  })

  it("stop() clears all quota sleep timers", () => {
    const ts1 = makeTopicSession({ threadId: 100 })
    const ts2 = makeTopicSession({ threadId: 200 })
    priv.topicSessions.set(100, ts1)
    priv.topicSessions.set(200, ts2)
    priv.quotaSleepTimers.set(100, setTimeout(() => {}, 60_000))
    priv.quotaSleepTimers.set(200, setTimeout(() => {}, 60_000))

    dispatcher.stop()

    expect(priv.quotaSleepTimers.size).toBe(0)
  })
})

describe("quota sleep persistence", () => {
  it("loadPersistedSessions re-arms timer for sessions with quotaSleepUntil in future", async () => {
    vi.useFakeTimers()
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, "1")
    const dispatcher = new Dispatcher(telegram, observer, config)
    const priv = getPrivate(dispatcher)

    // Mock the store to return a session with quotaSleepUntil
    const futureTime = Date.now() + 300_000
    const session = makeTopicSession({
      quotaSleepUntil: futureTime,
      lastState: "quota_exhausted",
      quotaRetryCount: 1,
    })

    const store = (dispatcher as unknown as { store: { load: () => Promise<unknown> } }).store
    vi.spyOn(store, "load").mockResolvedValue({
      active: new Map([[100, session]]),
      expired: new Map(),
      offset: 0,
    })

    const dagStore = (dispatcher as unknown as { dagStore: { load: () => Promise<unknown> } }).dagStore
    vi.spyOn(dagStore, "load").mockResolvedValue(new Map())

    await dispatcher.loadPersistedSessions()

    expect(priv.quotaSleepTimers.has(100)).toBe(true)
    expect(priv.topicSessions.has(100)).toBe(true)

    vi.useRealTimers()
  })
})
