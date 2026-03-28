import { describe, it, expect, vi } from "vitest"
import { Dispatcher } from "../src/dispatcher.js"
import type { TelegramClient } from "../src/telegram.js"
import { Observer } from "../src/observer.js"
import type { MinionConfig } from "../src/config-types.js"
import type { TopicSession } from "../src/types.js"

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
        supabaseEnabled: false,
        supabaseProjectRef: "",
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

describe("handleStopCommand", () => {
  it("kills active session and clears activeSessionId", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)

    const mockKill = vi.fn().mockResolvedValue(undefined)

    const topicSession: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      cwd: "/tmp/test-workspace",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [{ role: "user", text: "some feedback" }],
      mode: "task",
      lastActivityAt: Date.now(),
      activeSessionId: "active-session-123",
    }

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    topicSessions.set(100, topicSession)

    const sessions = (dispatcher as unknown as { sessions: Map<number, { handle: { kill: typeof mockKill } }> }).sessions
    sessions.set(100, {
      handle: { kill: mockKill },
    } as unknown as { handle: { kill: typeof mockKill } })

    // Use the public API with threadId
    await dispatcher.handleStopCommand(100)

    // Should kill the session
    expect(mockKill).toHaveBeenCalled()
    // Should remove from sessions map
    expect(sessions.has(100)).toBe(false)
    // Should clear activeSessionId
    expect(topicSession.activeSessionId).toBeUndefined()
    // Should clear pendingFeedback
    expect(topicSession.pendingFeedback).toEqual([])
    // Should preserve topic session in map
    expect(topicSessions.has(100)).toBe(true)
    // Should send stopped message
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("stopped"),
      100,
    )
  })

  it("shows warning when no active session", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)

    const topicSession: TopicSession = {
      threadId: 200,
      repo: "test-repo",
      cwd: "/tmp/test-workspace",
      slug: "test-slug-2",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      // No activeSessionId
    }

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    topicSessions.set(200, topicSession)

    // Use the public API with threadId
    await dispatcher.handleStopCommand(200)

    // Should send warning message
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("No active session"),
      200,
    )
    // Topic session should still exist
    expect(topicSessions.has(200)).toBe(true)
  })

  it("preserves conversation history", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)

    const mockKill = vi.fn().mockResolvedValue(undefined)

    const topicSession: TopicSession = {
      threadId: 300,
      repo: "test-repo",
      cwd: "/tmp/test-workspace",
      slug: "test-slug-3",
      conversation: [
        { role: "user", text: "fix the bug" },
        { role: "assistant", text: "I fixed it" },
      ],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      activeSessionId: "active-session-456",
    }

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    topicSessions.set(300, topicSession)

    const sessions = (dispatcher as unknown as { sessions: Map<number, { handle: { kill: typeof mockKill } }> }).sessions
    sessions.set(300, {
      handle: { kill: mockKill },
    } as unknown as { handle: { kill: typeof mockKill } })

    // Use the public API with threadId
    await dispatcher.handleStopCommand(300)

    // Conversation should be preserved
    expect(topicSession.conversation).toHaveLength(2)
    expect(topicSession.conversation[0].text).toBe("fix the bug")
    expect(topicSession.conversation[1].text).toBe("I fixed it")
  })

  it("persists topic sessions after stop", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)

    const mockKill = vi.fn().mockResolvedValue(undefined)

    const topicSession: TopicSession = {
      threadId: 400,
      repo: "test-repo",
      cwd: "/tmp/test-workspace",
      slug: "test-slug-4",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      activeSessionId: "active-session-789",
    }

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    topicSessions.set(400, topicSession)

    const sessions = (dispatcher as unknown as { sessions: Map<number, { handle: { kill: typeof mockKill } }> }).sessions
    sessions.set(400, {
      handle: { kill: mockKill },
    } as unknown as { handle: { kill: typeof mockKill } })

    // Spy on persistTopicSessions
    const persistSpy = vi.spyOn(
      dispatcher as unknown as { persistTopicSessions: () => void },
      "persistTopicSessions",
    )

    // Use the public API with threadId
    await dispatcher.handleStopCommand(400)

    expect(persistSpy).toHaveBeenCalled()
  })

  it("handles session not in sessions map gracefully", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)

    const topicSession: TopicSession = {
      threadId: 500,
      repo: "test-repo",
      cwd: "/tmp/test-workspace",
      slug: "test-slug-5",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      activeSessionId: "orphaned-session-id",
    }

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    topicSessions.set(500, topicSession)

    // Don't add to sessions map - simulates orphaned activeSessionId

    // Use the public API with threadId
    await dispatcher.handleStopCommand(500)

    // Should still clear activeSessionId and send message
    expect(topicSession.activeSessionId).toBeUndefined()
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("stopped"),
      500,
    )
  })
})
