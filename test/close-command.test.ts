import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Dispatcher } from "../src/orchestration/dispatcher.js"
import type { TelegramClient } from "../src/telegram/telegram.js"
import { TelegramPlatform } from "../src/telegram/telegram-platform.js"
import { Observer } from "../src/telegram/observer.js"
import type { MinionConfig } from "../src/config/config-types.js"
import type { TopicSession } from "../src/domain/session-types.js"
import { loggers } from "../src/logger.js"
import { EventBus } from "../src/events/event-bus.js"
import { SessionNotFoundError } from "../src/errors.js"
import type { CIBabysitter } from "../src/ci/ci-babysitter.js"

const WORKSPACE_ROOT = "/tmp/test-workspace-close-command"
const SESSIONS_FILE = path.join(WORKSPACE_ROOT, ".sessions.json")

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
    sendChatAction: vi.fn().mockResolvedValue(true),
  } as unknown as TelegramClient
}

async function clearSessionsFile() {
  try {
    await fs.unlink(SESSIONS_FILE)
  } catch {
    // File doesn't exist, that's fine
  }
}

function makeConfig(): MinionConfig {
  return {
    telegram: { token: "test", chatId: 1, allowedUserIds: [1] },
    workspace: {
      root: WORKSPACE_ROOT,
      maxConcurrentSessions: 2,
      sessionTimeoutMs: 60_000,
      staleTtlMs: 86_400_000,
    },
    repos: {},
    session: {
      goose: { provider: "test", model: "test" },
      claude: { planModel: "test", thinkModel: "test" },
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
    },
    ci: {
      enabled: false,
      babysitMaxRetries: 0,
      qualityGatesEnabled: false,
    },
  } as MinionConfig
}

// Ensure workspace directory exists and sessions file is cleared before each test
beforeEach(async () => {
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true })
  await clearSessionsFile()
})

describe("handleCloseCommand ordering", () => {
  it("deletes topic before starting workspace cleanup", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, String(config.telegram.chatId))
    const observer = new Observer(platform, 1)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const callOrder: string[] = []
    // Track call order
    const origDelete = telegram.deleteForumTopic as ReturnType<typeof vi.fn>
    origDelete.mockImplementation(async () => {
      callOrder.push("deleteForumTopic")
      return true
    })
    // Inject a topic session
    const topicSession: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      cwd: "/tmp/nonexistent-workspace",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    topicSessions.set(100, topicSession)
    // Call handleCloseCommand with threadId (public API)
    await dispatcher.handleCloseCommand(100)
    expect(callOrder).toContain("deleteForumTopic")
    expect(origDelete).toHaveBeenCalledWith(100)
    // Topic session should be removed from the map
    expect(topicSessions.has(100)).toBe(false)
  })
  it("deletes topic before killing active session process", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, String(config.telegram.chatId))
    const observer = new Observer(platform, 1)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())
    const callOrder: string[] = []
    ;(telegram.deleteForumTopic as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("deleteForumTopic")
      return true
    })
    const mockKill = vi.fn().mockImplementation(async () => {
      callOrder.push("kill")
      // Simulate slow kill
      await new Promise((r) => setTimeout(r, 50))
    })
    const topicSession: TopicSession = {
      threadId: 200,
      repo: "test-repo",
      cwd: "/tmp/nonexistent-workspace",
      slug: "test-slug-2",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      activeSessionId: "active-session-id",
    }
    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    topicSessions.set(200, topicSession)
    const sessions = (dispatcher as unknown as { sessions: Map<number, { handle: { kill: typeof mockKill } }> }).sessions
    sessions.set(200, {
      handle: { kill: mockKill },
    } as unknown as { handle: { kill: typeof mockKill } })
    // Call handleCloseCommand with threadId (public API)
    await dispatcher.handleCloseCommand(200)
    // deleteForumTopic must have been called BEFORE kill
    expect(callOrder[0]).toBe("deleteForumTopic")
    // kill happens in background, give it time to complete
    await new Promise((r) => setTimeout(r, 100))
    expect(callOrder).toContain("kill")
  })
})
describe("closeChildSessions warning for high child count", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(loggers.dispatcher, "warn").mockImplementation(() => loggers.dispatcher)
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })
  it("logs warning when closing more than 10 children", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, String(config.telegram.chatId))
    const observer = new Observer(platform, 1)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())
    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    // Create parent session
    const parentSession: TopicSession = {
      threadId: 1000,
      repo: "test-repo",
      cwd: "/tmp/workspace",
      slug: "parent-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      childThreadIds: [],
    }
    topicSessions.set(1000, parentSession)
    // Create 15 child sessions (exceeds threshold of 10)
    for (let i = 0; i < 15; i++) {
      const childSession: TopicSession = {
        threadId: 2000 + i,
        repo: "test-repo",
        cwd: `/tmp/workspace-child-${i}`,
        slug: `child-slug-${i}`,
        conversation: [],
        pendingFeedback: [],
        mode: "task",
        lastActivityAt: Date.now(),
        parentThreadId: 1000,
      }
      topicSessions.set(2000 + i, childSession)
      parentSession.childThreadIds!.push(2000 + i)
    }
    await dispatcher.handleCloseCommand(1000)
    // Verify warning was logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 15,
        parentThreadId: 1000,
        parentSlug: "parent-slug",
      }),
      "Unusually high number of children to close - possible bug?"
    )
  })
  it("does not log warning when closing 10 or fewer children", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, String(config.telegram.chatId))
    const observer = new Observer(platform, 1)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())
    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    // Create parent session
    const parentSession: TopicSession = {
      threadId: 3000,
      repo: "test-repo",
      cwd: "/tmp/workspace",
      slug: "parent-slug-2",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      childThreadIds: [],
    }
    topicSessions.set(3000, parentSession)
    // Create exactly 10 child sessions (at threshold, should NOT warn)
    for (let i = 0; i < 10; i++) {
      const childSession: TopicSession = {
        threadId: 4000 + i,
        repo: "test-repo",
        cwd: `/tmp/workspace-child-${i}`,
        slug: `child-slug-threshold-${i}`,
        conversation: [],
        pendingFeedback: [],
        mode: "task",
        lastActivityAt: Date.now(),
        parentThreadId: 3000,
      }
      topicSessions.set(4000 + i, childSession)
      parentSession.childThreadIds!.push(4000 + i)
    }
    await dispatcher.handleCloseCommand(3000)
    // Verify warning was NOT logged
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
describe("closeChildSessions orphan detection", () => {
  it("only closes actual children, not unrelated sessions", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, String(config.telegram.chatId))
    const observer = new Observer(platform, 1)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())
    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    // Create parent session
    const parentSession: TopicSession = {
      threadId: 5000,
      repo: "test-repo",
      cwd: "/tmp/workspace-parent",
      slug: "parent-slug-orphan-test",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      childThreadIds: [],
    }
    topicSessions.set(5000, parentSession)
    // Create multiple UNRELATED sessions (no parentThreadId set)
    for (let i = 0; i < 5; i++) {
      const unrelated: TopicSession = {
        threadId: 6000 + i,
        repo: "other-repo",
        cwd: `/tmp/workspace-unrelated-${i}`,
        slug: `unrelated-slug-${i}`,
        conversation: [],
        pendingFeedback: [],
        mode: "task",
        lastActivityAt: Date.now(),
        // Note: parentThreadId is undefined (not set)
      }
      topicSessions.set(6000 + i, unrelated)
    }
    // Create more unrelated sessions with a DIFFERENT parentThreadId
    const otherParentId = 9999
    for (let i = 0; i < 3; i++) {
      const otherChild: TopicSession = {
        threadId: 7000 + i,
        repo: "other-repo-2",
        cwd: `/tmp/workspace-other-child-${i}`,
        slug: `other-child-slug-${i}`,
        conversation: [],
        pendingFeedback: [],
        mode: "task",
        lastActivityAt: Date.now(),
        parentThreadId: otherParentId, // Different parent
      }
      topicSessions.set(7000 + i, otherChild)
    }
    // Create ONE actual child of the parent
    const actualChild: TopicSession = {
      threadId: 8000,
      repo: "test-repo",
      cwd: "/tmp/workspace-actual-child",
      slug: "actual-child-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      parentThreadId: 5000, // Points to our parent
    }
    topicSessions.set(8000, actualChild)
    parentSession.childThreadIds!.push(8000)
    // Verify setup: should have 10 sessions total (parent + 5 unrelated + 3 other children + 1 actual child)
    const expectedCount = 1 + 5 + 3 + 1
    expect(topicSessions.size).toBe(expectedCount)
    // Close the parent
    await dispatcher.handleCloseCommand(5000)
    // CRITICAL: Only the actual child (threadId 8000) should be deleted, NOT all sessions
    // The parent (5000) should also be deleted
    expect(topicSessions.has(5000)).toBe(false) // Parent deleted
    expect(topicSessions.has(8000)).toBe(false) // Actual child deleted
    // All unrelated sessions should STILL EXIST
    for (let i = 0; i < 5; i++) {
      expect(topicSessions.has(6000 + i)).toBe(true)
    }
    for (let i = 0; i < 3; i++) {
      expect(topicSessions.has(7000 + i)).toBe(true)
    }
    // Should have 8 sessions remaining (5 + 3 unrelated)
    expect(topicSessions.size).toBe(8)
    // Verify deleteForumTopic was called only for parent and actual child
    const deleteCalls = (telegram.deleteForumTopic as ReturnType<typeof vi.fn>).mock.calls
    const deletedThreadIds = deleteCalls.map((call) => call[0])
    expect(deletedThreadIds).toContain(5000) // Parent
    expect(deletedThreadIds).toContain(8000) // Actual child
    expect(deletedThreadIds).not.toContain(6000) // Unrelated
    expect(deletedThreadIds).not.toContain(6001) // Unrelated
    expect(deletedThreadIds).not.toContain(7000) // Other parent's child
  })
  it("handles orphaned children not in childThreadIds array", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, String(config.telegram.chatId))
    const observer = new Observer(platform, 1)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())
    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    // Create parent session
    const parentSession: TopicSession = {
      threadId: 5100,
      repo: "test-repo",
      cwd: "/tmp/workspace-parent-orphan",
      slug: "parent-orphan-test",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      childThreadIds: [], // Empty - child is not tracked here
    }
    topicSessions.set(5100, parentSession)
    // Create an orphaned child (parentThreadId points to parent, but not in childThreadIds)
    const orphanedChild: TopicSession = {
      threadId: 8100,
      repo: "test-repo",
      cwd: "/tmp/workspace-orphan-child",
      slug: "orphan-child-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      parentThreadId: 5100, // Points to parent, but parent.childThreadIds is empty
    }
    topicSessions.set(8100, orphanedChild)
    // Create an unrelated session
    const unrelated: TopicSession = {
      threadId: 9100,
      repo: "other-repo",
      cwd: "/tmp/workspace-unrelated-orphan",
      slug: "unrelated-orphan-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    topicSessions.set(9100, unrelated)
    expect(topicSessions.size).toBe(3)
    // Close the parent
    await dispatcher.handleCloseCommand(5100)
    // Parent and orphaned child should be deleted
    expect(topicSessions.has(5100)).toBe(false)
    expect(topicSessions.has(8100)).toBe(false)
    // Unrelated session should remain
    expect(topicSessions.has(9100)).toBe(true)
    expect(topicSessions.size).toBe(1)
  })
})

describe("apiCloseSession delegates to handleCloseCommandInternal", () => {
  it("cleans up replyQueues, abortControllers, and quotaSleepTimers", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, String(config.telegram.chatId))
    const observer = new Observer(platform, 1)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const topicSession: TopicSession = {
      threadId: 300,
      repo: "test-repo",
      cwd: "/tmp/nonexistent-workspace",
      slug: "api-close-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    const replyQueues = (dispatcher as unknown as { replyQueues: Map<number, unknown> }).replyQueues
    const abortControllers = (dispatcher as unknown as { abortControllers: Map<number, AbortController> }).abortControllers
    const quotaSleepTimers = (dispatcher as unknown as { quotaSleepTimers: Map<number, ReturnType<typeof setTimeout>> }).quotaSleepTimers

    topicSessions.set(300, topicSession)
    replyQueues.set(300, { messages: [] })
    abortControllers.set(300, new AbortController())
    quotaSleepTimers.set(300, setTimeout(() => {}, 100_000))

    await dispatcher.apiCloseSession(300)

    expect(topicSessions.has(300)).toBe(false)
    expect(replyQueues.has(300)).toBe(false)
    expect(abortControllers.has(300)).toBe(false)
    expect(quotaSleepTimers.has(300)).toBe(false)
  })

  it("closes child sessions when parent is closed via API", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, String(config.telegram.chatId))
    const observer = new Observer(platform, 1)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions

    const parentSession: TopicSession = {
      threadId: 400,
      repo: "test-repo",
      cwd: "/tmp/workspace-parent",
      slug: "api-parent",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      childThreadIds: [401, 402],
    }
    topicSessions.set(400, parentSession)

    for (const childId of [401, 402]) {
      topicSessions.set(childId, {
        threadId: childId,
        repo: "test-repo",
        cwd: `/tmp/workspace-child-${childId}`,
        slug: `api-child-${childId}`,
        conversation: [],
        pendingFeedback: [],
        mode: "task",
        lastActivityAt: Date.now(),
        parentThreadId: 400,
      })
    }

    await dispatcher.apiCloseSession(400)

    expect(topicSessions.has(400)).toBe(false)
    expect(topicSessions.has(401)).toBe(false)
    expect(topicSessions.has(402)).toBe(false)
  })

  it("cleans up DAG state when parent has dagId", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, String(config.telegram.chatId))
    const observer = new Observer(platform, 1)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    const dags = (dispatcher as unknown as { dags: Map<string, unknown> }).dags

    const dagId = "test-dag-123"
    dags.set(dagId, { id: dagId, nodes: [] })

    const topicSession: TopicSession = {
      threadId: 500,
      repo: "test-repo",
      cwd: "/tmp/workspace-dag",
      slug: "api-dag-close",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      dagId,
    }
    topicSessions.set(500, topicSession)

    await dispatcher.apiCloseSession(500)

    expect(topicSessions.has(500)).toBe(false)
    expect(dags.has(dagId)).toBe(false)
  })

  it("throws SessionNotFoundError for unknown threadId", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, String(config.telegram.chatId))
    const observer = new Observer(platform, 1)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    await expect(dispatcher.apiCloseSession(99999)).rejects.toThrow(SessionNotFoundError)
  })

  it("clears pendingBabysitPRs on close", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, String(config.telegram.chatId))
    const observer = new Observer(platform, 1)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    const ciBabysitter = (dispatcher as unknown as { ciBabysitter: CIBabysitter }).ciBabysitter

    const topicSession: TopicSession = {
      threadId: 600,
      repo: "test-repo",
      cwd: "/tmp/workspace-babysit",
      slug: "babysit-close",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    topicSessions.set(600, topicSession)

    // Simulate queued babysit entries
    ciBabysitter.pendingBabysitPRs.set(600, [
      { childSession: topicSession, prUrl: "https://github.com/org/repo/pull/1" },
    ])

    await dispatcher.apiCloseSession(600)

    expect(ciBabysitter.pendingBabysitPRs.has(600)).toBe(false)
  })
})

describe("handleCloseCommand clears pendingBabysitPRs", () => {
  it("deletes pendingBabysitPRs entry for the closed session", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const platform = new TelegramPlatform(telegram, String(config.telegram.chatId))
    const observer = new Observer(platform, 1)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    const ciBabysitter = (dispatcher as unknown as { ciBabysitter: CIBabysitter }).ciBabysitter

    const topicSession: TopicSession = {
      threadId: 700,
      repo: "test-repo",
      cwd: "/tmp/workspace-babysit-close",
      slug: "babysit-direct-close",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    topicSessions.set(700, topicSession)

    ciBabysitter.pendingBabysitPRs.set(700, [
      { childSession: topicSession, prUrl: "https://github.com/org/repo/pull/2" },
    ])

    await dispatcher.handleCloseCommand(700)

    expect(ciBabysitter.pendingBabysitPRs.has(700)).toBe(false)
  })
})
