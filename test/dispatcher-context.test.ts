import { describe, it, expect } from "vitest"
import type { DispatcherContext, ActiveSession } from "../src/dispatcher-context.js"
import type { TopicSession, TopicMessage, TelegramPhotoSize } from "../src/types.js"
import type { DagGraph } from "../src/dag.js"
import type { McpConfig } from "../src/config-types.js"

/**
 * Build a minimal mock DispatcherContext for testing extracted modules.
 * Each method is a no-op or returns a sensible default; callers can
 * override individual methods via the `overrides` parameter.
 */
function createMockContext(overrides?: Partial<DispatcherContext>): DispatcherContext {
  const sessions = new Map<number, ActiveSession>()
  const topicSessions = new Map<number, TopicSession>()
  const dags = new Map<string, DagGraph>()

  const base: DispatcherContext = {
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
      ci: { babysitEnabled: false, maxRetries: 2, pollIntervalMs: 5000, pollTimeoutMs: 60000, dagCiPolicy: "block" },
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
      observer: { activityThrottleMs: 1000, textFlushDebounceMs: 500, activityEditDebounceMs: 1000 },
      repos: {},
    } as DispatcherContext["config"],
    telegram: {} as DispatcherContext["telegram"],
    observer: {} as DispatcherContext["observer"],
    profileStore: {} as DispatcherContext["profileStore"],
    stats: {} as DispatcherContext["stats"],
    sessions,
    topicSessions,
    dags,
    spawnTopicAgent: async () => {},
    spawnCIFixAgent: async (_ts, _task, onComplete) => { onComplete() },
    closeChildSessions: async () => {},
    closeSingleChild: async () => {},
    pushToConversation: () => {},
    extractPRFromConversation: () => null,
    persistTopicSessions: async () => {},
    prepareWorkspace: async () => "/tmp/test/workspace",
    removeWorkspace: async () => {},
    cleanBuildArtifacts: () => {},
    prepareFanInBranch: async () => "fan-in-branch",
    mergeUpstreamBranches: () => true,
    downloadPhotos: async () => [],
    broadcastSession: () => {},
    broadcastSessionDeleted: () => {},
    broadcastDag: () => {},
    broadcastDagDeleted: () => {},
    updateTopicTitle: async () => {},
    pinThreadMessage: async () => {},
    updatePinnedSummary: () => {},
    updatePinnedSplitStatus: async () => {},
    updatePinnedDagStatus: async () => {},
    handleExecuteCommand: async () => {},
    postSessionDigest: () => {},
    ...overrides,
  }

  return base
}

function createTopicSession(overrides?: Partial<TopicSession>): TopicSession {
  return {
    threadId: 100,
    repo: "test-repo",
    cwd: "/tmp/test/workspace",
    slug: "calm-panda",
    conversation: [],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

describe("DispatcherContext interface", () => {
  it("can be constructed with createMockContext", () => {
    const ctx = createMockContext()
    expect(ctx.config.workspace.maxConcurrentSessions).toBe(5)
    expect(ctx.sessions.size).toBe(0)
    expect(ctx.topicSessions.size).toBe(0)
    expect(ctx.dags.size).toBe(0)
  })

  it("allows overriding individual methods", () => {
    const calls: string[] = []
    const ctx = createMockContext({
      pushToConversation: () => { calls.push("push") },
      broadcastSession: () => { calls.push("broadcast") },
    })

    const session = createTopicSession()
    ctx.pushToConversation(session, { role: "user", text: "hello" })
    ctx.broadcastSession(session, "session_created")

    expect(calls).toEqual(["push", "broadcast"])
  })

  it("shared state maps are mutable through the context", () => {
    const ctx = createMockContext()
    const session = createTopicSession()

    ctx.topicSessions.set(session.threadId, session)
    expect(ctx.topicSessions.get(100)).toBe(session)
    expect(ctx.topicSessions.size).toBe(1)

    ctx.topicSessions.delete(100)
    expect(ctx.topicSessions.size).toBe(0)
  })

  it("spawnCIFixAgent calls onComplete by default", async () => {
    const ctx = createMockContext()
    let completed = false

    await ctx.spawnCIFixAgent(
      createTopicSession(),
      "fix CI",
      () => { completed = true },
    )

    expect(completed).toBe(true)
  })

  it("extractPRFromConversation returns null by default", () => {
    const ctx = createMockContext()
    const result = ctx.extractPRFromConversation(createTopicSession())
    expect(result).toBeNull()
  })

  it("extractPRFromConversation can be overridden to return a URL", () => {
    const ctx = createMockContext({
      extractPRFromConversation: () => "https://github.com/org/repo/pull/42",
    })
    const result = ctx.extractPRFromConversation(createTopicSession())
    expect(result).toBe("https://github.com/org/repo/pull/42")
  })

  it("prepareWorkspace returns a path by default", async () => {
    const ctx = createMockContext()
    const cwd = await ctx.prepareWorkspace("test-slug", "https://github.com/org/repo")
    expect(cwd).toBe("/tmp/test/workspace")
  })

  it("mergeUpstreamBranches returns true by default", () => {
    const ctx = createMockContext()
    expect(ctx.mergeUpstreamBranches("/tmp/cwd", ["branch-a"])).toBe(true)
  })

  it("dags map tracks graphs correctly", () => {
    const ctx = createMockContext()
    const graph: DagGraph = {
      id: "dag-test",
      parentThreadId: 1,
      repo: "test",
      repoUrl: "https://github.com/org/repo",
      nodes: [],
    }

    ctx.dags.set(graph.id, graph)
    expect(ctx.dags.get("dag-test")).toBe(graph)
    expect(ctx.dags.size).toBe(1)
  })

  it("type-checks all lifecycle methods", async () => {
    const ctx = createMockContext()
    const session = createTopicSession()

    await ctx.spawnTopicAgent(session, "do something")
    await ctx.spawnTopicAgent(session, "do something", { browserEnabled: false })
    await ctx.spawnTopicAgent(session, "do something", undefined, "custom prompt")
    await ctx.closeChildSessions(session)
    await ctx.closeSingleChild(session)
    await ctx.persistTopicSessions()
    await ctx.removeWorkspace(session)
    ctx.cleanBuildArtifacts("/tmp/cwd")
    await ctx.handleExecuteCommand(session)
    await ctx.handleExecuteCommand(session, "focus on X")
    ctx.postSessionDigest(session, "https://github.com/org/repo/pull/1")
  })

  it("type-checks all broadcasting methods", () => {
    const ctx = createMockContext()
    const session = createTopicSession()
    const graph: DagGraph = {
      id: "dag-test",
      parentThreadId: 1,
      repo: "test",
      repoUrl: "https://github.com/org/repo",
      nodes: [],
    }

    ctx.broadcastSession(session, "session_created")
    ctx.broadcastSession(session, "session_updated", "completed")
    ctx.broadcastSession(session, "session_updated", "errored")
    ctx.broadcastSessionDeleted("calm-panda")
    ctx.broadcastDag(graph, "dag_created")
    ctx.broadcastDag(graph, "dag_updated")
    ctx.broadcastDagDeleted("dag-test")
  })

  it("type-checks all UI helper methods", async () => {
    const ctx = createMockContext()
    const session = createTopicSession()
    const graph: DagGraph = {
      id: "dag-test",
      parentThreadId: 1,
      repo: "test",
      repoUrl: "https://github.com/org/repo",
      nodes: [],
    }

    await ctx.updateTopicTitle(session, "⚡")
    await ctx.pinThreadMessage(session, "<b>Status</b>")
    ctx.updatePinnedSummary()
    await ctx.updatePinnedSplitStatus(session)
    await ctx.updatePinnedDagStatus(session, graph)
  })
})
