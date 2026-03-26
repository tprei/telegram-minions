import { describe, it, expect, vi } from "vitest"
import { Dispatcher } from "../src/dispatcher.js"
import type { TelegramClient } from "../src/telegram.js"
import { Observer } from "../src/observer.js"
import type { MinionConfig } from "../src/config-types.js"
import type { TopicSession } from "../src/types.js"
import type { TelegramCallbackQuery } from "../src/types.js"

function makeMockTelegram(): TelegramClient {
  return {
    deleteForumTopic: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1, date: 0, chat: { id: 1, type: "supergroup" } }),
    sendMessageWithKeyboard: vi.fn().mockResolvedValue(1),
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

function makeQuery(data: string): TelegramCallbackQuery {
  return {
    id: "query-1",
    from: { id: 1, is_bot: false, first_name: "Test" },
    data,
  }
}

function makeTopicSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 100,
    repo: "test-repo",
    cwd: "/tmp/test-workspace",
    slug: "calm-bay",
    conversation: [
      { role: "user", text: "Plan a feature" },
      { role: "assistant", text: "Here is my plan..." },
    ],
    pendingFeedback: [],
    mode: "plan",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

function setupDispatcher() {
  const telegram = makeMockTelegram()
  const config = makeConfig()
  const observer = new Observer(telegram, 1)
  const dispatcher = new Dispatcher(telegram, observer, config)
  const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
  return { dispatcher, telegram, topicSessions }
}

describe("plan-read callback", () => {
  it("sends session readout with action keyboard when session exists", async () => {
    const { dispatcher, telegram, topicSessions } = setupDispatcher()
    const session = makeTopicSession()
    topicSessions.set(100, session)

    const handleCallback = (dispatcher as unknown as { handleCallbackQuery: (q: TelegramCallbackQuery) => Promise<void> }).handleCallbackQuery.bind(dispatcher)
    await handleCallback(makeQuery("plan-read:100"))

    expect(telegram.sendMessageWithKeyboard).toHaveBeenCalledTimes(1)
    const [html, keyboard, threadId] = (telegram.sendMessageWithKeyboard as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(html).toContain("Session readout")
    expect(html).toContain("calm-bay")
    expect(html).toContain("Plan a feature")
    expect(keyboard).toHaveLength(1) // readout keyboard has 1 row of action buttons
    expect(keyboard[0]).toHaveLength(4)
    expect(threadId).toBe(100)
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("query-1")
  })

  it("answers with error when session not found", async () => {
    const { dispatcher, telegram } = setupDispatcher()

    const handleCallback = (dispatcher as unknown as { handleCallbackQuery: (q: TelegramCallbackQuery) => Promise<void> }).handleCallbackQuery.bind(dispatcher)
    await handleCallback(makeQuery("plan-read:999"))

    expect(telegram.sendMessageWithKeyboard).not.toHaveBeenCalled()
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("query-1", "Session not found or expired")
  })

  it("shows empty state for session with no conversation", async () => {
    const { dispatcher, telegram, topicSessions } = setupDispatcher()
    const session = makeTopicSession({ conversation: [] })
    topicSessions.set(100, session)

    const handleCallback = (dispatcher as unknown as { handleCallbackQuery: (q: TelegramCallbackQuery) => Promise<void> }).handleCallbackQuery.bind(dispatcher)
    await handleCallback(makeQuery("plan-read:100"))

    const [html] = (telegram.sendMessageWithKeyboard as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(html).toContain("No messages yet")
  })
})

describe("plan-action callback", () => {
  it("dispatches execute action to handleExecuteCommand", async () => {
    const { dispatcher, telegram, topicSessions } = setupDispatcher()
    const session = makeTopicSession()
    topicSessions.set(100, session)

    const mockExecute = vi.fn().mockResolvedValue(undefined)
    ;(dispatcher as unknown as { handleExecuteCommand: typeof mockExecute }).handleExecuteCommand = mockExecute

    const handleCallback = (dispatcher as unknown as { handleCallbackQuery: (q: TelegramCallbackQuery) => Promise<void> }).handleCallbackQuery.bind(dispatcher)
    await handleCallback(makeQuery("plan-action:execute:100"))

    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("query-1", "Starting execute…")
    expect(mockExecute).toHaveBeenCalledWith(session)
  })

  it("dispatches split action to handleSplitCommand", async () => {
    const { dispatcher, telegram, topicSessions } = setupDispatcher()
    const session = makeTopicSession()
    topicSessions.set(100, session)

    const mockSplit = vi.fn().mockResolvedValue(undefined)
    ;(dispatcher as unknown as { handleSplitCommand: typeof mockSplit }).handleSplitCommand = mockSplit

    const handleCallback = (dispatcher as unknown as { handleCallbackQuery: (q: TelegramCallbackQuery) => Promise<void> }).handleCallbackQuery.bind(dispatcher)
    await handleCallback(makeQuery("plan-action:split:100"))

    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("query-1", "Starting split…")
    expect(mockSplit).toHaveBeenCalledWith(session)
  })

  it("dispatches stack action to handleStackCommand", async () => {
    const { dispatcher, telegram, topicSessions } = setupDispatcher()
    const session = makeTopicSession()
    topicSessions.set(100, session)

    const mockStack = vi.fn().mockResolvedValue(undefined)
    ;(dispatcher as unknown as { handleStackCommand: typeof mockStack }).handleStackCommand = mockStack

    const handleCallback = (dispatcher as unknown as { handleCallbackQuery: (q: TelegramCallbackQuery) => Promise<void> }).handleCallbackQuery.bind(dispatcher)
    await handleCallback(makeQuery("plan-action:stack:100"))

    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("query-1", "Starting stack…")
    expect(mockStack).toHaveBeenCalledWith(session)
  })

  it("dispatches dag action to handleDagCommand", async () => {
    const { dispatcher, telegram, topicSessions } = setupDispatcher()
    const session = makeTopicSession()
    topicSessions.set(100, session)

    const mockDag = vi.fn().mockResolvedValue(undefined)
    ;(dispatcher as unknown as { handleDagCommand: typeof mockDag }).handleDagCommand = mockDag

    const handleCallback = (dispatcher as unknown as { handleCallbackQuery: (q: TelegramCallbackQuery) => Promise<void> }).handleCallbackQuery.bind(dispatcher)
    await handleCallback(makeQuery("plan-action:dag:100"))

    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("query-1", "Starting dag…")
    expect(mockDag).toHaveBeenCalledWith(session)
  })

  it("answers with error when session not found", async () => {
    const { dispatcher, telegram } = setupDispatcher()

    const handleCallback = (dispatcher as unknown as { handleCallbackQuery: (q: TelegramCallbackQuery) => Promise<void> }).handleCallbackQuery.bind(dispatcher)
    await handleCallback(makeQuery("plan-action:execute:999"))

    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("query-1", "Session not found or expired")
  })

  it("answers with error when session already executed", async () => {
    const { dispatcher, telegram, topicSessions } = setupDispatcher()
    const session = makeTopicSession({ mode: "task" })
    topicSessions.set(100, session)

    const handleCallback = (dispatcher as unknown as { handleCallbackQuery: (q: TelegramCallbackQuery) => Promise<void> }).handleCallbackQuery.bind(dispatcher)
    await handleCallback(makeQuery("plan-action:execute:100"))

    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("query-1", "Session already executed")
  })

  it("handles malformed payload gracefully", async () => {
    const { dispatcher, telegram } = setupDispatcher()

    const handleCallback = (dispatcher as unknown as { handleCallbackQuery: (q: TelegramCallbackQuery) => Promise<void> }).handleCallbackQuery.bind(dispatcher)
    await handleCallback(makeQuery("plan-action:badpayload"))

    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("query-1")
  })

  it("rejects unauthorized users", async () => {
    const { dispatcher, telegram } = setupDispatcher()

    const handleCallback = (dispatcher as unknown as { handleCallbackQuery: (q: TelegramCallbackQuery) => Promise<void> }).handleCallbackQuery.bind(dispatcher)
    const query = makeQuery("plan-action:execute:100")
    query.from.id = 9999 // not in allowedUserIds

    await handleCallback(query)

    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("query-1", "Not authorized")
  })
})
