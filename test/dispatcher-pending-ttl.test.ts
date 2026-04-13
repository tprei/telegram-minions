import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Dispatcher } from "../src/orchestration/dispatcher.js"
import type { TelegramClient } from "../src/telegram/telegram.js"
import { TelegramPlatform } from "../src/telegram/telegram-platform.js"
import { Observer } from "../src/telegram/observer.js"
import type { MinionConfig } from "../src/config/config-types.js"
import type { PendingTask } from "../src/session/session-manager.js"
import { EventBus } from "../src/events/event-bus.js"

const WORKSPACE_ROOT = "/tmp/test-pending-ttl"

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
      staleTtlMs: 1000,
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

beforeEach(async () => {
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true })
  try { await fs.unlink(path.join(WORKSPACE_ROOT, ".sessions.json")) } catch {}
})

describe("cleanupStalePendingTasks expires old pending selections", () => {
  it("removes pendingTasks entries older than 10 minutes", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, config.telegram.chatId)
    const observer = new Observer(platform, 123)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const d = dispatcher as unknown as {
      pendingTasks: Map<number, PendingTask>
      cleanupStalePendingTasks: () => void
    }

    const tenMinutesAgo = Date.now() - 11 * 60 * 1000
    d.pendingTasks.set(100, { task: "old task", mode: "task", createdAt: tenMinutesAgo })
    d.pendingTasks.set(200, { task: "fresh task", mode: "plan", createdAt: Date.now() })

    d.cleanupStalePendingTasks()

    expect(d.pendingTasks.has(100)).toBe(false)
    expect(d.pendingTasks.has(200)).toBe(true)
  })

  it("removes pendingProfiles entries older than 10 minutes", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, config.telegram.chatId)
    const observer = new Observer(platform, 123)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const d = dispatcher as unknown as {
      pendingProfiles: Map<number, PendingTask>
      cleanupStalePendingTasks: () => void
    }

    const tenMinutesAgo = Date.now() - 11 * 60 * 1000
    d.pendingProfiles.set(300, { task: "old profile", mode: "review", repoUrl: "https://example.com", createdAt: tenMinutesAgo })
    d.pendingProfiles.set(400, { task: "fresh profile", mode: "task", repoUrl: "https://example.com", createdAt: Date.now() })

    d.cleanupStalePendingTasks()

    expect(d.pendingProfiles.has(300)).toBe(false)
    expect(d.pendingProfiles.has(400)).toBe(true)
  })

  it("does not remove entries within the 10-minute window", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, config.telegram.chatId)
    const observer = new Observer(platform, 123)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const d = dispatcher as unknown as {
      pendingTasks: Map<number, PendingTask>
      pendingProfiles: Map<number, PendingTask>
      cleanupStalePendingTasks: () => void
    }

    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
    d.pendingTasks.set(500, { task: "recent task", mode: "think", createdAt: fiveMinutesAgo })
    d.pendingProfiles.set(600, { task: "recent profile", mode: "ship-think", repoUrl: "https://example.com", createdAt: fiveMinutesAgo })

    d.cleanupStalePendingTasks()

    expect(d.pendingTasks.has(500)).toBe(true)
    expect(d.pendingProfiles.has(600)).toBe(true)
  })

  it("handles empty maps gracefully", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, config.telegram.chatId)
    const observer = new Observer(platform, 123)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const d = dispatcher as unknown as {
      pendingTasks: Map<number, PendingTask>
      pendingProfiles: Map<number, PendingTask>
      cleanupStalePendingTasks: () => void
    }

    expect(d.pendingTasks.size).toBe(0)
    expect(d.pendingProfiles.size).toBe(0)

    d.cleanupStalePendingTasks()

    expect(d.pendingTasks.size).toBe(0)
    expect(d.pendingProfiles.size).toBe(0)
  })
})
