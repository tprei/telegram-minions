import { describe, it, expect } from "vitest"
import type { DispatcherContext } from "../src/dispatcher-context.js"
import type { TopicSession, TopicMessage, AutoAdvance } from "../src/types.js"
import type { DagGraph, DagNode, DagInput } from "../src/dag/dag.js"
import type { QualityReport } from "../src/quality-gates.js"

/**
 * Build a minimal mock DispatcherContext for testing extracted modules.
 * Each method is a no-op or returns a sensible default.
 */
function createMockContext(overrides: Partial<DispatcherContext> = {}): DispatcherContext {
  const sessions = new Map()
  const topicSessions = new Map()
  const dags = new Map()

  return {
    config: {
      telegram: { botToken: "test", chatId: "123", allowedUserIds: [1] },
      telegramQueue: { minSendIntervalMs: 0 },
      goose: { provider: "test", model: "test" },
      claude: { planModel: "test", thinkModel: "test", reviewModel: "test" },
      workspace: {
        root: "/tmp/test",
        maxConcurrentSessions: 5,
        maxDagConcurrency: 3,
        maxSplitItems: 10,
        sessionTokenBudget: 100000,
        sessionBudgetUsd: 10,
        sessionTimeoutMs: 300000,
        sessionInactivityTimeoutMs: 60000,
        staleTtlMs: 86400000,
        cleanupIntervalMs: 3600000,
        maxConversationLength: 50,
      },
      ci: {
        babysitEnabled: false,
        maxRetries: 2,
        pollIntervalMs: 5000,
        pollTimeoutMs: 300000,
        dagCiPolicy: "skip",
      },
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
      observer: { activityThrottleMs: 0, textFlushDebounceMs: 0, activityEditDebounceMs: 0 },
      repos: {},
    } as any,
    telegram: {} as any,
    observer: {} as any,
    stats: {} as any,
    profileStore: {} as any,
    broadcaster: undefined,
    sessions,
    topicSessions,
    dags,
    spawnTopicAgent: async () => {},
    spawnCIFixAgent: async () => {},
    prepareWorkspace: async () => "/tmp/test/workspace",
    removeWorkspace: async () => {},
    cleanBuildArtifacts: () => {},
    prepareFanInBranch: async () => null,
    mergeUpstreamBranches: () => true,
    downloadPhotos: async () => [],
    pushToConversation: () => {},
    extractPRFromConversation: () => null,
    persistTopicSessions: async () => {},
    updatePinnedSummary: () => {},
    updateTopicTitle: async () => {},
    pinThreadMessage: async () => {},
    updatePinnedSplitStatus: async () => {},
    updatePinnedDagStatus: async () => {},
    broadcastSession: () => {},
    broadcastSessionDeleted: () => {},
    broadcastDag: () => {},
    broadcastDagDeleted: () => {},
    closeChildSessions: async () => {},
    closeSingleChild: async () => {},
    startDag: async () => {},
    shipAdvanceToVerification: async () => {},
    handleExecuteCommand: async () => {},
    notifyParentOfChildComplete: async () => {},
    postSessionDigest: () => {},
    runDeferredBabysit: async () => {},
    babysitPR: async () => {},
    babysitDagChildCI: async () => true,
    updateDagPRDescriptions: async () => {},
    scheduleDagNodes: async () => {},
    spawnSplitChild: async () => null,
    spawnDagChild: async () => null,
    ...overrides,
  }
}

describe("DispatcherContext", () => {
  it("can be constructed with createMockContext", () => {
    const ctx = createMockContext()
    expect(ctx.config).toBeDefined()
    expect(ctx.sessions).toBeInstanceOf(Map)
    expect(ctx.topicSessions).toBeInstanceOf(Map)
    expect(ctx.dags).toBeInstanceOf(Map)
  })

  it("exposes shared mutable state by reference", () => {
    const ctx = createMockContext()

    const session: TopicSession = {
      threadId: 1,
      repo: "test",
      cwd: "/tmp",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    ctx.topicSessions.set(1, session)
    expect(ctx.topicSessions.get(1)).toBe(session)
    expect(ctx.topicSessions.size).toBe(1)
  })

  it("allows overriding specific methods", () => {
    let called = false
    const ctx = createMockContext({
      pushToConversation: (session, msg) => {
        called = true
        session.conversation.push(msg)
      },
    })

    const session: TopicSession = {
      threadId: 1,
      repo: "test",
      cwd: "/tmp",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    ctx.pushToConversation(session, { role: "user", text: "hello" })
    expect(called).toBe(true)
    expect(session.conversation).toHaveLength(1)
    expect(session.conversation[0].text).toBe("hello")
  })

  it("workspace methods return sensible defaults", async () => {
    const ctx = createMockContext()
    const cwd = await ctx.prepareWorkspace("slug-1", "https://github.com/org/repo")
    expect(cwd).toBe("/tmp/test/workspace")

    await expect(ctx.removeWorkspace({} as TopicSession)).resolves.toBeUndefined()
    expect(ctx.mergeUpstreamBranches("/tmp", ["branch-1"])).toBe(true)
  })

  it("extractPRFromConversation returns null by default", () => {
    const ctx = createMockContext()
    const result = ctx.extractPRFromConversation({} as TopicSession)
    expect(result).toBeNull()
  })

  it("cross-module callbacks are callable", async () => {
    let dagStarted = false
    let verificationStarted = false

    const ctx = createMockContext({
      startDag: async () => { dagStarted = true },
      shipAdvanceToVerification: async () => { verificationStarted = true },
    })

    await ctx.startDag({} as TopicSession, [], false)
    expect(dagStarted).toBe(true)

    await ctx.shipAdvanceToVerification({} as TopicSession, {} as DagGraph)
    expect(verificationStarted).toBe(true)
  })

  it("babysitDagChildCI returns true by default", async () => {
    const ctx = createMockContext()
    const result = await ctx.babysitDagChildCI({} as TopicSession, "https://github.com/org/repo/pull/1")
    expect(result).toBe(true)
  })

  it("spawnSplitChild and spawnDagChild return null by default", async () => {
    const ctx = createMockContext()
    expect(await ctx.spawnSplitChild({} as TopicSession, { title: "t", description: "d" }, [])).toBeNull()
    expect(await ctx.spawnDagChild({} as TopicSession, {} as DagGraph, {} as DagNode, false)).toBeNull()
  })
})
