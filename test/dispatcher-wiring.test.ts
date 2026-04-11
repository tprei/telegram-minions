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

describe("Dispatcher module wiring", () => {
  it("constructs without errors and exposes the same public API", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const dispatcher = new Dispatcher(new TelegramPlatform(telegram, config.telegram.chatId), observer, config, new EventBus())

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
    const dispatcher = new Dispatcher(new TelegramPlatform(telegram, config.telegram.chatId), observer, config, new EventBus())

    const d = dispatcher as unknown as Record<string, unknown>
    expect(d.ciBabysitter).toBeDefined()
    expect(d.landingManager).toBeDefined()
    expect(d.dagOrchestrator).toBeDefined()
    expect(d.shipPipeline).toBeDefined()
    expect(d.splitOrchestrator).toBeDefined()
    expect(d.judgeOrchestrator).toBeDefined()
    expect(d.pinnedMessages).toBeDefined()
  })

  it("shares mutable state between dispatcher and modules via context", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const dispatcher = new Dispatcher(new TelegramPlatform(telegram, config.telegram.chatId), observer, config, new EventBus())

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
    const dispatcher = new Dispatcher(new TelegramPlatform(telegram, config.telegram.chatId), observer, config, new EventBus())

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
    const dispatcher = new Dispatcher(new TelegramPlatform(telegram, config.telegram.chatId), observer, config, new EventBus())

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
    sessions.set(200, { handle: { kill: mockKill } })

    await dispatcher.handleStopCommand(200)
    expect(mockKill).toHaveBeenCalled()
    expect(session.activeSessionId).toBeUndefined()
    expect(topicSessions.has(200)).toBe(true)
  })

  it("returns error for unknown thread on handleReplyCommand", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const dispatcher = new Dispatcher(new TelegramPlatform(telegram, config.telegram.chatId), observer, config, new EventBus())

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
    const dispatcher = new Dispatcher(new TelegramPlatform(telegram, config.telegram.chatId), observer, config, new EventBus())

    expect(dispatcher.activeSessions()).toBe(0)
  })

  it("getDags returns the shared dags map", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const dispatcher = new Dispatcher(new TelegramPlatform(telegram, config.telegram.chatId), observer, config, new EventBus())

    expect(dispatcher.getDags()).toBeInstanceOf(Map)
    expect(dispatcher.getDags().size).toBe(0)
  })

  it("handleExecuteCommand clears autoAdvance when breaking out of ship pipeline", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 123)
    const dispatcher = new Dispatcher(new TelegramPlatform(telegram, config.telegram.chatId), observer, config, new EventBus())

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions

    const session: TopicSession = {
      threadId: 300,
      repo: "test-repo",
      cwd: "/tmp/test",
      slug: "ship-slug",
      conversation: [{ role: "assistant", text: "here is my plan" }],
      pendingFeedback: [],
      mode: "ship-plan",
      lastActivityAt: Date.now(),
      autoAdvance: {
        phase: "plan",
        featureDescription: "Build a feature",
        autoLand: false,
      },
    }
    topicSessions.set(300, session)

    const d = dispatcher as unknown as {
      commandHandler: { handleExecuteCommand(ts: TopicSession, directive?: string): Promise<void>; ctx: { spawnTopicAgent: unknown } }
      spawnTopicAgent(ts: TopicSession, task: string): Promise<boolean>
    }
    // Stub spawnTopicAgent so it doesn't actually spawn a process
    d.spawnTopicAgent = vi.fn().mockResolvedValue(true)
    d.commandHandler.ctx.spawnTopicAgent = vi.fn().mockResolvedValue(true)

    await d.commandHandler.handleExecuteCommand(session)

    expect(session.mode).toBe("task")
    expect(session.autoAdvance).toBeUndefined()
    expect(session.pendingFeedback).toEqual([])
  })

  describe("ship phase error resilience via EventBus", () => {
    it("preserves phase and shows recovery options when ship session errors", async () => {
      const telegram = makeMockTelegram()
      const config = makeConfig()
      const observer = new Observer(telegram, 123)
      const eventBus = new EventBus()
      const dispatcher = new Dispatcher(new TelegramPlatform(telegram, config.telegram.chatId), observer, config, eventBus)

      const d = dispatcher as unknown as {
        topicSessions: Map<number, TopicSession>
        sessions: Map<number, unknown>
        observer: { onSessionComplete: ReturnType<typeof vi.fn> }
        cleanBuildArtifacts: ReturnType<typeof vi.fn>
        stats: { record: ReturnType<typeof vi.fn> }
        pinnedMessages: { updateTopicTitle: ReturnType<typeof vi.fn>; updatePinnedSummary: ReturnType<typeof vi.fn> }
        persistTopicSessions: ReturnType<typeof vi.fn>
      }

      d.observer.onSessionComplete = vi.fn().mockResolvedValue(undefined)
      d.cleanBuildArtifacts = vi.fn()
      d.stats.record = vi.fn().mockResolvedValue(undefined)
      d.pinnedMessages.updateTopicTitle = vi.fn().mockResolvedValue(undefined)
      d.pinnedMessages.updatePinnedSummary = vi.fn()
      d.persistTopicSessions = vi.fn().mockResolvedValue(undefined)

      const session: TopicSession = {
        threadId: 300,
        repo: "test-repo",
        cwd: "/tmp/test",
        slug: "ship-test",
        conversation: [],
        pendingFeedback: [],
        mode: "ship-plan",
        lastActivityAt: Date.now(),
        activeSessionId: "session-abc",
        autoAdvance: {
          phase: "plan",
          featureDescription: "Build feature",
          autoLand: false,
        },
      }
      d.topicSessions.set(300, session)

      const meta = {
        sessionId: "session-abc",
        threadId: 300,
        topicName: "ship-test",
        repo: "test-repo",
        cwd: "/tmp/test",
        startedAt: Date.now() - 5000,
        mode: "ship-plan" as const,
      }

      await eventBus.emit({
        type: "session.completed" as const,
        timestamp: Date.now(),
        meta,
        state: "errored" as const,
      })

      expect(session.autoAdvance!.phase).toBe("plan")
      expect(d.pinnedMessages.updateTopicTitle).toHaveBeenCalledWith(session, "⚠️")
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Recovery options"),
        300,
      )
    })

    it("preserves phase for ship-think mode errors too", async () => {
      const telegram = makeMockTelegram()
      const config = makeConfig()
      const observer = new Observer(telegram, 123)
      const eventBus = new EventBus()
      const dispatcher = new Dispatcher(new TelegramPlatform(telegram, config.telegram.chatId), observer, config, eventBus)

      const d = dispatcher as unknown as {
        topicSessions: Map<number, TopicSession>
        sessions: Map<number, unknown>
        observer: { onSessionComplete: ReturnType<typeof vi.fn> }
        cleanBuildArtifacts: ReturnType<typeof vi.fn>
        stats: { record: ReturnType<typeof vi.fn> }
        pinnedMessages: { updateTopicTitle: ReturnType<typeof vi.fn>; updatePinnedSummary: ReturnType<typeof vi.fn> }
        persistTopicSessions: ReturnType<typeof vi.fn>
      }

      d.observer.onSessionComplete = vi.fn().mockResolvedValue(undefined)
      d.cleanBuildArtifacts = vi.fn()
      d.stats.record = vi.fn().mockResolvedValue(undefined)
      d.pinnedMessages.updateTopicTitle = vi.fn().mockResolvedValue(undefined)
      d.pinnedMessages.updatePinnedSummary = vi.fn()
      d.persistTopicSessions = vi.fn().mockResolvedValue(undefined)

      const session: TopicSession = {
        threadId: 301,
        repo: "test-repo",
        cwd: "/tmp/test",
        slug: "ship-test-2",
        conversation: [],
        pendingFeedback: [],
        mode: "ship-think",
        lastActivityAt: Date.now(),
        activeSessionId: "session-def",
        autoAdvance: {
          phase: "think",
          featureDescription: "Build feature",
          autoLand: false,
        },
      }
      d.topicSessions.set(301, session)

      const meta = {
        sessionId: "session-def",
        threadId: 301,
        topicName: "ship-test-2",
        repo: "test-repo",
        cwd: "/tmp/test",
        startedAt: Date.now() - 5000,
        mode: "ship-think" as const,
      }

      await eventBus.emit({
        type: "session.completed" as const,
        timestamp: Date.now(),
        meta,
        state: "errored" as const,
      })

      expect(session.autoAdvance!.phase).toBe("think")
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("paused"),
        301,
      )
    })
  })
})
