import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock all heavy dependencies so createMinion() can be called without network access.
vi.mock("../src/telegram/telegram.js", () => {
  const MockTelegramClient = vi.fn(function (this: Record<string, unknown>) {
    this.sendMessage = vi.fn()
    this.editMessage = vi.fn()
    this.deleteMessage = vi.fn()
    this.pinChatMessage = vi.fn()
    this.createForumTopic = vi.fn()
    this.editForumTopic = vi.fn()
    this.closeForumTopic = vi.fn()
    this.deleteForumTopic = vi.fn()
    this.getUpdates = vi.fn()
    this.sendMessageWithKeyboard = vi.fn()
    this.answerCallbackQuery = vi.fn()
    this.sendPhoto = vi.fn()
    this.sendPhotoBuffer = vi.fn()
    this.downloadFile = vi.fn()
  })
  return { TelegramClient: MockTelegramClient }
})

vi.mock("../src/sentry.js", () => ({
  captureException: vi.fn(),
  initSentry: vi.fn(),
}))

// Capture constructor args from MinionEngine and Observer
const dispatcherConstructorArgs: unknown[][] = []
const observerConstructorArgs: unknown[][] = []

vi.mock("../src/engine/engine.js", () => {
  const MockMinionEngine = vi.fn(function (this: Record<string, unknown>, ...args: unknown[]) {
    dispatcherConstructorArgs.push(args)
    this.start = vi.fn()
    this.stop = vi.fn()
    this.loadPersistedSessions = vi.fn()
    this.startCleanupTimer = vi.fn()
    this.startLoops = vi.fn()
    this.getSessions = vi.fn(() => [])
    this.getTopicSessions = vi.fn(() => [])
    this.getDags = vi.fn(() => [])
    this.getSessionState = vi.fn()
    this.apiSendReply = vi.fn()
    this.apiStopSession = vi.fn()
    this.apiCloseSession = vi.fn()
    this.use = vi.fn()
  })
  return { MinionEngine: MockMinionEngine }
})

vi.mock("../src/telegram/observer.js", () => {
  const MockObserver = vi.fn(function (this: Record<string, unknown>, ...args: unknown[]) {
    observerConstructorArgs.push(args)
  })
  return { Observer: MockObserver }
})

vi.mock("../src/github/index.js", () => {
  const MockGitHubTokenProvider = vi.fn(function (this: Record<string, unknown>) {
    this.setTokenFilePath = vi.fn()
    this.refreshEnv = vi.fn()
    this.startPeriodicRefresh = vi.fn()
    this.stopPeriodicRefresh = vi.fn()
  })
  return { GitHubTokenProvider: MockGitHubTokenProvider }
})

import { createMinion } from "../src/minion.js"
import { TelegramPlatform } from "../src/telegram/telegram-platform.js"
import type { MinionConfig } from "../src/config/config-types.js"

function makeConfig(): MinionConfig {
  return {
    telegram: {
      botToken: "test-token",
      chatId: "-1001234567890",
      allowedUserIds: [123],
    },
    telegramQueue: { minSendIntervalMs: 0 },
    workspace: { root: "/tmp/test-minion" },
    observer: {
      activityThrottleMs: 100,
      textFlushDebounceMs: 100,
      activityEditDebounceMs: 100,
    },
    session: {
      maxConcurrent: 2,
      inactivityTimeoutMs: 60000,
      maxTotalTokens: 100000,
      budgetWarningThreshold: 0.8,
      agent: "goose",
      sdkModelId: undefined,
      cleanupStaleAfterMs: 0,
    },
    ci: {
      babysitMaxRetries: 2,
      babysitInitialDelayMs: 10000,
    },
    mcp: {},
    githubApp: undefined,
    sentry: undefined,
    repos: {},
    profiles: {},
    sessionEnvPassthrough: [],
  } as unknown as MinionConfig
}

describe("createMinion wiring", () => {
  beforeEach(() => {
    dispatcherConstructorArgs.length = 0
    observerConstructorArgs.length = 0
  })

  it("passes TelegramPlatform (not TelegramClient) to MinionEngine", () => {
    createMinion(makeConfig())

    expect(dispatcherConstructorArgs).toHaveLength(1)
    const [platform] = dispatcherConstructorArgs[0]
    expect(platform).toBeInstanceOf(TelegramPlatform)
  })

  it("passes TelegramPlatform (not TelegramClient) to Observer", () => {
    createMinion(makeConfig())

    expect(observerConstructorArgs).toHaveLength(1)
    const [platform] = observerConstructorArgs[0]
    expect(platform).toBeInstanceOf(TelegramPlatform)
  })

  it("platform has correct chatId from config", () => {
    createMinion(makeConfig())

    const [platform] = dispatcherConstructorArgs[0] as [TelegramPlatform]
    expect(platform.chatId).toBe("-1001234567890")
    expect(platform.name).toBe("telegram")
  })

  it("returns a valid MinionInstance", () => {
    const instance = createMinion(makeConfig())

    expect(instance).toHaveProperty("start")
    expect(instance).toHaveProperty("stop")
    expect(instance).toHaveProperty("getApiServer")
    expect(typeof instance.start).toBe("function")
    expect(typeof instance.stop).toBe("function")
  })
})
