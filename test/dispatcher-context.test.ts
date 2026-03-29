import { describe, it, expect } from "vitest"
import type { DispatcherContext, PendingBabysitEntry } from "../src/dispatcher-context.js"
import type { TopicSession } from "../src/types.js"

/**
 * Tests for the DispatcherContext interface.
 *
 * These verify the interface shape is correct and that a mock implementation
 * can be created from it — which is exactly how handler tests will work.
 */

function createMockContext(overrides: Partial<DispatcherContext> = {}): DispatcherContext {
  return {
    config: {} as DispatcherContext["config"],
    telegram: {} as DispatcherContext["telegram"],
    observer: {} as DispatcherContext["observer"],
    stats: {} as DispatcherContext["stats"],
    profileStore: {} as DispatcherContext["profileStore"],
    broadcaster: undefined,

    sessions: new Map(),
    topicSessions: new Map(),
    dags: new Map(),
    pendingBabysitPRs: new Map(),
    pendingTasks: new Map(),
    pendingProfiles: new Map(),

    pushToConversation: () => {},
    broadcastSession: () => {},
    broadcastSessionDeleted: () => {},
    broadcastDag: () => {},
    broadcastDagDeleted: () => {},
    persistTopicSessions: async () => {},
    updatePinnedSummary: () => {},
    pinThreadMessage: async () => {},
    updatePinnedSplitStatus: async () => {},
    updatePinnedDagStatus: async () => {},
    updateTopicTitle: async () => {},
    spawnTopicAgent: async () => {},
    spawnCIFixAgent: async () => {},
    startTopicSession: async () => {},
    startTopicSessionWithProfile: async () => {},
    extractPRFromConversation: () => null,
    postSessionDigest: () => {},
    prepareWorkspace: async () => null,
    removeWorkspace: async () => {},
    cleanBuildArtifacts: () => {},
    prepareFanInBranch: async () => null,
    mergeUpstreamBranches: () => false,
    downloadPhotos: async () => [],
    closeChildSessions: async () => {},
    closeSingleChild: async () => {},
    handleTopicFeedback: async () => {},
    handleExecuteCommand: async () => {},
    babysitPR: async () => {},
    babysitDagChildCI: async () => false,
    runDeferredBabysit: async () => {},
    startDag: async () => {},
    scheduleDagNodes: async () => {},
    spawnDagChild: async () => null,
    onDagChildComplete: async () => {},
    updateDagPRDescriptions: async () => {},
    spawnSplitChild: async () => null,
    notifyParentOfChildComplete: async () => {},
    handleShipAdvance: async () => {},
    shipAdvanceToVerification: async () => {},
    findChildCwd: () => undefined,
    findChildSession: () => undefined,

    ...overrides,
  }
}

describe("DispatcherContext", () => {
  it("mock context satisfies the interface shape", () => {
    const ctx = createMockContext()
    expect(ctx.sessions).toBeInstanceOf(Map)
    expect(ctx.topicSessions).toBeInstanceOf(Map)
    expect(ctx.dags).toBeInstanceOf(Map)
    expect(ctx.pendingBabysitPRs).toBeInstanceOf(Map)
    expect(ctx.pendingTasks).toBeInstanceOf(Map)
    expect(ctx.pendingProfiles).toBeInstanceOf(Map)
  })

  it("shared state maps are independent per mock", () => {
    const ctx1 = createMockContext()
    const ctx2 = createMockContext()

    const session: TopicSession = {
      threadId: 1,
      repo: "test",
      cwd: "/tmp/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    ctx1.topicSessions.set(1, session)
    expect(ctx1.topicSessions.size).toBe(1)
    expect(ctx2.topicSessions.size).toBe(0)
  })

  it("methods can be overridden for testing", () => {
    const calls: string[] = []
    const ctx = createMockContext({
      pushToConversation: () => { calls.push("pushToConversation") },
      broadcastSession: () => { calls.push("broadcastSession") },
      persistTopicSessions: async () => { calls.push("persistTopicSessions") },
    })

    const session: TopicSession = {
      threadId: 1,
      repo: "test",
      cwd: "/tmp/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    ctx.pushToConversation(session, { role: "user", text: "hello" })
    ctx.broadcastSession(session, "session_created")

    expect(calls).toEqual(["pushToConversation", "broadcastSession"])
  })

  it("PendingBabysitEntry type works with the map", () => {
    const ctx = createMockContext()
    const entry: PendingBabysitEntry = {
      childSession: {
        threadId: 42,
        repo: "test",
        cwd: "/tmp/test",
        slug: "child-slug",
        conversation: [],
        pendingFeedback: [],
        mode: "task",
        lastActivityAt: Date.now(),
      },
      prUrl: "https://github.com/org/repo/pull/1",
    }

    ctx.pendingBabysitPRs.set(1, [entry])
    expect(ctx.pendingBabysitPRs.get(1)).toHaveLength(1)
    expect(ctx.pendingBabysitPRs.get(1)![0].prUrl).toBe("https://github.com/org/repo/pull/1")
  })

  it("extractPRFromConversation returns null by default", () => {
    const ctx = createMockContext()
    const session: TopicSession = {
      threadId: 1,
      repo: "test",
      cwd: "/tmp/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    expect(ctx.extractPRFromConversation(session)).toBeNull()
  })

  it("async methods return promises", async () => {
    const ctx = createMockContext()
    await expect(ctx.persistTopicSessions()).resolves.toBeUndefined()
    await expect(ctx.spawnTopicAgent({} as TopicSession, "task")).resolves.toBeUndefined()
    await expect(ctx.babysitDagChildCI({} as TopicSession, "url")).resolves.toBe(false)
    await expect(ctx.spawnDagChild({} as TopicSession, {} as any, {} as any, false)).resolves.toBeNull()
  })
})
