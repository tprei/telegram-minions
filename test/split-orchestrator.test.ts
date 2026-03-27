import { describe, it, expect, vi, type Mock } from "vitest"
import { SplitOrchestrator, type SplitOrchestratorDeps } from "../src/split-orchestrator.js"
import type { TopicSession } from "../src/types.js"

function makeTopicSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 100,
    repo: "test-repo",
    cwd: "/tmp/test",
    slug: "test-session",
    conversation: [],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

interface MockDeps {
  telegram: {
    sendMessage: Mock
    editMessage: Mock
    pinChatMessage: Mock
    createForumTopic: Mock
    deleteForumTopic: Mock
  }
  prepareWorkspace: Mock
  spawnTopicAgent: Mock
  closeChildSessions: Mock
  updateTopicTitle: Mock
  persistTopicSessions: Mock
  handleExecuteCommand: Mock
  extractPRFromConversation: Mock
  runDeferredBabysit: Mock
  pinThreadMessage: Mock
  broadcastSession: Mock
}

function makeDeps(): { deps: SplitOrchestratorDeps; mocks: MockDeps } {
  const telegram = {
    sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: 1 }),
    editMessage: vi.fn().mockResolvedValue(true),
    pinChatMessage: vi.fn().mockResolvedValue(undefined),
    createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 200 }),
    deleteForumTopic: vi.fn().mockResolvedValue(undefined),
  }

  const mocks: MockDeps = {
    telegram,
    prepareWorkspace: vi.fn().mockResolvedValue("/tmp/workspace"),
    spawnTopicAgent: vi.fn().mockResolvedValue(undefined),
    closeChildSessions: vi.fn().mockResolvedValue(undefined),
    updateTopicTitle: vi.fn().mockResolvedValue(undefined),
    persistTopicSessions: vi.fn().mockResolvedValue(undefined),
    handleExecuteCommand: vi.fn().mockResolvedValue(undefined),
    extractPRFromConversation: vi.fn().mockReturnValue(null),
    runDeferredBabysit: vi.fn().mockResolvedValue(undefined),
    pinThreadMessage: vi.fn().mockResolvedValue(undefined),
    broadcastSession: vi.fn(),
  }

  const deps: SplitOrchestratorDeps = {
    telegram,
    config: {
      workspace: {
        maxSplitItems: 5,
        maxConcurrentSessions: 3,
      },
    } as SplitOrchestratorDeps["config"],
    topicSessions: new Map(),
    sessions: new Map(),
    prepareWorkspace: mocks.prepareWorkspace,
    spawnTopicAgent: mocks.spawnTopicAgent,
    closeChildSessions: mocks.closeChildSessions,
    updateTopicTitle: mocks.updateTopicTitle,
    persistTopicSessions: mocks.persistTopicSessions,
    handleExecuteCommand: mocks.handleExecuteCommand,
    extractPRFromConversation: mocks.extractPRFromConversation,
    runDeferredBabysit: mocks.runDeferredBabysit,
    pinThreadMessage: mocks.pinThreadMessage,
    broadcastSession: mocks.broadcastSession,
  }

  return { deps, mocks }
}

describe("SplitOrchestrator", () => {
  describe("updatePinnedSplitStatus", () => {
    it("does nothing if parent has no children", async () => {
      const { deps, mocks } = makeDeps()
      const orchestrator = new SplitOrchestrator(deps)
      const parent = makeTopicSession({ childThreadIds: [] })

      await orchestrator.updatePinnedSplitStatus(parent)

      expect(mocks.pinThreadMessage).not.toHaveBeenCalled()
    })

    it("does nothing if parent has undefined childThreadIds", async () => {
      const { deps, mocks } = makeDeps()
      const orchestrator = new SplitOrchestrator(deps)
      const parent = makeTopicSession()

      await orchestrator.updatePinnedSplitStatus(parent)

      expect(mocks.pinThreadMessage).not.toHaveBeenCalled()
    })

    it("pins status showing running child", async () => {
      const { deps, mocks } = makeDeps()
      const orchestrator = new SplitOrchestrator(deps)
      const parent = makeTopicSession({ childThreadIds: [201] })
      const child = makeTopicSession({
        threadId: 201,
        slug: "child-1",
        splitLabel: "Auth feature",
        activeSessionId: "active-123",
      })
      deps.topicSessions.set(201, child)

      await orchestrator.updatePinnedSplitStatus(parent)

      // formatPinnedSplitStatus uses slug, not label
      expect(mocks.pinThreadMessage).toHaveBeenCalledWith(parent, expect.stringContaining("child-1"))
      expect(mocks.pinThreadMessage).toHaveBeenCalledWith(parent, expect.stringContaining("running"))
    })

    it("pins status showing done child with PR", async () => {
      const { deps, mocks } = makeDeps()
      const orchestrator = new SplitOrchestrator(deps)
      const parent = makeTopicSession({ childThreadIds: [201] })
      const child = makeTopicSession({
        threadId: 201,
        slug: "child-1",
        splitLabel: "Backend API",
        prUrl: "https://github.com/org/repo/pull/42",
      })
      deps.topicSessions.set(201, child)

      await orchestrator.updatePinnedSplitStatus(parent)

      expect(mocks.pinThreadMessage).toHaveBeenCalledWith(parent, expect.stringContaining("done"))
      expect(mocks.pinThreadMessage).toHaveBeenCalledWith(parent, expect.stringContaining("PR"))
    })

    it("pins status showing failed child without PR", async () => {
      const { deps, mocks } = makeDeps()
      const orchestrator = new SplitOrchestrator(deps)
      const parent = makeTopicSession({ childThreadIds: [201] })
      const child = makeTopicSession({
        threadId: 201,
        slug: "child-1",
        splitLabel: "Tests",
      })
      deps.topicSessions.set(201, child)

      await orchestrator.updatePinnedSplitStatus(parent)

      expect(mocks.pinThreadMessage).toHaveBeenCalledWith(parent, expect.stringContaining("failed"))
    })

    it("skips missing children in status", async () => {
      const { deps, mocks } = makeDeps()
      const orchestrator = new SplitOrchestrator(deps)
      const parent = makeTopicSession({ childThreadIds: [201, 202] })
      const child201 = makeTopicSession({ threadId: 201, slug: "child-1" })
      deps.topicSessions.set(201, child201)
      // 202 not in map

      await orchestrator.updatePinnedSplitStatus(parent)

      expect(mocks.pinThreadMessage).toHaveBeenCalled()
      const html = mocks.pinThreadMessage.mock.calls[0][1]
      expect(html).toContain("child-1")
    })

    it("uses slug as label when splitLabel missing", async () => {
      const { deps, mocks } = makeDeps()
      const orchestrator = new SplitOrchestrator(deps)
      const parent = makeTopicSession({ childThreadIds: [201] })
      const child = makeTopicSession({
        threadId: 201,
        slug: "my-slug",
      })
      deps.topicSessions.set(201, child)

      await orchestrator.updatePinnedSplitStatus(parent)

      const html = mocks.pinThreadMessage.mock.calls[0][1]
      expect(html).toContain("my-slug")
    })
  })

  describe("onSplitChildComplete", () => {
    it("sends completion message to parent", async () => {
      const { deps, mocks } = makeDeps()
      const orchestrator = new SplitOrchestrator(deps)
      const parent = makeTopicSession({ threadId: 100, childThreadIds: [201] })
      const child = makeTopicSession({
        threadId: 201,
        parentThreadId: 100,
        slug: "child-1",
        splitLabel: "Auth",
      })
      deps.topicSessions.set(100, parent)
      deps.topicSessions.set(201, child)

      await orchestrator.onSplitChildComplete(child, "completed")

      expect(mocks.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("completed"),
        100,
      )
    })

    it("extracts and stores PR URL from conversation", async () => {
      const { deps, mocks } = makeDeps()
      mocks.extractPRFromConversation.mockReturnValue("https://github.com/org/repo/pull/42")
      const orchestrator = new SplitOrchestrator(deps)
      const parent = makeTopicSession({ threadId: 100, childThreadIds: [201] })
      const child = makeTopicSession({
        threadId: 201,
        parentThreadId: 100,
        slug: "child-1",
      })
      deps.topicSessions.set(100, parent)
      deps.topicSessions.set(201, child)

      await orchestrator.onSplitChildComplete(child, "completed")

      expect(child.prUrl).toBe("https://github.com/org/repo/pull/42")
    })

    it("clears child conversation to free memory", async () => {
      const { deps } = makeDeps()
      const orchestrator = new SplitOrchestrator(deps)
      const parent = makeTopicSession({ threadId: 100, childThreadIds: [201] })
      const child = makeTopicSession({
        threadId: 201,
        parentThreadId: 100,
        conversation: [{ role: "user" as const, text: "long conversation..." }],
      })
      deps.topicSessions.set(100, parent)
      deps.topicSessions.set(201, child)

      await orchestrator.onSplitChildComplete(child, "completed")

      expect(child.conversation).toEqual([])
    })

    it("updates pinned split status", async () => {
      const { deps, mocks } = makeDeps()
      const orchestrator = new SplitOrchestrator(deps)
      const parent = makeTopicSession({ threadId: 100, childThreadIds: [201] })
      const child = makeTopicSession({
        threadId: 201,
        parentThreadId: 100,
      })
      deps.topicSessions.set(100, parent)
      deps.topicSessions.set(201, child)

      await orchestrator.onSplitChildComplete(child, "completed")

      expect(mocks.pinThreadMessage).toHaveBeenCalled()
    })

    it("sends all-done message when all children complete", async () => {
      const { deps, mocks } = makeDeps()
      const orchestrator = new SplitOrchestrator(deps)
      const parent = makeTopicSession({ threadId: 100, childThreadIds: [201, 202] })
      const child1 = makeTopicSession({ threadId: 201, parentThreadId: 100, prUrl: "https://pr/1" })
      const child2 = makeTopicSession({ threadId: 202, parentThreadId: 100, prUrl: "https://pr/2" })
      deps.topicSessions.set(100, parent)
      deps.topicSessions.set(201, child1)
      deps.topicSessions.set(202, child2)

      await orchestrator.onSplitChildComplete(child1, "completed")

      // All done message should be sent
      expect(mocks.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Split complete"),
        100,
      )
    })

    it("updates parent title with checkmark when all succeed", async () => {
      const { deps, mocks } = makeDeps()
      mocks.extractPRFromConversation.mockReturnValue("https://github.com/org/repo/pull/42")
      const orchestrator = new SplitOrchestrator(deps)
      const parent = makeTopicSession({ threadId: 100, childThreadIds: [201] })
      const child = makeTopicSession({ threadId: 201, parentThreadId: 100 })
      deps.topicSessions.set(100, parent)
      deps.topicSessions.set(201, child)

      await orchestrator.onSplitChildComplete(child, "completed")

      expect(mocks.updateTopicTitle).toHaveBeenCalledWith(parent, "✅")
    })

    it("updates parent title with warning when some fail", async () => {
      const { deps, mocks } = makeDeps()
      // No PR found = failure
      mocks.extractPRFromConversation.mockReturnValue(null)
      const orchestrator = new SplitOrchestrator(deps)
      const parent = makeTopicSession({ threadId: 100, childThreadIds: [201] })
      const child = makeTopicSession({ threadId: 201, parentThreadId: 100 })
      deps.topicSessions.set(100, parent)
      deps.topicSessions.set(201, child)

      await orchestrator.onSplitChildComplete(child, "failed")

      expect(mocks.updateTopicTitle).toHaveBeenCalledWith(parent, "⚠️")
    })

    it("runs deferred babysit when all done", async () => {
      const { deps, mocks } = makeDeps()
      const orchestrator = new SplitOrchestrator(deps)
      const parent = makeTopicSession({ threadId: 100, childThreadIds: [201] })
      const child = makeTopicSession({ threadId: 201, parentThreadId: 100 })
      deps.topicSessions.set(100, parent)
      deps.topicSessions.set(201, child)

      await orchestrator.onSplitChildComplete(child, "completed")

      expect(mocks.runDeferredBabysit).toHaveBeenCalledWith(100)
    })

    it("does not send all-done if pending items remain after spawning next", async () => {
      const { deps, mocks } = makeDeps()
      const orchestrator = new SplitOrchestrator(deps)
      const parent = makeTopicSession({
        threadId: 100,
        childThreadIds: [201],
        pendingSplitItems: [
          { title: "First", description: "Will be spawned" },
          { title: "Second", description: "Still pending" },
        ],
      })
      const child = makeTopicSession({ threadId: 201, parentThreadId: 100 })
      deps.topicSessions.set(100, parent)
      deps.topicSessions.set(201, child)

      await orchestrator.onSplitChildComplete(child, "completed")

      // Should not send all-done message because there's still a pending item
      const calls = mocks.telegram.sendMessage.mock.calls
      const allDoneCall = calls.find((c) => typeof c[0] === "string" && c[0].includes("Split complete"))
      expect(allDoneCall).toBeUndefined()
      // First pending item should have been shifted
      expect(parent.pendingSplitItems).toHaveLength(1)
    })
  })
})
