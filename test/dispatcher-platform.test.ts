import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Dispatcher } from "../src/orchestration/dispatcher.js"
import type { TelegramClient } from "../src/telegram/telegram.js"
import { TelegramPlatform } from "../src/telegram/telegram-platform.js"
import { Observer } from "../src/telegram/observer.js"
import type { MinionConfig } from "../src/config/config-types.js"
import type { TopicSession } from "../src/domain/session-types.js"
import { EventBus } from "../src/events/event-bus.js"

const WORKSPACE_ROOT = "/tmp/test-workspace-platform"

function makeMockTelegram(): TelegramClient {
  return {
    deleteForumTopic: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: 1 }),
    editMessage: vi.fn().mockResolvedValue(true),
    createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 42, name: "test" }),
    getUpdates: vi.fn().mockResolvedValue([]),
    downloadFile: vi.fn().mockResolvedValue(false),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    pinChatMessage: vi.fn().mockResolvedValue(true),
    editForumTopic: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    sendMessageWithKeyboard: vi.fn().mockResolvedValue(1),
    closeForumTopic: vi.fn().mockResolvedValue(true),
    sendPhoto: vi.fn().mockResolvedValue(1),
    sendPhotoBuffer: vi.fn().mockResolvedValue(1),
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
    quota: { retryMax: 3, defaultSleepMs: 60000 },
  } as MinionConfig
}

beforeEach(async () => {
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true })
  try { await fs.unlink(path.join(WORKSPACE_ROOT, ".sessions.json")) } catch {}
})

describe("Dispatcher ChatPlatform integration", () => {
  it("constructs with ChatPlatform and exposes getPlatform()", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, config.telegram.chatId)
    const observer = new Observer(platform, 0)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    expect(dispatcher).toBeDefined()
    expect(dispatcher.getPlatform()).toBe(platform)
    expect(dispatcher.getPlatform().name).toBe("telegram")
  })

  it("routes sendMessage through platform.chat when handling reply errors", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, config.telegram.chatId)
    const observer = new Observer(platform, 0)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    await dispatcher.handleReplyCommand(999, "hello")

    // Should call sendMessage through the platform (which wraps TelegramClient)
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
      999,
    )
  })

  it("routes deleteForumTopic through platform.threads for close", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, config.telegram.chatId)
    const observer = new Observer(platform, 0)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    // Set up a topic session to close
    const topicSessions = dispatcher.getTopicSessions()
    const topicSession: TopicSession = {
      threadId: 100,
      repo: "test",
      cwd: "/tmp/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    topicSessions.set(100, topicSession)

    await dispatcher.handleCloseCommand(100)

    // deleteForumTopic should be called through platform.threads.deleteThread
    expect(telegram.deleteForumTopic).toHaveBeenCalledWith(100)
  })

  it("routes stop command through platform.chat for error messages", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, config.telegram.chatId)
    const observer = new Observer(platform, 0)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    await dispatcher.handleStopCommand(999)

    expect(telegram.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
      999,
    )
  })

  it("provides backward-compat shim via DispatcherContext for downstream modules", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, config.telegram.chatId)
    const observer = new Observer(platform, 0)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    // Dispatcher should construct without errors and expose the same API
    expect(typeof dispatcher.handleReplyCommand).toBe("function")
    expect(typeof dispatcher.handleStopCommand).toBe("function")
    expect(typeof dispatcher.handleCloseCommand).toBe("function")
    expect(typeof dispatcher.activeSessions).toBe("function")
    expect(typeof dispatcher.getPlatform).toBe("function")
  })
})

describe("Dispatcher poll uses platform.input", () => {
  it("polls through platform.input and processes ChatUpdate messages", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    ;(telegram.getUpdates as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        update_id: 1001,
        message: {
          message_id: 50,
          from: { id: 1, is_bot: false, first_name: "Test" },
          chat: { id: 123, type: "supergroup" },
          date: 1700000000,
          text: "/status",
        },
      },
    ])

    const platform = new TelegramPlatform(telegram, config.telegram.chatId)
    const observer = new Observer(platform, 0)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    // Access private poll method via internal cast
    const pollMethod = (dispatcher as unknown as { poll: () => Promise<void> }).poll.bind(dispatcher)
    await pollMethod()

    // getUpdates should have been called through platform.input.poll
    expect(telegram.getUpdates).toHaveBeenCalled()
    // A /status command should trigger a sendMessage response
    expect(telegram.sendMessage).toHaveBeenCalled()
  })

  it("filters unauthorized users through platform ChatUpdate", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    ;(telegram.getUpdates as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        update_id: 1002,
        message: {
          message_id: 51,
          from: { id: 999, is_bot: false, first_name: "Unauthorized" },
          chat: { id: 123, type: "supergroup" },
          date: 1700000000,
          text: "/status",
        },
      },
    ])

    const platform = new TelegramPlatform(telegram, config.telegram.chatId)
    const observer = new Observer(platform, 0)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const pollMethod = (dispatcher as unknown as { poll: () => Promise<void> }).poll.bind(dispatcher)
    await pollMethod()

    // Unauthorized user's /status should be ignored
    expect(telegram.sendMessage).not.toHaveBeenCalled()
  })

  it("handles callback queries through platform ChatUpdate", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    ;(telegram.getUpdates as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        update_id: 1003,
        callback_query: {
          id: "cb-123",
          from: { id: 1, is_bot: false, first_name: "Test" },
          data: "unknown-data",
        },
      },
    ])

    const platform = new TelegramPlatform(telegram, config.telegram.chatId)
    const observer = new Observer(platform, 0)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const pollMethod = (dispatcher as unknown as { poll: () => Promise<void> }).poll.bind(dispatcher)
    await pollMethod()

    // Should answer the callback query through the platform
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("cb-123", undefined)
  })
})
