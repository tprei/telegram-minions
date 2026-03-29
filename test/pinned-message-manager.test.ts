import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs"
import { PinnedMessageManager } from "../src/pinned-message-manager.js"
import type { TopicSession } from "../src/types.js"
import type { DagGraph, DagNode } from "../src/dag.js"

vi.mock("node:fs")

function makeTelegram() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: 100 }),
    editMessage: vi.fn().mockResolvedValue(true),
    pinChatMessage: vi.fn().mockResolvedValue(undefined),
    editForumTopic: vi.fn().mockResolvedValue(undefined),
  } as any
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
