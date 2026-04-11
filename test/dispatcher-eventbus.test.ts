import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Dispatcher } from "../src/orchestration/dispatcher.js"
import type { TelegramClient } from "../src/telegram/telegram.js"
import { TelegramPlatform } from "../src/telegram/telegram-platform.js"
import { Observer } from "../src/telegram/observer.js"
import type { MinionConfig } from "../src/config/config-types.js"
import type { TopicSession, SessionMeta } from "../src/domain/session-types.js"
import { EventBus } from "../src/events/event-bus.js"

vi.mock("../src/session/session-log.js", () => ({
  writeSessionLog: vi.fn(),
}))

const WORKSPACE_ROOT = "/tmp/test-workspace-eventbus"

function makeMockTelegram(): TelegramClient {
  return {
    deleteForumTopic: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: 1 }),
    editMessage: vi.fn().mockResolvedValue(true),
    createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 42, name: "test" }),
    getUpdates: vi.fn().mockResolvedValue([]),
    downloadFile: vi.fn().mockResolvedValue(false),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    pinMessage: vi.fn().mockResolvedValue(true),
    sendChatAction: vi.fn().mockResolvedValue(true),
    pinChatMessage: vi.fn().mockResolvedValue(true),
    editForumTopic: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    sendMessageWithKeyboard: vi.fn().mockResolvedValue(1),
  } as unknown as TelegramClient
}

function makeConfig(): MinionConfig {
  return {
    telegram: { token: "test", chatId: "123", allowedUserIds: [1] },
    telegramQueue: { minSendIntervalMs: 0 },
    workspace: {
      root: WORKSPACE_ROOT,
      maxConcurrentSessions: 5,
      maxDagConcurrency: 3,
      maxSplitItems: 10,
      sessionTokenBudget: 100000,
      sessionBudgetUsd: 10,
      sessionTimeoutMs: 300000,
      sessionInactivityTimeoutMs: 60000,
      staleTtlMs: 86400000,
      cleanupIntervalMs: 3600000,
      maxConversationLength: 50,
    },
    ci: {
      babysitEnabled: false,
      maxRetries: 2,
      pollIntervalMs: 5000,
      pollTimeoutMs: 300000,
      dagCiPolicy: "skip",
    },
    mcp: {
      browserEnabled: false,
      githubEnabled: false,
      context7Enabled: false,
      sentryEnabled: false,
      sentryOrgSlug: "",
      sentryProjectSlug: "",
      supabaseEnabled: false,
      supabaseProjectRef: "",
      flyEnabled: false,
      flyOrg: "",
      zaiEnabled: false,
    },
    goose: { provider: "test", model: "test" },
    claude: { planModel: "test", thinkModel: "test", reviewModel: "test" },
    observer: { activityThrottleMs: 0, textFlushDebounceMs: 0, activityEditDebounceMs: 0 },
    repos: {},
  } as MinionConfig
}

function makeSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 100,
    repo: "test-repo",
    cwd: "/tmp/test",
    slug: "test-slug",
    conversation: [],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    activeSessionId: "sess-1",
    ...overrides,
  }
}

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "sess-1",
    threadId: 100,
    topicName: "test-slug",
    repo: "test-repo",
    cwd: "/tmp/test",
    startedAt: Date.now() - 5000,
    mode: "task",
    ...overrides,
  }
}

beforeEach(async () => {
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true })
  try { await fs.unlink(path.join(WORKSPACE_ROOT, ".sessions.json")) } catch {}
})

describe("Dispatcher EventBus integration", () => {
  it("accepts EventBus in constructor", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const eventBus = new EventBus()
    const dispatcher = new Dispatcher(new TelegramPlatform(telegram, String(config.telegram.chatId)), observer, config, eventBus)

    expect(dispatcher).toBeDefined()
  })

  it("has completionChain as private property", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const eventBus = new EventBus()
    const dispatcher = new Dispatcher(new TelegramPlatform(telegram, String(config.telegram.chatId)), observer, config, eventBus)

    const d = dispatcher as unknown as { completionChain: unknown }
    expect(d.completionChain).toBeDefined()
  })

  it("subscribes completion chain to EventBus", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const eventBus = new EventBus()
    new Dispatcher(new TelegramPlatform(telegram, String(config.telegram.chatId)), observer, config, eventBus)

    // The chain subscribes to session.completed
    expect(eventBus.listenerCountFor("session.completed")).toBeGreaterThanOrEqual(1)
  })

  it("handleSessionComplete emits session.completed event", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const eventBus = new EventBus()
    const dispatcher = new Dispatcher(new TelegramPlatform(telegram, String(config.telegram.chatId)), observer, config, eventBus)

    const d = dispatcher as unknown as {
      topicSessions: Map<number, TopicSession>
      handleSessionComplete: (ts: TopicSession, m: SessionMeta, state: string) => void
      observer: { onSessionComplete: ReturnType<typeof vi.fn> }
      stats: { record: ReturnType<typeof vi.fn> }
      pinnedMessages: { updateTopicTitle: ReturnType<typeof vi.fn>; updatePinnedSummary: ReturnType<typeof vi.fn> }
      persistTopicSessions: ReturnType<typeof vi.fn>
    }

    d.observer.onSessionComplete = vi.fn().mockResolvedValue(undefined)
    d.stats.record = vi.fn().mockResolvedValue(undefined)
    d.pinnedMessages.updateTopicTitle = vi.fn().mockResolvedValue(undefined)
    d.pinnedMessages.updatePinnedSummary = vi.fn()
    d.persistTopicSessions = vi.fn().mockResolvedValue(undefined)

    const emitted: unknown[] = []
    eventBus.onAny((event) => emitted.push(event))

    const session = makeSession()
    d.topicSessions.set(100, session)

    d.handleSessionComplete(session, makeMeta(), "completed")

    // Wait for async event emission
    await new Promise((r) => setTimeout(r, 10))

    expect(emitted).toHaveLength(1)
    expect((emitted[0] as { type: string }).type).toBe("session.completed")
  })

  it("completion chain processes session.completed events end-to-end", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const eventBus = new EventBus()
    const dispatcher = new Dispatcher(new TelegramPlatform(telegram, String(config.telegram.chatId)), observer, config, eventBus)

    const d = dispatcher as unknown as {
      topicSessions: Map<number, TopicSession>
      observer: {
        onSessionComplete: ReturnType<typeof vi.fn>
        flushAndComplete: ReturnType<typeof vi.fn>
      }
      stats: { record: ReturnType<typeof vi.fn> }
      pinnedMessages: {
        updateTopicTitle: ReturnType<typeof vi.fn>
        updatePinnedSummary: ReturnType<typeof vi.fn>
        pinThreadMessage: ReturnType<typeof vi.fn>
      }
      persistTopicSessions: ReturnType<typeof vi.fn>
      cleanBuildArtifacts: ReturnType<typeof vi.fn>
    }

    d.observer.onSessionComplete = vi.fn().mockResolvedValue(undefined)
    d.observer.flushAndComplete = vi.fn().mockResolvedValue(undefined)
    d.stats.record = vi.fn().mockResolvedValue(undefined)
    d.pinnedMessages.updateTopicTitle = vi.fn().mockResolvedValue(undefined)
    d.pinnedMessages.updatePinnedSummary = vi.fn()
    d.pinnedMessages.pinThreadMessage = vi.fn().mockResolvedValue(undefined)
    d.persistTopicSessions = vi.fn().mockResolvedValue(undefined)
    d.cleanBuildArtifacts = vi.fn()

    const session = makeSession({ mode: "think" })
    d.topicSessions.set(100, session)

    await eventBus.emit({
      type: "session.completed" as const,
      timestamp: Date.now(),
      meta: makeMeta({ mode: "think" }),
      state: "completed" as const,
    })

    // ModeCompletionHandler should have set handled=true for think mode
    // and updated the topic title to 💬
    expect(d.pinnedMessages.updateTopicTitle).toHaveBeenCalledWith(session, "💬")

    // Stats should have been recorded
    expect(d.stats.record).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "test-slug",
        mode: "think",
      }),
    )

    // Session should be cleared from active
    expect(session.activeSessionId).toBeUndefined()
  })

  it("ignores session.completed events for unknown topics", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const eventBus = new EventBus()
    new Dispatcher(new TelegramPlatform(telegram, String(config.telegram.chatId)), observer, config, eventBus)

    // Emit event for unknown threadId — should not throw
    await eventBus.emit({
      type: "session.completed" as const,
      timestamp: Date.now(),
      meta: makeMeta({ threadId: 999 }),
      state: "completed" as const,
    })
  })

  it("ignores session.completed events for mismatched sessionId", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const eventBus = new EventBus()
    const dispatcher = new Dispatcher(new TelegramPlatform(telegram, String(config.telegram.chatId)), observer, config, eventBus)

    const d = dispatcher as unknown as {
      topicSessions: Map<number, TopicSession>
      stats: { record: ReturnType<typeof vi.fn> }
    }
    d.stats.record = vi.fn().mockResolvedValue(undefined)

    const session = makeSession({ activeSessionId: "different-session" })
    d.topicSessions.set(100, session)

    await eventBus.emit({
      type: "session.completed" as const,
      timestamp: Date.now(),
      meta: makeMeta({ sessionId: "sess-1" }),
      state: "completed" as const,
    })

    // Stats should NOT have been recorded since sessionId doesn't match
    expect(d.stats.record).not.toHaveBeenCalled()
  })

  it("processes errored task sessions correctly", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const eventBus = new EventBus()
    const dispatcher = new Dispatcher(new TelegramPlatform(telegram, String(config.telegram.chatId)), observer, config, eventBus)

    const d = dispatcher as unknown as {
      topicSessions: Map<number, TopicSession>
      observer: { onSessionComplete: ReturnType<typeof vi.fn> }
      stats: { record: ReturnType<typeof vi.fn> }
      pinnedMessages: {
        updateTopicTitle: ReturnType<typeof vi.fn>
        updatePinnedSummary: ReturnType<typeof vi.fn>
      }
      persistTopicSessions: ReturnType<typeof vi.fn>
    }

    d.observer.onSessionComplete = vi.fn().mockResolvedValue(undefined)
    d.stats.record = vi.fn().mockResolvedValue(undefined)
    d.pinnedMessages.updateTopicTitle = vi.fn().mockResolvedValue(undefined)
    d.pinnedMessages.updatePinnedSummary = vi.fn()
    d.persistTopicSessions = vi.fn().mockResolvedValue(undefined)

    const session = makeSession({ mode: "task" })
    d.topicSessions.set(100, session)

    await eventBus.emit({
      type: "session.completed" as const,
      timestamp: Date.now(),
      meta: makeMeta(),
      state: "errored" as const,
    })

    expect(session.lastState).toBe("errored")
    expect(d.pinnedMessages.updateTopicTitle).toHaveBeenCalledWith(session, "❌")
  })
})
