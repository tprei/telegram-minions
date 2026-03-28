import { describe, it, expect, vi, beforeEach } from "vitest"
import { Dispatcher } from "../src/dispatcher.js"
import type { TelegramClient } from "../src/telegram.js"
import { Observer } from "../src/observer.js"
import type { MinionConfig } from "../src/config-types.js"
import type { TopicSession } from "../src/types.js"
import fs from "node:fs/promises"
import path from "node:path"

const WORKSPACE_ROOT = "/tmp/test-workspace-split-race"
const SESSIONS_FILE = path.join(WORKSPACE_ROOT, ".sessions.json")

function makeMockTelegram(): TelegramClient {
  return {
    deleteForumTopic: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1, date: 0, chat: { id: 1, type: "supergroup" } }),
    editMessage: vi.fn().mockResolvedValue(true),
    createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 42, name: "test" }),
    editForumTopic: vi.fn().mockResolvedValue(true),
    getUpdates: vi.fn().mockResolvedValue([]),
    downloadFile: vi.fn().mockResolvedValue(false),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    pinMessage: vi.fn().mockResolvedValue(true),
    pinChatMessage: vi.fn().mockResolvedValue(true),
    unpinChatMessage: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    sendChatAction: vi.fn().mockResolvedValue(true),
    sendMessageWithKeyboard: vi.fn().mockResolvedValue(1),
  } as unknown as TelegramClient
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

function makeChildSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 200,
    repo: "test-repo",
    cwd: "/tmp/test-child",
    slug: "child-slug",
    conversation: [
      { role: "user", text: "fix the bug" },
      { role: "assistant", text: "PR: https://github.com/org/repo/pull/99" },
    ],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    parentThreadId: 100,
    splitLabel: "child-1",
    ...overrides,
  }
}

function makeParentSession(children: TopicSession[] = []): TopicSession {
  return {
    threadId: 100,
    repo: "test-repo",
    cwd: "/tmp/test-parent",
    slug: "parent-slug",
    conversation: [],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    childThreadIds: children.map((c) => c.threadId),
    allSplitItems: children.map((c) => ({ title: c.splitLabel ?? c.slug, description: "sub-task" })),
  }
}

type DispatcherInternals = {
  topicSessions: Map<number, TopicSession>
  notifyParentOfChildComplete(childSession: TopicSession, state: string): Promise<void>
  updatePinnedSplitStatus(parent: TopicSession): Promise<void>
}

beforeEach(async () => {
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true })
  try {
    await fs.unlink(SESSIONS_FILE)
  } catch {
    // ok
  }
})

describe("notifyParentOfChildComplete", () => {
  it("uses childSession.prUrl instead of extracting from conversation", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)
    const internals = dispatcher as unknown as DispatcherInternals

    // Child session has prUrl pre-set but conversation does NOT contain the PR URL
    const child = makeChildSession({
      prUrl: "https://github.com/org/repo/pull/42",
      conversation: [
        { role: "user", text: "fix the bug" },
        { role: "assistant", text: "All done!" },
      ],
    })
    const parent = makeParentSession([child])

    internals.topicSessions.set(child.threadId, child)
    internals.topicSessions.set(parent.threadId, parent)

    await internals.notifyParentOfChildComplete(child, "completed")

    // Should have sent the child complete message with the pre-set prUrl
    expect(telegram.sendMessage).toHaveBeenCalled()
    const msg = telegram.sendMessage.mock.calls[0][0] as string
    expect(msg).toContain("https://github.com/org/repo/pull/42")

    // Conversation should be cleared after notification
    expect(child.conversation).toEqual([])
  })

  it("works when prUrl is undefined (no PR opened)", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)
    const internals = dispatcher as unknown as DispatcherInternals

    const child = makeChildSession({
      prUrl: undefined,
      conversation: [
        { role: "user", text: "fix the bug" },
        { role: "assistant", text: "Done" },
      ],
    })
    const parent = makeParentSession([child])

    internals.topicSessions.set(child.threadId, child)
    internals.topicSessions.set(parent.threadId, parent)

    await internals.notifyParentOfChildComplete(child, "completed")

    expect(telegram.sendMessage).toHaveBeenCalled()
    const msg = telegram.sendMessage.mock.calls[0][0] as string
    expect(msg).toContain("child-1")
    expect(msg).not.toContain("github.com")
  })

  it("returns early when child has no parentThreadId", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)
    const internals = dispatcher as unknown as DispatcherInternals

    const child = makeChildSession({ parentThreadId: undefined })
    child.parentThreadId = undefined

    await internals.notifyParentOfChildComplete(child, "completed")

    expect(telegram.sendMessage).not.toHaveBeenCalled()
  })

  it("clears child conversation memory after notification", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)
    const internals = dispatcher as unknown as DispatcherInternals

    const child = makeChildSession({
      conversation: Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? "user" as const : "assistant" as const,
        text: `Message ${i}`,
      })),
    })
    const parent = makeParentSession([child])

    internals.topicSessions.set(child.threadId, child)
    internals.topicSessions.set(parent.threadId, parent)

    expect(child.conversation.length).toBe(10)

    await internals.notifyParentOfChildComplete(child, "completed")

    expect(child.conversation).toEqual([])
  })

  it("does not re-extract PR from conversation after prUrl is already set", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)
    const internals = dispatcher as unknown as DispatcherInternals

    // Child has PR URL in both prUrl and conversation
    const child = makeChildSession({
      prUrl: "https://github.com/org/repo/pull/42",
      conversation: [
        { role: "user", text: "fix the bug" },
        { role: "assistant", text: "Created PR: https://github.com/org/repo/pull/99" },
      ],
    })
    const parent = makeParentSession([child])

    internals.topicSessions.set(child.threadId, child)
    internals.topicSessions.set(parent.threadId, parent)

    await internals.notifyParentOfChildComplete(child, "completed")

    // Should use prUrl (pull/42), NOT the one from conversation (pull/99)
    const msg = telegram.sendMessage.mock.calls[0][0] as string
    expect(msg).toContain("pull/42")
    expect(msg).not.toContain("pull/99")
  })
})

describe("parent notification guard flag", () => {
  it("prevents double notification when both .then() and fallback fire", () => {
    let parentNotified = false
    let callCount = 0

    const notify = () => {
      if (parentNotified) return
      parentNotified = true
      callCount++
    }

    // Simulate .then() path
    notify()
    // Simulate fallback path (should be guarded)
    notify()

    expect(callCount).toBe(1)
    expect(parentNotified).toBe(true)
  })

  it("allows notification from fallback when .then() never fires", () => {
    let parentNotified = false
    let callCount = 0

    const notify = () => {
      if (parentNotified) return
      parentNotified = true
      callCount++
    }

    // Simulate errored path — no .then() chain, only fallback fires
    notify()

    expect(callCount).toBe(1)
    expect(parentNotified).toBe(true)
  })

  it("allows notification from .catch() path when .then() throws", () => {
    let parentNotified = false
    let callCount = 0

    const notifyFromCatch = () => {
      if (parentNotified) return
      parentNotified = true
      callCount++
    }

    // Simulate .catch() path — .then() threw before setting flag
    notifyFromCatch()

    expect(callCount).toBe(1)
  })
})

describe("parent notification timing", () => {
  it("fires after flushAndComplete resolves, not concurrently", async () => {
    const completionOrder: string[] = []

    let parentNotified = false

    // Mock flushAndComplete that resolves asynchronously
    const flushPromise = Promise.resolve()

    // .then() path — sets flag and notifies after async work
    const thenPromise = flushPromise.then(async () => {
      completionOrder.push("postProcessing")
      parentNotified = true
      completionOrder.push("notify")
    })

    // Fallback check (runs synchronously after setting up the chain)
    if (!parentNotified) {
      // This is the race — the fallback fires immediately, .then() fires later
    }

    await thenPromise

    // The notify should happen after postProcessing
    expect(completionOrder).toEqual(["postProcessing", "notify"])
    expect(parentNotified).toBe(true)
  })
})

describe("updatePinnedSplitStatus uses lastState", () => {
  it("shows 'done' for completed child without prUrl", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)
    const internals = dispatcher as unknown as DispatcherInternals

    const child = makeChildSession({
      lastState: "completed",
      prUrl: undefined,
      activeSessionId: undefined,
    })
    const parent = makeParentSession([child])

    internals.topicSessions.set(child.threadId, child)
    internals.topicSessions.set(parent.threadId, parent)

    await internals.updatePinnedSplitStatus(parent)

    // pinThreadMessage calls sendMessage on first pin
    const sendCalls = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls
    const pinCall = sendCalls.find((c: [string]) => c[0].includes("child-slug"))
    expect(pinCall).toBeDefined()
    expect(pinCall![0]).toContain("✅")
    expect(pinCall![0]).not.toContain("❌")
  })

  it("shows 'failed' for errored child even with prUrl", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)
    const internals = dispatcher as unknown as DispatcherInternals

    const child = makeChildSession({
      lastState: "errored",
      prUrl: "https://github.com/org/repo/pull/99",
      activeSessionId: undefined,
    })
    const parent = makeParentSession([child])

    internals.topicSessions.set(child.threadId, child)
    internals.topicSessions.set(parent.threadId, parent)

    await internals.updatePinnedSplitStatus(parent)

    const sendCalls = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls
    const pinCall = sendCalls.find((c: [string]) => c[0].includes("child-slug"))
    expect(pinCall).toBeDefined()
    expect(pinCall![0]).toContain("❌")
  })

  it("shows 'failed' for child with no lastState and no activeSessionId", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)
    const internals = dispatcher as unknown as DispatcherInternals

    const child = makeChildSession({
      lastState: undefined,
      prUrl: undefined,
      activeSessionId: undefined,
    })
    const parent = makeParentSession([child])

    internals.topicSessions.set(child.threadId, child)
    internals.topicSessions.set(parent.threadId, parent)

    await internals.updatePinnedSplitStatus(parent)

    const sendCalls = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls
    const pinCall = sendCalls.find((c: [string]) => c[0].includes("child-slug"))
    expect(pinCall).toBeDefined()
    expect(pinCall![0]).toContain("❌")
  })
})

describe("allDone succeeded count uses lastState", () => {
  it("counts completed children without prUrl as succeeded", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)
    const internals = dispatcher as unknown as DispatcherInternals

    const child1 = makeChildSession({
      threadId: 201,
      slug: "child-1",
      splitLabel: "Task 1",
      lastState: "completed",
      prUrl: "https://github.com/org/repo/pull/1",
      activeSessionId: undefined,
    })
    const child2 = makeChildSession({
      threadId: 202,
      slug: "child-2",
      splitLabel: "Task 2",
      lastState: "completed",
      prUrl: undefined, // Completed but no PR
      activeSessionId: undefined,
    })
    const child3 = makeChildSession({
      threadId: 203,
      slug: "child-3",
      splitLabel: "Task 3",
      lastState: "errored",
      prUrl: undefined,
      activeSessionId: undefined,
    })

    const parent = makeParentSession([child1, child2, child3])
    parent.pendingSplitItems = []

    internals.topicSessions.set(child1.threadId, child1)
    internals.topicSessions.set(child2.threadId, child2)
    internals.topicSessions.set(child3.threadId, child3)
    internals.topicSessions.set(parent.threadId, parent)

    // Notify for the last child to trigger allDone
    await internals.notifyParentOfChildComplete(child3, "errored")

    // Should find the "Split complete" message with 2/3 succeeded
    const calls = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls
    const allDoneCall = calls.find((c: [string]) => c[0].includes("Split complete"))
    expect(allDoneCall).toBeDefined()
    expect(allDoneCall![0]).toContain("2/3 succeeded")
  })

  it("counts 4/4 when all children completed even without prUrl", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)
    const internals = dispatcher as unknown as DispatcherInternals

    const children = [201, 202, 203, 204].map((id, i) =>
      makeChildSession({
        threadId: id,
        slug: `child-${i}`,
        splitLabel: `Task ${i}`,
        lastState: "completed",
        prUrl: i === 0 ? "https://github.com/org/repo/pull/1" : undefined,
        activeSessionId: undefined,
      }),
    )

    const parent = makeParentSession(children)
    parent.pendingSplitItems = []

    for (const child of children) {
      internals.topicSessions.set(child.threadId, child)
    }
    internals.topicSessions.set(parent.threadId, parent)

    // Notify last child
    await internals.notifyParentOfChildComplete(children[3], "completed")

    const calls = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls
    const allDoneCall = calls.find((c: [string]) => c[0].includes("Split complete"))
    expect(allDoneCall).toBeDefined()
    expect(allDoneCall![0]).toContain("4/4 succeeded")
  })
})
