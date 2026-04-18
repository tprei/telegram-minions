import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Dispatcher } from "../src/orchestration/dispatcher.js"
import type { TelegramClient } from "../src/telegram/telegram.js"
import { TelegramPlatform } from "../src/telegram/telegram-platform.js"
import { Observer } from "../src/telegram/observer.js"
import type { MinionConfig } from "../src/config/config-types.js"
import type { TopicSession } from "../src/domain/session-types.js"
import { ReplyQueue } from "../src/reply-queue.js"
import { EventBus } from "../src/events/event-bus.js"
import type { CIBabysitter } from "../src/ci/ci-babysitter.js"

const WORKSPACE_ROOT = "/tmp/test-stale-cleanup"

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

describe("cleanupStaleSessions deletes replyQueues for stale parent sessions", () => {
  it("removes replyQueue entry for a stale session", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, config.telegram.chatId)
    const observer = new Observer(platform, 123)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const d = dispatcher as unknown as {
      topicSessions: Map<number, TopicSession>
      replyQueues: Map<number, ReplyQueue>
      cleanupStaleSessions: () => Promise<void>
    }

    const threadId = 500
    const staleSession: TopicSession = {
      threadId,
      repo: "test-repo",
      cwd: "/tmp/nonexistent-stale",
      slug: "stale-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now() - 200_000,
    }

    d.topicSessions.set(threadId, staleSession)
    d.replyQueues.set(threadId, new ReplyQueue("/tmp/nonexistent-stale"))

    expect(d.replyQueues.has(threadId)).toBe(true)

    await d.cleanupStaleSessions()

    expect(d.replyQueues.has(threadId)).toBe(false)
    expect(d.topicSessions.has(threadId)).toBe(false)
  })

  it("removes pendingBabysitPRs entry for a stale session", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, config.telegram.chatId)
    const observer = new Observer(platform, 123)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const d = dispatcher as unknown as {
      topicSessions: Map<number, TopicSession>
      ciBabysitter: CIBabysitter
      cleanupStaleSessions: () => Promise<void>
    }

    const threadId = 550
    const staleSession: TopicSession = {
      threadId,
      repo: "test-repo",
      cwd: "/tmp/nonexistent-stale-babysit",
      slug: "stale-babysit",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now() - 200_000,
    }

    d.topicSessions.set(threadId, staleSession)
    d.ciBabysitter.pendingBabysitPRs.set(threadId, [
      { childSession: staleSession, prUrl: "https://github.com/test/pr/1" },
    ])

    expect(d.ciBabysitter.pendingBabysitPRs.has(threadId)).toBe(true)

    await d.cleanupStaleSessions()

    expect(d.ciBabysitter.pendingBabysitPRs.has(threadId)).toBe(false)
    expect(d.topicSessions.has(threadId)).toBe(false)
  })

  it("scrubs stale child ID from parent childThreadIds", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, config.telegram.chatId)
    const observer = new Observer(platform, 123)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const d = dispatcher as unknown as {
      topicSessions: Map<number, TopicSession>
      cleanupStaleSessions: () => Promise<void>
    }

    const parentThreadId = 700
    const childThreadId = 701
    const otherChildThreadId = 702

    const parentSession: TopicSession = {
      threadId: parentThreadId,
      repo: "test-repo",
      cwd: "/tmp/nonexistent-parent",
      slug: "parent-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "plan",
      lastActivityAt: Date.now(),
      childThreadIds: [childThreadId, otherChildThreadId],
    }

    const staleChild: TopicSession = {
      threadId: childThreadId,
      repo: "test-repo",
      cwd: "/tmp/nonexistent-child",
      slug: "stale-child",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now() - 200_000,
      parentThreadId,
    }

    const activeChild: TopicSession = {
      threadId: otherChildThreadId,
      repo: "test-repo",
      cwd: "/tmp/nonexistent-child-active",
      slug: "active-child",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      parentThreadId,
    }

    d.topicSessions.set(parentThreadId, parentSession)
    d.topicSessions.set(childThreadId, staleChild)
    d.topicSessions.set(otherChildThreadId, activeChild)

    await d.cleanupStaleSessions()

    expect(d.topicSessions.has(childThreadId)).toBe(false)
    expect(d.topicSessions.has(parentThreadId)).toBe(true)
    expect(d.topicSessions.has(otherChildThreadId)).toBe(true)
    expect(parentSession.childThreadIds).toEqual([otherChildThreadId])
  })

  it("does not remove replyQueue for non-stale sessions", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, config.telegram.chatId)
    const observer = new Observer(platform, 123)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const d = dispatcher as unknown as {
      topicSessions: Map<number, TopicSession>
      replyQueues: Map<number, ReplyQueue>
      cleanupStaleSessions: () => Promise<void>
    }

    const threadId = 600
    const activeSession: TopicSession = {
      threadId,
      repo: "test-repo",
      cwd: "/tmp/nonexistent-active",
      slug: "active-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    d.topicSessions.set(threadId, activeSession)
    d.replyQueues.set(threadId, new ReplyQueue("/tmp/nonexistent-active"))

    await d.cleanupStaleSessions()

    expect(d.replyQueues.has(threadId)).toBe(true)
    expect(d.topicSessions.has(threadId)).toBe(true)
  })
})
