import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  formatPinnedSummary,
  updatePinnedSummary,
  scheduleUpdatePinnedSummary,
  pinThreadMessage,
  updatePinnedSplitStatus,
  updatePinnedDagStatus,
} from "../src/pinned-messages.js"
import type { TopicSession } from "../src/types.js"
import type { DagNode } from "../src/dag.js"

describe("formatPinnedSummary", () => {
  it("returns 'No active minion sessions.' for empty array", () => {
    expect(formatPinnedSummary([])).toBe("No active minion sessions.")
  })

  it("formats single session with activeSessionId", () => {
    const session: TopicSession = {
      threadId: 1,
      repo: "my-repo",
      cwd: "/workspace/my-repo",
      slug: "bold-arc",
      conversation: [{ role: "user", text: "fix the bug in the codebase" }],
      activeSessionId: "session-123",
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    const result = formatPinnedSummary([session])
    expect(result).toContain("⚡")
    expect(result).toContain("<b>bold-arc</b>")
    expect(result).toContain("fix the bug in the codebase")
    expect(result).toContain("(task)")
  })

  it("formats session without activeSessionId with speech bubble", () => {
    const session: TopicSession = {
      threadId: 1,
      repo: "my-repo",
      cwd: "/workspace/my-repo",
      slug: "calm-bay",
      conversation: [{ role: "user", text: "plan the feature" }],
      activeSessionId: undefined,
      pendingFeedback: [],
      mode: "plan",
      lastActivityAt: Date.now(),
    }
    const result = formatPinnedSummary([session])
    expect(result).toContain("💬")
    expect(result).toContain("calm-bay")
  })

  it("truncates long task text to 60 chars", () => {
    const longText = "a".repeat(100)
    const session: TopicSession = {
      threadId: 1,
      repo: "my-repo",
      cwd: "/workspace/my-repo",
      slug: "bold-arc",
      conversation: [{ role: "user", text: longText }],
      activeSessionId: "session-123",
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    const result = formatPinnedSummary([session])
    expect(result).toContain("…")
    expect(result).not.toContain("a".repeat(100))
  })

  it("escapes HTML in slug and task text", () => {
    const session: TopicSession = {
      threadId: 1,
      repo: "my-repo",
      cwd: "/workspace/my-repo",
      slug: "test<script>",
      conversation: [{ role: "user", text: "fix <b>bold</b> bug" }],
      activeSessionId: "session-123",
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    const result = formatPinnedSummary([session])
    expect(result).toContain("&lt;script&gt;")
    expect(result).toContain("&lt;b&gt;")
    expect(result).not.toContain("<script>")
    expect(result).not.toContain("<b>bold</b>")
  })

  it("formats multiple sessions on separate lines", () => {
    const sessions: TopicSession[] = [
      {
        threadId: 1,
        repo: "repo1",
        cwd: "/workspace/repo1",
        slug: "bold-arc",
        conversation: [{ role: "user", text: "task 1" }],
        activeSessionId: "s1",
        pendingFeedback: [],
        mode: "task",
        lastActivityAt: Date.now(),
      },
      {
        threadId: 2,
        repo: "repo2",
        cwd: "/workspace/repo2",
        slug: "calm-bay",
        conversation: [{ role: "user", text: "task 2" }],
        activeSessionId: undefined,
        pendingFeedback: [],
        mode: "plan",
        lastActivityAt: Date.now(),
      },
    ]
    const result = formatPinnedSummary(sessions)
    const lines = result.split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("bold-arc")
    expect(lines[1]).toContain("calm-bay")
  })
})

describe("updatePinnedSummary", () => {
  it("edits existing message when pinnedSummaryMessageId is set", async () => {
    const telegram = {
      editMessage: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn(),
      pinChatMessage: vi.fn(),
    }
    const topicSessions = new Map<number, TopicSession>()
    const onMessageIdChange = vi.fn()

    await updatePinnedSummary({
      telegram: telegram as any,
      workspaceRoot: "/workspace",
      topicSessions,
      pinnedSummaryMessageId: 12345,
      onMessageIdChange,
    })

    expect(telegram.editMessage).toHaveBeenCalledWith(12345, "No active minion sessions.")
    expect(telegram.sendMessage).not.toHaveBeenCalled()
    expect(onMessageIdChange).not.toHaveBeenCalled()
  })

  it("creates new message when edit fails", async () => {
    const telegram = {
      editMessage: vi.fn().mockResolvedValue(false),
      sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: 67890 }),
      pinChatMessage: vi.fn().mockResolvedValue(true),
    }
    const topicSessions = new Map<number, TopicSession>()
    const onMessageIdChange = vi.fn()

    await updatePinnedSummary({
      telegram: telegram as any,
      workspaceRoot: "/workspace",
      topicSessions,
      pinnedSummaryMessageId: 12345,
      onMessageIdChange,
    })

    expect(telegram.editMessage).toHaveBeenCalledWith(12345, "No active minion sessions.")
    expect(telegram.sendMessage).toHaveBeenCalledWith("No active minion sessions.")
    expect(telegram.pinChatMessage).toHaveBeenCalledWith(67890)
    expect(onMessageIdChange).toHaveBeenCalledWith(67890)
  })

  it("creates new message when pinnedSummaryMessageId is null", async () => {
    const telegram = {
      editMessage: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: 67890 }),
      pinChatMessage: vi.fn().mockResolvedValue(true),
    }
    const topicSessions = new Map<number, TopicSession>()
    const onMessageIdChange = vi.fn()

    await updatePinnedSummary({
      telegram: telegram as any,
      workspaceRoot: "/workspace",
      topicSessions,
      pinnedSummaryMessageId: null,
      onMessageIdChange,
    })

    expect(telegram.editMessage).not.toHaveBeenCalled()
    expect(telegram.sendMessage).toHaveBeenCalled()
    expect(telegram.pinChatMessage).toHaveBeenCalledWith(67890)
    expect(onMessageIdChange).toHaveBeenCalledWith(67890)
  })
})

describe("scheduleUpdatePinnedSummary", () => {
  it("calls updatePinnedSummary asynchronously", async () => {
    const telegram = {
      editMessage: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn(),
      pinChatMessage: vi.fn(),
    }
    const topicSessions = new Map<number, TopicSession>()
    const onMessageIdChange = vi.fn()

    scheduleUpdatePinnedSummary({
      telegram: telegram as any,
      workspaceRoot: "/workspace",
      topicSessions,
      pinnedSummaryMessageId: 12345,
      onMessageIdChange,
    })

    // Wait for async operation
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(telegram.editMessage).toHaveBeenCalledWith(12345, "No active minion sessions.")
  })
})

describe("pinThreadMessage", () => {
  it("edits existing pinned message", async () => {
    const telegram = {
      editMessage: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn(),
      pinChatMessage: vi.fn(),
    }
    const session: TopicSession = {
      threadId: 100,
      repo: "repo",
      cwd: "/workspace/repo",
      slug: "test-slug",
      conversation: [],
      pinnedMessageId: 12345,
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    await pinThreadMessage(telegram as any, session, "<b>status</b>")

    expect(telegram.editMessage).toHaveBeenCalledWith(12345, "<b>status</b>", 100)
    expect(telegram.sendMessage).not.toHaveBeenCalled()
  })

  it("creates new message when edit fails", async () => {
    const telegram = {
      editMessage: vi.fn().mockResolvedValue(false),
      sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: 67890 }),
      pinChatMessage: vi.fn().mockResolvedValue(true),
    }
    const session: TopicSession = {
      threadId: 100,
      repo: "repo",
      cwd: "/workspace/repo",
      slug: "test-slug",
      conversation: [],
      pinnedMessageId: 12345,
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    await pinThreadMessage(telegram as any, session, "<b>status</b>")

    expect(telegram.editMessage).toHaveBeenCalledWith(12345, "<b>status</b>", 100)
    expect(telegram.sendMessage).toHaveBeenCalledWith("<b>status</b>", 100)
    expect(telegram.pinChatMessage).toHaveBeenCalledWith(67890)
    expect(session.pinnedMessageId).toBe(67890)
  })

  it("creates new message when pinnedMessageId is undefined", async () => {
    const telegram = {
      editMessage: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: 67890 }),
      pinChatMessage: vi.fn().mockResolvedValue(true),
    }
    const session: TopicSession = {
      threadId: 100,
      repo: "repo",
      cwd: "/workspace/repo",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    await pinThreadMessage(telegram as any, session, "<b>status</b>")

    expect(telegram.editMessage).not.toHaveBeenCalled()
    expect(telegram.sendMessage).toHaveBeenCalledWith("<b>status</b>", 100)
    expect(session.pinnedMessageId).toBe(67890)
  })
})

describe("updatePinnedSplitStatus", () => {
  it("does nothing when parent has no childThreadIds", async () => {
    const telegram = {
      editMessage: vi.fn(),
      sendMessage: vi.fn(),
      pinChatMessage: vi.fn(),
    }
    const parent: TopicSession = {
      threadId: 100,
      repo: "repo",
      cwd: "/workspace/repo",
      slug: "parent-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    await updatePinnedSplitStatus(telegram as any, parent, () => undefined)

    expect(telegram.editMessage).not.toHaveBeenCalled()
    expect(telegram.sendMessage).not.toHaveBeenCalled()
  })

  it("does nothing when childThreadIds is empty", async () => {
    const telegram = {
      editMessage: vi.fn(),
      sendMessage: vi.fn(),
      pinChatMessage: vi.fn(),
    }
    const parent: TopicSession = {
      threadId: 100,
      repo: "repo",
      cwd: "/workspace/repo",
      slug: "parent-slug",
      conversation: [],
      childThreadIds: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    await updatePinnedSplitStatus(telegram as any, parent, () => undefined)

    expect(telegram.editMessage).not.toHaveBeenCalled()
    expect(telegram.sendMessage).not.toHaveBeenCalled()
  })

  it("pins status with children", async () => {
    const telegram = {
      editMessage: vi.fn().mockResolvedValue(false),
      sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: 999 }),
      pinChatMessage: vi.fn().mockResolvedValue(true),
    }
    const parent: TopicSession = {
      threadId: 100,
      repo: "repo",
      cwd: "/workspace/repo",
      slug: "parent-slug",
      conversation: [],
      childThreadIds: [101, 102],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    const child1: TopicSession = {
      threadId: 101,
      repo: "repo",
      cwd: "/workspace/repo",
      slug: "child-1",
      splitLabel: "Fix auth",
      prUrl: "https://github.com/org/repo/pull/1",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    const child2: TopicSession = {
      threadId: 102,
      repo: "repo",
      cwd: "/workspace/repo",
      slug: "child-2",
      splitLabel: "Fix tests",
      activeSessionId: "session-2",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    const sessions = new Map<number, TopicSession>([
      [101, child1],
      [102, child2],
    ])

    await updatePinnedSplitStatus(telegram as any, parent, (id) => sessions.get(id))

    expect(telegram.sendMessage).toHaveBeenCalled()
    const call = telegram.sendMessage.mock.calls[0]
    expect(call[0]).toContain("parent-slug")
    expect(call[0]).toContain("child-1")
    expect(call[0]).toContain("child-2")
  })
})

describe("updatePinnedDagStatus", () => {
  it("pins DAG status with nodes", async () => {
    const telegram = {
      editMessage: vi.fn().mockResolvedValue(false),
      sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: 999 }),
      pinChatMessage: vi.fn().mockResolvedValue(true),
    }
    const parent: TopicSession = {
      threadId: 100,
      repo: "repo",
      cwd: "/workspace/repo",
      slug: "parent-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    const nodes: DagNode[] = [
      {
        id: "node-1",
        title: "Task 1",
        dependsOn: [],
        status: "done",
        prUrl: "https://github.com/org/repo/pull/1",
      },
      {
        id: "node-2",
        title: "Task 2",
        dependsOn: ["node-1"],
        status: "running",
      },
    ]

    await updatePinnedDagStatus(telegram as any, parent, nodes)

    expect(telegram.sendMessage).toHaveBeenCalled()
    const call = telegram.sendMessage.mock.calls[0]
    expect(call[0]).toContain("parent-slug")
    expect(call[0]).toContain("Task 1")
    expect(call[0]).toContain("Task 2")
  })
})
