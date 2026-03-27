import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Dispatcher } from "../src/dispatcher.js"
import type { TelegramClient } from "../src/telegram.js"
import { Observer } from "../src/observer.js"
import type { MinionConfig } from "../src/config-types.js"
import type { TopicSession } from "../src/types.js"
import { loggers } from "../src/logger.js"

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

function makeConfig(): MinionConfig {
  return {
    telegram: { token: "test", chatId: 1, allowedUserIds: [1] },
    workspace: {
      root: "/tmp/test-workspace",
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

describe("handleCloseCommand ordering", () => {
  it("deletes topic before starting workspace cleanup", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)

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
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)

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
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)

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
      "Unusually high number of children to close - possible bug?",
    )
  })

  it("does not log warning when closing 10 or fewer children", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)

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
