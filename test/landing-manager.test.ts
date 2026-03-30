import { describe, it, expect, vi } from "vitest"
import { LandingManager } from "../src/session/landing-manager.js"
import type { DispatcherContext } from "../src/dispatcher-context.js"
import type { TopicSession } from "../src/types.js"
import type { DagGraph, DagNode, DagInput } from "../src/dag.js"
import type { QualityReport } from "../src/quality-gates.js"

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
    telegram: {
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
    } as any,
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

function makeTopicSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 100,
    repo: "test-repo",
    cwd: "/tmp/test",
    slug: "test-slug",
    conversation: [],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

describe("LandingManager", () => {
  describe("handleLandCommand", () => {
    it("sends warning when no DAG and no children", async () => {
      const ctx = createMockContext()
      const manager = new LandingManager(ctx)
      const session = makeTopicSession()

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No DAG or stack found"),
        100,
      )
    })

    it("sends warning when childThreadIds is empty", async () => {
      const ctx = createMockContext()
      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ childThreadIds: [] })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No DAG or stack found"),
        100,
      )
    })

    it("routes to landChildPRs when no dagId but has children", async () => {
      const ctx = createMockContext()
      const childSession = makeTopicSession({
        threadId: 200,
        slug: "child-slug",
        conversation: [],
      })
      ctx.topicSessions.set(200, childSession)

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ childThreadIds: [200] })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No PRs found"),
        100,
      )
    })

    it("routes to landChildPRs and finds PRs from children", async () => {
      const ctx = createMockContext({
        extractPRFromConversation: (s) => {
          if (s.threadId === 200) return "https://github.com/org/repo/pull/1"
          return null
        },
      })
      const childSession = makeTopicSession({
        threadId: 200,
        slug: "child-slug",
        splitLabel: "Fix auth",
      })
      ctx.topicSessions.set(200, childSession)

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ childThreadIds: [200] })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Landing"),
        100,
      )
    })

    it("routes to landDag when dagId is present", async () => {
      const graph: DagGraph = {
        id: "dag-1",
        nodes: [],
        parentThreadId: 100,
        repo: "test-repo",
      }

      const ctx = createMockContext()
      ctx.dags.set("dag-1", graph)

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ dagId: "dag-1" })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No completed PRs to land"),
        100,
      )
    })
  })

  describe("landDag (via handleLandCommand)", () => {
    it("reports no completed PRs when all nodes are pending", async () => {
      const graph: DagGraph = {
        id: "dag-1",
        nodes: [
          { id: "a", title: "Task A", description: "", status: "pending", dependsOn: [] },
        ],
        parentThreadId: 100,
        repo: "test-repo",
      }

      const ctx = createMockContext()
      ctx.dags.set("dag-1", graph)

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ dagId: "dag-1" })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No completed PRs to land"),
        100,
      )
    })

    it("reports no completed PRs when done nodes have no prUrl", async () => {
      const graph: DagGraph = {
        id: "dag-1",
        nodes: [
          { id: "a", title: "Task A", description: "", status: "done", dependsOn: [] },
        ],
        parentThreadId: 100,
        repo: "test-repo",
      }

      const ctx = createMockContext()
      ctx.dags.set("dag-1", graph)

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ dagId: "dag-1" })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No completed PRs to land"),
        100,
      )
    })
  })

  describe("landChildPRs (via handleLandCommand)", () => {
    it("reports no PRs when children have no conversation PRs", async () => {
      const ctx = createMockContext()
      const child = makeTopicSession({ threadId: 201, slug: "child-1" })
      ctx.topicSessions.set(201, child)

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ childThreadIds: [201] })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No PRs found among child sessions"),
        100,
      )
    })

    it("uses splitLabel as title when available", async () => {
      const ctx = createMockContext({
        extractPRFromConversation: () => "https://github.com/org/repo/pull/5",
      })
      const child = makeTopicSession({
        threadId: 201,
        slug: "child-1",
        splitLabel: "Auth module",
      })
      ctx.topicSessions.set(201, child)

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ childThreadIds: [201] })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Landing"),
        100,
      )
    })

    it("skips children not found in topicSessions", async () => {
      const ctx = createMockContext()

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ childThreadIds: [999] })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No PRs found"),
        100,
      )
    })
  })
})
