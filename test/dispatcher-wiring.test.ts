import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Dispatcher } from "../src/dispatcher.js"
import type { TelegramClient } from "../src/telegram.js"
import { Observer } from "../src/session/observer.js"
import type { MinionConfig } from "../src/config-types.js"
import type { TopicSession } from "../src/types.js"

const WORKSPACE_ROOT = "/tmp/test-workspace-wiring"

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
      zaiEnabled: false,
    },
    goose: { provider: "test", model: "test" },
    claude: { planModel: "test", thinkModel: "test", reviewModel: "test" },
    observer: { activityThrottleMs: 0, textFlushDebounceMs: 0, activityEditDebounceMs: 0 },
    repos: {},
  } as MinionConfig
}

beforeEach(async () => {
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true })
  try { await fs.unlink(path.join(WORKSPACE_ROOT, ".sessions.json")) } catch {}
})

describe("Dispatcher module wiring", () => {
  it("constructs without errors and exposes the same public API", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const dispatcher = new Dispatcher(telegram, observer, config)

    expect(dispatcher).toBeDefined()
    expect(typeof dispatcher.start).toBe("function")
    expect(typeof dispatcher.stop).toBe("function")
    expect(typeof dispatcher.handleReplyCommand).toBe("function")
    expect(typeof dispatcher.handleStopCommand).toBe("function")
    expect(typeof dispatcher.handleCloseCommand).toBe("function")
    expect(typeof dispatcher.startCleanupTimer).toBe("function")
    expect(typeof dispatcher.activeSessions).toBe("function")
    expect(typeof dispatcher.getSessions).toBe("function")
    expect(typeof dispatcher.getTopicSessions).toBe("function")
    expect(typeof dispatcher.getDags).toBe("function")
    expect(typeof dispatcher.getSessionState).toBe("function")
    expect(typeof dispatcher.apiSendReply).toBe("function")
    expect(typeof dispatcher.apiStopSession).toBe("function")
    expect(typeof dispatcher.apiCloseSession).toBe("function")
    expect(typeof dispatcher.loadPersistedSessions).toBe("function")
  })

  it("has extracted module instances as private properties", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const dispatcher = new Dispatcher(telegram, observer, config)

    const d = dispatcher as unknown as Record<string, unknown>
    expect(d.ciBabysitter).toBeDefined()
    expect(d.landingManager).toBeDefined()
    expect(d.dagOrchestrator).toBeDefined()
    expect(d.shipPipeline).toBeDefined()
    expect(d.splitOrchestrator).toBeDefined()
    expect(d.pinnedMessages).toBeDefined()
  })

  it("shares mutable state between dispatcher and modules via context", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const dispatcher = new Dispatcher(telegram, observer, config)

    const d = dispatcher as unknown as {
      topicSessions: Map<number, TopicSession>
      dagOrchestrator: { ctx: { topicSessions: Map<number, TopicSession> } }
    }

    const session: TopicSession = {
      threadId: 1,
      repo: "test",
      cwd: "/tmp",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    d.topicSessions.set(1, session)
    expect(d.dagOrchestrator.ctx.topicSessions.get(1)).toBe(session)
  })

  it("delegates handleCloseCommand through internal method", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const dispatcher = new Dispatcher(telegram, observer, config)

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions

    const session: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      cwd: "/tmp/nonexistent",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    topicSessions.set(100, session)

    await dispatcher.handleCloseCommand(100)
    expect(topicSessions.has(100)).toBe(false)
    expect(telegram.deleteForumTopic).toHaveBeenCalledWith(100)
  })

  it("delegates handleStopCommand through internal method", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const dispatcher = new Dispatcher(telegram, observer, config)

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    const mockKill = vi.fn().mockResolvedValue(undefined)

    const session: TopicSession = {
      threadId: 200,
      repo: "test-repo",
      cwd: "/tmp/test",
      slug: "test-slug-2",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      activeSessionId: "active-123",
    }
    topicSessions.set(200, session)

    const sessions = (dispatcher as unknown as { sessions: Map<number, { handle: { kill: typeof mockKill } }> }).sessions
    sessions.set(200, { handle: { kill: mockKill } } as any)

    await dispatcher.handleStopCommand(200)
    expect(mockKill).toHaveBeenCalled()
    expect(session.activeSessionId).toBeUndefined()
    expect(topicSessions.has(200)).toBe(true)
  })

  it("returns error for unknown thread on handleReplyCommand", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const dispatcher = new Dispatcher(telegram, observer, config)

    await dispatcher.handleReplyCommand(999, "hello")
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
      999,
    )
  })

  it("activeSessions returns 0 initially", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const dispatcher = new Dispatcher(telegram, observer, config)

    expect(dispatcher.activeSessions()).toBe(0)
  })

  it("getDags returns the shared dags map", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const dispatcher = new Dispatcher(telegram, observer, config)

    expect(dispatcher.getDags()).toBeInstanceOf(Map)
    expect(dispatcher.getDags().size).toBe(0)
  })
})
