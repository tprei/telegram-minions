import { describe, it, expect, vi, beforeEach } from "vitest"
import { TopicManager } from "../src/orchestration/topic-manager.js"
import type { DispatcherContext } from "../src/orchestration/dispatcher-context.js"
import type { TopicSession } from "../src/types.js"
import { loggers } from "../src/logger.js"

function createMockContext(overrides: Partial<DispatcherContext> = {}): DispatcherContext {
  const sessions = new Map()
  const topicSessions = new Map()
  const dags = new Map()

  return {
    config: {
      telegram: { chatId: 123 },
      workspace: { root: "/tmp/test", maxConcurrentSessions: 5, maxSplitItems: 10 },
    } as any,
    telegram: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      deleteForumTopic: vi.fn().mockResolvedValue(true),
    } as any,
    observer: {} as any,
    stats: {} as any,
    profileStore: {} as any,
    broadcaster: undefined,
    sessions,
    topicSessions,
    dags,
    refreshGitToken: vi.fn().mockResolvedValue(undefined),
    spawnTopicAgent: vi.fn().mockResolvedValue(undefined),
    spawnCIFixAgent: vi.fn().mockResolvedValue(undefined),
    prepareWorkspace: vi.fn().mockResolvedValue("/tmp/test/workspace"),
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    cleanBuildArtifacts: vi.fn(),
    prepareFanInBranch: vi.fn().mockResolvedValue(null),
    mergeUpstreamBranches: vi.fn().mockReturnValue({ ok: true, conflictFiles: [] }),
    downloadPhotos: vi.fn().mockResolvedValue([]),
    pushToConversation: vi.fn(),
    extractPRFromConversation: vi.fn().mockReturnValue(null),
    persistTopicSessions: vi.fn().mockResolvedValue(undefined),
    persistDags: vi.fn().mockResolvedValue(undefined),
    updatePinnedSummary: vi.fn(),
    updateTopicTitle: vi.fn().mockResolvedValue(undefined),
    pinThreadMessage: vi.fn().mockResolvedValue(undefined),
    updatePinnedSplitStatus: vi.fn().mockResolvedValue(undefined),
    updatePinnedDagStatus: vi.fn().mockResolvedValue(undefined),
    broadcastSession: vi.fn(),
    broadcastSessionDeleted: vi.fn(),
    broadcastDag: vi.fn(),
    broadcastDagDeleted: vi.fn(),
    closeChildSessions: vi.fn().mockResolvedValue(undefined),
    closeSingleChild: vi.fn().mockResolvedValue(undefined),
    startDag: vi.fn().mockResolvedValue(undefined),
    shipAdvanceToVerification: vi.fn().mockResolvedValue(undefined),
    handleLandCommand: vi.fn().mockResolvedValue(undefined),
    handleShipAdvance: vi.fn().mockResolvedValue(undefined),
    shipAdvanceToDag: vi.fn().mockResolvedValue(undefined),
    handleExecuteCommand: vi.fn().mockResolvedValue(undefined),
    notifyParentOfChildComplete: vi.fn().mockResolvedValue(undefined),
    postSessionDigest: vi.fn(),
    runDeferredBabysit: vi.fn().mockResolvedValue(undefined),
    babysitPR: vi.fn().mockResolvedValue(undefined),
    babysitDagChildCI: vi.fn().mockResolvedValue(true),
    updateDagPRDescriptions: vi.fn().mockResolvedValue(undefined),
    scheduleDagNodes: vi.fn().mockResolvedValue(undefined),
    spawnSplitChild: vi.fn().mockResolvedValue(null),
    spawnDagChild: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
}

function makeTopicSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 100,
    repo: "test-repo",
    cwd: "/tmp/workspace",
    slug: "test-slug",
    conversation: [],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

describe("TopicManager", () => {
  describe("closeSingleChild", () => {
    it("kills active session, removes from maps, deletes topic", async () => {
      const ctx = createMockContext()
      const manager = new TopicManager(ctx)

      const mockKill = vi.fn().mockResolvedValue(undefined)
      const child = makeTopicSession({
        threadId: 200,
        slug: "child-slug",
        activeSessionId: "session-1",
      })
      ctx.topicSessions.set(200, child)
      ctx.sessions.set(200, { handle: { kill: mockKill } } as any)

      await manager.closeSingleChild(child)

      expect(mockKill).toHaveBeenCalled()
      expect(ctx.sessions.has(200)).toBe(false)
      expect(ctx.topicSessions.has(200)).toBe(false)
      expect(ctx.broadcastSessionDeleted).toHaveBeenCalledWith("child-slug")
      expect(ctx.telegram.deleteForumTopic).toHaveBeenCalledWith(200)
      expect(ctx.removeWorkspace).toHaveBeenCalledWith(child)
    })

    it("handles child with no active session", async () => {
      const ctx = createMockContext()
      const manager = new TopicManager(ctx)

      const child = makeTopicSession({ threadId: 200, slug: "child-slug" })
      ctx.topicSessions.set(200, child)

      await manager.closeSingleChild(child)

      expect(ctx.topicSessions.has(200)).toBe(false)
      expect(ctx.broadcastSessionDeleted).toHaveBeenCalledWith("child-slug")
      expect(ctx.telegram.deleteForumTopic).toHaveBeenCalledWith(200)
    })
  })

  describe("closeChildSessions", () => {
    it("closes children listed in childThreadIds", async () => {
      const ctx = createMockContext()
      const manager = new TopicManager(ctx)

      const parent = makeTopicSession({
        threadId: 100,
        childThreadIds: [201, 202],
      })
      const child1 = makeTopicSession({ threadId: 201, slug: "child-1", parentThreadId: 100 })
      const child2 = makeTopicSession({ threadId: 202, slug: "child-2", parentThreadId: 100 })
      ctx.topicSessions.set(100, parent)
      ctx.topicSessions.set(201, child1)
      ctx.topicSessions.set(202, child2)

      await manager.closeChildSessions(parent)

      expect(ctx.topicSessions.has(201)).toBe(false)
      expect(ctx.topicSessions.has(202)).toBe(false)
      expect(parent.childThreadIds).toEqual([])
    })

    it("finds orphaned children by parentThreadId scan", async () => {
      const ctx = createMockContext()
      const manager = new TopicManager(ctx)

      const parent = makeTopicSession({
        threadId: 100,
        childThreadIds: [],
      })
      const orphan = makeTopicSession({ threadId: 300, slug: "orphan", parentThreadId: 100 })
      ctx.topicSessions.set(100, parent)
      ctx.topicSessions.set(300, orphan)

      await manager.closeChildSessions(parent)

      expect(ctx.topicSessions.has(300)).toBe(false)
    })

    it("does not close unrelated sessions", async () => {
      const ctx = createMockContext()
      const manager = new TopicManager(ctx)

      const parent = makeTopicSession({ threadId: 100, childThreadIds: [] })
      const unrelated = makeTopicSession({ threadId: 500, slug: "unrelated" })
      ctx.topicSessions.set(100, parent)
      ctx.topicSessions.set(500, unrelated)

      await manager.closeChildSessions(parent)

      expect(ctx.topicSessions.has(500)).toBe(true)
    })

    it("logs warning when closing more than 10 children", async () => {
      const warnSpy = vi.spyOn(loggers.dispatcher, "warn").mockImplementation(() => loggers.dispatcher)
      const ctx = createMockContext()
      const manager = new TopicManager(ctx)

      const childIds: number[] = []
      const parent = makeTopicSession({ threadId: 100, slug: "parent" })

      for (let i = 0; i < 15; i++) {
        const id = 2000 + i
        childIds.push(id)
        ctx.topicSessions.set(id, makeTopicSession({
          threadId: id,
          slug: `child-${i}`,
          parentThreadId: 100,
        }))
      }
      parent.childThreadIds = childIds
      ctx.topicSessions.set(100, parent)

      await manager.closeChildSessions(parent)

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ count: 15, parentThreadId: 100 }),
        "Unusually high number of children to close - possible bug?",
      )
      warnSpy.mockRestore()
    })
  })

  describe("handleCloseCommand", () => {
    it("deletes topic and cleans up workspace", async () => {
      const ctx = createMockContext()
      const manager = new TopicManager(ctx)

      const session = makeTopicSession({ threadId: 100, slug: "test-slug" })
      ctx.topicSessions.set(100, session)

      await manager.handleCloseCommand(session)

      expect(ctx.topicSessions.has(100)).toBe(false)
      expect(ctx.broadcastSessionDeleted).toHaveBeenCalledWith("test-slug")
      expect(ctx.persistTopicSessions).toHaveBeenCalled()
      expect(ctx.updatePinnedSummary).toHaveBeenCalled()
      expect(ctx.telegram.deleteForumTopic).toHaveBeenCalledWith(100)
      expect(ctx.removeWorkspace).toHaveBeenCalledWith(session)
    })

    it("deletes DAG when session has dagId", async () => {
      const ctx = createMockContext()
      const manager = new TopicManager(ctx)

      const session = makeTopicSession({ threadId: 100, dagId: "dag-1" })
      ctx.topicSessions.set(100, session)
      ctx.dags.set("dag-1", {} as any)

      await manager.handleCloseCommand(session)

      expect(ctx.broadcastDagDeleted).toHaveBeenCalledWith("dag-1")
      expect(ctx.dags.has("dag-1")).toBe(false)
    })

    it("kills active session in background before workspace cleanup", async () => {
      const ctx = createMockContext()
      const manager = new TopicManager(ctx)

      const mockKill = vi.fn().mockResolvedValue(undefined)
      const session = makeTopicSession({
        threadId: 100,
        activeSessionId: "active-1",
      })
      ctx.topicSessions.set(100, session)
      ctx.sessions.set(100, { handle: { kill: mockKill } } as any)

      await manager.handleCloseCommand(session)

      expect(ctx.sessions.has(100)).toBe(false)
      expect(mockKill).toHaveBeenCalled()
    })

    it("closes child sessions before closing parent", async () => {
      const ctx = createMockContext()
      const manager = new TopicManager(ctx)

      const child = makeTopicSession({ threadId: 200, slug: "child", parentThreadId: 100 })
      const parent = makeTopicSession({ threadId: 100, childThreadIds: [200] })
      ctx.topicSessions.set(100, parent)
      ctx.topicSessions.set(200, child)

      await manager.handleCloseCommand(parent)

      expect(ctx.topicSessions.has(200)).toBe(false)
      expect(ctx.topicSessions.has(100)).toBe(false)
    })
  })

  describe("handleDoneCommand", () => {
    it("rejects /done on child sessions", async () => {
      const ctx = createMockContext()
      const manager = new TopicManager(ctx)

      const session = makeTopicSession({ threadId: 100, parentThreadId: 50 })

      await manager.handleDoneCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("not available on child sessions"),
        100,
      )
    })

    it("rejects /done on DAG node sessions", async () => {
      const ctx = createMockContext()
      const manager = new TopicManager(ctx)

      const session = makeTopicSession({ threadId: 100, dagNodeId: "node-1" })

      await manager.handleDoneCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("not available on child sessions"),
        100,
      )
    })

    it("rejects when no PR found", async () => {
      const ctx = createMockContext()
      const manager = new TopicManager(ctx)

      const session = makeTopicSession({ threadId: 100 })

      await manager.handleDoneCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No PR found"),
        100,
      )
    })

    it("uses prUrl from session when available", async () => {
      const ctx = createMockContext()
      const manager = new TopicManager(ctx)

      const session = makeTopicSession({ threadId: 100, prUrl: "https://github.com/org/repo/pull/1" })

      await manager.handleDoneCommand(session)

      // Should attempt to check CI (which will fail since execSync is not mocked),
      // but should NOT report "No PR found"
      const calls = (ctx.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls
      const messages = calls.map((c: any[]) => c[0])
      expect(messages.every((m: string) => !m.includes("No PR found"))).toBe(true)
    })
  })
})
