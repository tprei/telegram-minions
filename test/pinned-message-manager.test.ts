import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs"
import { PinnedMessageManager } from "../src/telegram/pinned-message-manager.js"
import type { TopicSession } from "../src/domain/session-types.js"
import type { DagGraph, DagNode } from "../src/dag/dag.js"
import { makeMockTelegram } from "./test-helpers.js"

vi.mock("node:fs")

function makeTelegram() {
  return makeMockTelegram({
    sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: 100 }),
    editMessage: vi.fn().mockResolvedValue(true),
    pinChatMessage: vi.fn().mockResolvedValue(undefined),
    editForumTopic: vi.fn().mockResolvedValue(undefined),
  })
}

function makeSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 1,
    repo: "test-repo",
    slug: "bold-fox",
    conversation: [{ role: "user", text: "fix the tests" }],
    activeSessionId: "abc",
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    cwd: "/tmp/workspace/bold-fox",
    ...overrides,
  }
}

describe("PinnedMessageManager", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("no file") })
    vi.mocked(fs.writeFileSync).mockImplementation(() => {})
  })

  describe("updatePinnedSummary", () => {
    it("sends a new pinned summary when none exists", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      topicSessions.set(1, makeSession())

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      mgr.updatePinnedSummary()

      // Wait for the async IIFE
      await new Promise((r) => setTimeout(r, 10))

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("bold-fox"),
      )
      expect(telegram.pinChatMessage).toHaveBeenCalledWith(100)
    })

    it("edits existing pinned message when one exists", async () => {
      const telegram = makeTelegram()
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ messageId: 50 }))

      const topicSessions = new Map<number, TopicSession>()
      topicSessions.set(1, makeSession())

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      mgr.updatePinnedSummary()

      await new Promise((r) => setTimeout(r, 10))

      expect(telegram.editMessage).toHaveBeenCalledWith(50, expect.stringContaining("bold-fox"))
      expect(telegram.sendMessage).not.toHaveBeenCalled()
    })

    it("falls back to new message if edit fails", async () => {
      const telegram = makeTelegram()
      telegram.editMessage.mockResolvedValue(false)
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ messageId: 50 }))

      const topicSessions = new Map<number, TopicSession>()
      topicSessions.set(1, makeSession())

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      mgr.updatePinnedSummary()

      await new Promise((r) => setTimeout(r, 10))

      expect(telegram.editMessage).toHaveBeenCalledWith(50, expect.any(String))
      expect(telegram.sendMessage).toHaveBeenCalled()
    })

    it("shows 'No active minion sessions' when empty", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      mgr.updatePinnedSummary()

      await new Promise((r) => setTimeout(r, 10))

      expect(telegram.sendMessage).toHaveBeenCalledWith("No active minion sessions.")
    })

    it("includes header with total session count", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      topicSessions.set(1, makeSession())
      topicSessions.set(2, makeSession({ threadId: 2, slug: "calm-owl" }))

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      mgr.updatePinnedSummary()

      await new Promise((r) => setTimeout(r, 10))

      const html = telegram.sendMessage.mock.calls[0][0] as string
      expect(html).toContain("Minion Sessions")
      expect(html).toContain("2 total")
    })

    it("adds thread hyperlinks when chatId is provided", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      topicSessions.set(1, makeSession({ threadId: 42 }))

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace", chatId: -1001234567890 })
      mgr.updatePinnedSummary()

      await new Promise((r) => setTimeout(r, 10))

      const html = telegram.sendMessage.mock.calls[0][0] as string
      expect(html).toContain('href="https://t.me/c/1234567890/42"')
      expect(html).toContain(">bold-fox</a>")
    })

    it("uses code tags for slugs when chatId is not provided", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      topicSessions.set(1, makeSession())

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      mgr.updatePinnedSummary()

      await new Promise((r) => setTimeout(r, 10))

      const html = telegram.sendMessage.mock.calls[0][0] as string
      expect(html).toContain("<code>bold-fox</code>")
    })

    it("excludes child sessions from top level and nests them under parent", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      const parent = makeSession({ threadId: 10, slug: "main-task", childThreadIds: [20, 30] })
      const child1 = makeSession({ threadId: 20, slug: "child-one", parentThreadId: 10, splitLabel: "Add auth", prUrl: "https://pr/1", activeSessionId: undefined })
      const child2 = makeSession({ threadId: 30, slug: "child-two", parentThreadId: 10, splitLabel: "Add tests" })
      topicSessions.set(10, parent)
      topicSessions.set(20, child1)
      topicSessions.set(30, child2)

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace", chatId: -1001234567890 })
      mgr.updatePinnedSummary()

      await new Promise((r) => setTimeout(r, 10))

      const html = telegram.sendMessage.mock.calls[0][0] as string
      // Parent is at top level
      expect(html).toContain(">main-task</a>")
      // Children are nested with tree characters
      expect(html).toContain("├── ")
      expect(html).toContain("└── ")
      // Child slugs are linked
      expect(html).toContain(">child-one</a>")
      expect(html).toContain(">child-two</a>")
      // Split labels shown
      expect(html).toContain("Add auth")
      expect(html).toContain("Add tests")
      // PR link for child1
      expect(html).toContain('href="https://pr/1">PR</a>')
      // Done count shown on parent
      expect(html).toContain("1/2 done")
      // 3 total in header (parent + 2 children)
      expect(html).toContain("3 total")
    })

    it("shows correct status icons for sessions", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      topicSessions.set(1, makeSession({ threadId: 1, slug: "running-one" })) // active → ⚡
      topicSessions.set(2, makeSession({ threadId: 2, slug: "done-one", activeSessionId: undefined, prUrl: "https://pr/1" })) // done → ✅
      topicSessions.set(3, makeSession({ threadId: 3, slug: "errored-one", activeSessionId: undefined, lastState: "errored" })) // errored → ❌
      topicSessions.set(4, makeSession({ threadId: 4, slug: "idle-one", activeSessionId: undefined })) // idle → 💬

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      mgr.updatePinnedSummary()

      await new Promise((r) => setTimeout(r, 10))

      const html = telegram.sendMessage.mock.calls[0][0] as string
      expect(html).toMatch(/⚡.*running-one/)
      expect(html).toMatch(/✅.*done-one/)
      expect(html).toMatch(/❌.*errored-one/)
      expect(html).toMatch(/💬.*idle-one/)
    })

    it("works with string chatId", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      topicSessions.set(1, makeSession({ threadId: 42 }))

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace", chatId: "-1001234567890" })
      mgr.updatePinnedSummary()

      await new Promise((r) => setTimeout(r, 10))

      const html = telegram.sendMessage.mock.calls[0][0] as string
      expect(html).toContain('href="https://t.me/c/1234567890/42"')
    })

    it("shows multiple parents each with their own children", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      const parent1 = makeSession({ threadId: 10, slug: "parent-one", childThreadIds: [20] })
      const child1 = makeSession({ threadId: 20, slug: "child-a", parentThreadId: 10, splitLabel: "Task A" })
      const parent2 = makeSession({ threadId: 30, slug: "parent-two", childThreadIds: [40] })
      const child2 = makeSession({ threadId: 40, slug: "child-b", parentThreadId: 30, splitLabel: "Task B" })
      topicSessions.set(10, parent1)
      topicSessions.set(20, child1)
      topicSessions.set(30, parent2)
      topicSessions.set(40, child2)

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      mgr.updatePinnedSummary()

      await new Promise((r) => setTimeout(r, 10))

      const html = telegram.sendMessage.mock.calls[0][0] as string
      expect(html).toContain("parent-one")
      expect(html).toContain("parent-two")
      expect(html).toContain("child-a")
      expect(html).toContain("child-b")
      expect(html).toContain("4 total")
    })

    it("shows done count for parent with all children completed", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      const parent = makeSession({ threadId: 10, slug: "main-task", childThreadIds: [20, 30] })
      const child1 = makeSession({ threadId: 20, slug: "child-one", parentThreadId: 10, prUrl: "https://pr/1", activeSessionId: undefined })
      const child2 = makeSession({ threadId: 30, slug: "child-two", parentThreadId: 10, prUrl: "https://pr/2", activeSessionId: undefined })
      topicSessions.set(10, parent)
      topicSessions.set(20, child1)
      topicSessions.set(30, child2)

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      mgr.updatePinnedSummary()

      await new Promise((r) => setTimeout(r, 10))

      const html = telegram.sendMessage.mock.calls[0][0] as string
      expect(html).toContain("2/2 done")
    })

    it("truncates long conversation descriptions", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      const longText = "A".repeat(100)
      topicSessions.set(1, makeSession({ conversation: [{ role: "user", text: longText }] }))

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      mgr.updatePinnedSummary()

      await new Promise((r) => setTimeout(r, 10))

      const html = telegram.sendMessage.mock.calls[0][0] as string
      expect(html.length).toBeLessThan(longText.length + 200)
      expect(html).toContain("…")
    })

    it("standalone session without children shows no tree formatting", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      topicSessions.set(1, makeSession())

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      mgr.updatePinnedSummary()

      await new Promise((r) => setTimeout(r, 10))

      const html = telegram.sendMessage.mock.calls[0][0] as string
      expect(html).not.toContain("├── ")
      expect(html).not.toContain("└── ")
      expect(html).not.toContain("done)")
    })
  })

  describe("pinThreadMessage", () => {
    it("sends and pins a new message in a thread", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      const session = makeSession()

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      await mgr.pinThreadMessage(session, "<b>Status</b>")

      expect(telegram.sendMessage).toHaveBeenCalledWith("<b>Status</b>", 1)
      expect(telegram.pinChatMessage).toHaveBeenCalledWith(100)
      expect(session.pinnedMessageId).toBe(100)
    })

    it("edits an existing pinned message", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      const session = makeSession({ pinnedMessageId: 42 })

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      await mgr.pinThreadMessage(session, "<b>Updated</b>")

      expect(telegram.editMessage).toHaveBeenCalledWith(42, "<b>Updated</b>", 1)
      expect(telegram.sendMessage).not.toHaveBeenCalled()
    })
  })

  describe("updatePinnedSplitStatus", () => {
    it("skips when parent has no children", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      const parent = makeSession({ childThreadIds: [] })

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      await mgr.updatePinnedSplitStatus(parent)

      expect(telegram.sendMessage).not.toHaveBeenCalled()
    })

    it("builds split status from child sessions", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      const child = makeSession({ threadId: 5, slug: "red-bear", splitLabel: "Add auth", prUrl: "https://github.com/pr/1", activeSessionId: undefined })
      topicSessions.set(5, child)
      const parent = makeSession({ childThreadIds: [5] })

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      await mgr.updatePinnedSplitStatus(parent)

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("red-bear"),
        1,
      )
    })

    it("includes thread hyperlinks when chatId is provided", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      const child = makeSession({ threadId: 5, slug: "red-bear", splitLabel: "Add auth", activeSessionId: "x" })
      topicSessions.set(5, child)
      const parent = makeSession({ childThreadIds: [5] })

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace", chatId: -1001234567890 })
      await mgr.updatePinnedSplitStatus(parent)

      const html = telegram.sendMessage.mock.calls[0][0] as string
      expect(html).toContain('href="https://t.me/c/1234567890/5"')
      expect(html).toContain(">red-bear</a>")
    })

    it("uses code tags when chatId is not provided", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      const child = makeSession({ threadId: 5, slug: "red-bear", splitLabel: "Add auth", activeSessionId: "x" })
      topicSessions.set(5, child)
      const parent = makeSession({ childThreadIds: [5] })

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      await mgr.updatePinnedSplitStatus(parent)

      const html = telegram.sendMessage.mock.calls[0][0] as string
      expect(html).toContain("<code>red-bear</code>")
      expect(html).not.toContain("t.me/c/")
    })
  })

  describe("updatePinnedDagStatus", () => {
    it("pins dag status in parent thread", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      const parent = makeSession()

      const graph: DagGraph = {
        id: "dag-1",
        parentThreadId: 1,
        repoUrl: "https://github.com/org/repo",
        startBranch: "main",
        nodes: [
          { id: "1", title: "First", description: "first task", dependsOn: [], status: "done", prUrl: "https://pr/1", branch: "b1", threadId: 2 } as DagNode,
          { id: "2", title: "Second", description: "second task", dependsOn: ["1"], status: "running", branch: "b2", threadId: 3 } as DagNode,
        ],
      }

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      await mgr.updatePinnedDagStatus(parent, graph)

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("First"),
        1,
      )
    })

    it("includes thread hyperlinks when chatId is provided", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      const parent = makeSession()

      const graph: DagGraph = {
        id: "dag-1",
        parentThreadId: 1,
        repoUrl: "https://github.com/org/repo",
        startBranch: "main",
        nodes: [
          { id: "1", title: "First", description: "first task", dependsOn: [], status: "done", prUrl: "https://pr/1", branch: "b1", threadId: 10 } as DagNode,
          { id: "2", title: "Second", description: "second task", dependsOn: ["1"], status: "running", branch: "b2", threadId: 11 } as DagNode,
        ],
      }

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace", chatId: -1001234567890 })
      await mgr.updatePinnedDagStatus(parent, graph)

      const html = telegram.sendMessage.mock.calls[0][0] as string
      expect(html).toContain('href="https://t.me/c/1234567890/10"')
      expect(html).toContain('href="https://t.me/c/1234567890/11"')
    })

    it("uses plain text when chatId is not provided", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      const parent = makeSession()

      const graph: DagGraph = {
        id: "dag-1",
        parentThreadId: 1,
        repoUrl: "https://github.com/org/repo",
        startBranch: "main",
        nodes: [
          { id: "1", title: "First", description: "first task", dependsOn: [], status: "done", prUrl: "https://pr/1", branch: "b1", threadId: 10 } as DagNode,
        ],
      }

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      await mgr.updatePinnedDagStatus(parent, graph)

      const html = telegram.sendMessage.mock.calls[0][0] as string
      expect(html).not.toContain("t.me/c/")
    })
  })

  describe("updatePinnedDagStatus with stack graph", () => {
    it("detects stack mode and renders with stack formatting", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      const parent = makeSession()

      const graph: DagGraph = {
        id: "stack-1",
        parentThreadId: 1,
        repoUrl: "https://github.com/org/repo",
        startBranch: "main",
        nodes: [
          { id: "1", title: "First", description: "first", dependsOn: [], status: "done", branch: "b1", threadId: 2 } as DagNode,
          { id: "2", title: "Second", description: "second", dependsOn: ["1"], status: "done", branch: "b2", threadId: 3 } as DagNode,
          { id: "3", title: "Third", description: "third", dependsOn: ["2"], status: "running", branch: "b3", threadId: 4 } as DagNode,
        ],
      }

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      await mgr.updatePinnedDagStatus(parent, graph)

      const html = telegram.sendMessage.mock.calls[0][0] as string
      expect(html).toContain("First")
      expect(html).toContain("Second")
      expect(html).toContain("Third")
    })
  })

  describe("updateTopicTitle", () => {
    it("calls editForumTopic with emoji and slug", async () => {
      const telegram = makeTelegram()
      const topicSessions = new Map<number, TopicSession>()
      const session = makeSession()

      const mgr = new PinnedMessageManager({ telegram, topicSessions, workspaceRoot: "/tmp/workspace" })
      await mgr.updateTopicTitle(session, "✅")

      expect(telegram.editForumTopic).toHaveBeenCalledWith(1, "✅ test-repo · bold-fox")
    })
  })
})
