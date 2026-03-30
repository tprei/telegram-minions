import { describe, it, expect, vi, beforeEach } from "vitest"
import { DagOrchestrator } from "../src/dag/dag-orchestrator.js"
import type { DispatcherContext } from "../src/dispatcher-context.js"
import type { TopicSession } from "../src/types.js"
import type { DagGraph, DagNode } from "../src/dag/dag.js"

vi.mock("../src/ci-babysit.js", () => ({
  findPRByBranch: vi.fn(),
}))

vi.mock("../src/sentry.js", () => ({
  captureException: vi.fn(),
}))

vi.mock("../src/slugs.js", () => ({
  generateSlug: vi.fn().mockReturnValue("test-slug"),
}))

import { findPRByBranch } from "../src/ci-babysit.js"

const mockFindPRByBranch = vi.mocked(findPRByBranch)

function makeSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 100,
    repo: "org/repo",
    repoUrl: "https://github.com/org/repo",
    cwd: "/tmp/workspace",
    slug: "parent-slug",
    conversation: [{ role: "user", text: "test task" }],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    childThreadIds: [],
    ...overrides,
  }
}

function makeContext(overrides: Partial<DispatcherContext> = {}): DispatcherContext {
  return {
    config: {
      ci: { babysitEnabled: false, maxRetries: 2, pollIntervalMs: 100, pollTimeoutMs: 1000, dagCiPolicy: "skip" },
      workspace: { maxDagConcurrency: 3, maxConcurrentSessions: 5 },
    } as any,
    telegram: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 200 }),
      deleteForumTopic: vi.fn().mockResolvedValue(undefined),
    } as any,
    observer: {} as any,
    stats: {} as any,
    profileStore: {} as any,
    broadcaster: undefined,
    sessions: new Map(),
    topicSessions: new Map(),
    dags: new Map(),
    spawnTopicAgent: vi.fn().mockResolvedValue(undefined),
    spawnCIFixAgent: vi.fn().mockResolvedValue(undefined),
    prepareWorkspace: vi.fn().mockResolvedValue("/tmp/child-workspace"),
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    cleanBuildArtifacts: vi.fn(),
    prepareFanInBranch: vi.fn().mockResolvedValue(null),
    mergeUpstreamBranches: vi.fn().mockReturnValue(true),
    downloadPhotos: vi.fn().mockResolvedValue([]),
    pushToConversation: vi.fn(),
    extractPRFromConversation: vi.fn().mockReturnValue(null),
    persistTopicSessions: vi.fn().mockResolvedValue(undefined),
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

describe("DagOrchestrator", () => {
  let ctx: DispatcherContext
  let orchestrator: DagOrchestrator

  beforeEach(() => {
    vi.clearAllMocks()
    ctx = makeContext()
    orchestrator = new DagOrchestrator(ctx)
  })

  describe("startDag", () => {
    it("builds DAG and schedules ready nodes", async () => {
      const session = makeSession()
      const items = [
        { id: "a", title: "Task A", description: "Do A", dependsOn: [] },
        { id: "b", title: "Task B", description: "Do B", dependsOn: ["a"] },
      ]

      await orchestrator.startDag(session, items, false)

      expect(ctx.closeChildSessions).toHaveBeenCalledWith(session)
      expect(session.dagId).toBe("dag-parent-slug")
      expect(ctx.dags.size).toBe(1)
      expect(ctx.broadcastDag).toHaveBeenCalledWith(expect.any(Object), "dag_created")
      expect(ctx.telegram.sendMessage).toHaveBeenCalled()
      expect(ctx.persistTopicSessions).toHaveBeenCalled()
    })

    it("sends error message for invalid DAG (cycle)", async () => {
      const session = makeSession()
      const items = [
        { id: "a", title: "A", description: "", dependsOn: ["b"] },
        { id: "b", title: "B", description: "", dependsOn: ["a"] },
      ]

      await orchestrator.startDag(session, items, false)

      const sendMsg = vi.mocked(ctx.telegram.sendMessage)
      expect(sendMsg.mock.calls.some(c => typeof c[0] === "string" && c[0].includes("Invalid DAG"))).toBe(true)
      expect(ctx.dags.size).toBe(0)
    })

    it("sets stack emoji for stack mode", async () => {
      const session = makeSession()
      const items = [
        { id: "a", title: "Task A", description: "Do A", dependsOn: [] },
      ]

      await orchestrator.startDag(session, items, true)

      expect(ctx.updateTopicTitle).toHaveBeenCalledWith(session, "📚")
    })

    it("sets DAG emoji for non-stack mode", async () => {
      const session = makeSession()
      const items = [
        { id: "a", title: "Task A", description: "Do A", dependsOn: [] },
      ]

      await orchestrator.startDag(session, items, false)

      expect(ctx.updateTopicTitle).toHaveBeenCalledWith(session, "🔗")
    })
  })

  describe("scheduleDagNodes", () => {
    function makeGraph(nodes: Partial<DagNode>[]): DagGraph {
      return {
        id: "dag-test",
        parentThreadId: 100,
        repo: "org/repo",
        nodes: nodes.map(n => ({
          id: n.id ?? "node",
          title: n.title ?? "Node",
          description: n.description ?? "",
          dependsOn: n.dependsOn ?? [],
          status: n.status ?? "ready",
          branch: n.branch,
          prUrl: n.prUrl,
          threadId: n.threadId,
          error: n.error,
        })) as DagNode[],
      } as DagGraph
    }

    it("spawns ready nodes", async () => {
      const session = makeSession()
      const graph = makeGraph([
        { id: "a", title: "Task A", status: "ready", dependsOn: [] },
      ])

      await orchestrator.scheduleDagNodes(session, graph, false)

      expect(graph.nodes[0].status).toBe("running")
      expect(ctx.telegram.createForumTopic).toHaveBeenCalled()
    })

    it("respects dag concurrency limits", async () => {
      const session = makeSession()
      ctx = makeContext({
        ...ctx,
        config: {
          ...ctx.config,
          workspace: { ...ctx.config.workspace, maxDagConcurrency: 1 },
        } as any,
      })
      orchestrator = new DagOrchestrator(ctx)

      const graph = makeGraph([
        { id: "a", title: "Task A", status: "running", dependsOn: [] },
        { id: "b", title: "Task B", status: "ready", dependsOn: [] },
      ])

      await orchestrator.scheduleDagNodes(session, graph, false)

      // Node B should remain "ready" since concurrency is exhausted
      // (node A is running, maxDagConcurrency is 1)
      expect(graph.nodes[1].status).toBe("ready")
    })

    it("marks node failed when spawn fails", async () => {
      const session = makeSession()
      ctx = makeContext({
        ...ctx,
        telegram: {
          ...ctx.telegram,
          createForumTopic: vi.fn().mockRejectedValue(new Error("topic creation failed")),
        } as any,
      })
      orchestrator = new DagOrchestrator(ctx)

      const graph = makeGraph([
        { id: "a", title: "Task A", status: "ready", dependsOn: [] },
        { id: "b", title: "Task B", status: "pending", dependsOn: ["a"] },
      ])

      await orchestrator.scheduleDagNodes(session, graph, false)

      expect(graph.nodes[0].status).toBe("failed")
    })
  })

  describe("spawnDagChild", () => {
    function makeGraph(): DagGraph {
      return {
        id: "dag-test",
        parentThreadId: 100,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "Task A", description: "Do A", dependsOn: [], status: "running" },
        ],
      } as DagGraph
    }

    it("creates forum topic and spawns agent", async () => {
      const parent = makeSession()
      const graph = makeGraph()
      const node = graph.nodes[0]

      const threadId = await orchestrator.spawnDagChild(parent, graph, node, false)

      expect(threadId).toBe(200)
      expect(ctx.telegram.createForumTopic).toHaveBeenCalled()
      expect(ctx.prepareWorkspace).toHaveBeenCalled()
      expect(ctx.spawnTopicAgent).toHaveBeenCalled()
      expect(ctx.topicSessions.has(200)).toBe(true)

      const childSession = ctx.topicSessions.get(200)!
      expect(childSession.dagId).toBe("dag-test")
      expect(childSession.dagNodeId).toBe("a")
      expect(childSession.mode).toBe("task")
    })

    it("returns null when topic creation fails", async () => {
      const parent = makeSession()
      const graph = makeGraph()
      const node = graph.nodes[0]

      vi.mocked(ctx.telegram.createForumTopic).mockRejectedValue(new Error("failed"))

      const threadId = await orchestrator.spawnDagChild(parent, graph, node, false)
      expect(threadId).toBeNull()
    })

    it("returns null when workspace preparation fails", async () => {
      const parent = makeSession()
      const graph = makeGraph()
      const node = graph.nodes[0]

      vi.mocked(ctx.prepareWorkspace).mockResolvedValue(null)

      const threadId = await orchestrator.spawnDagChild(parent, graph, node, false)
      expect(threadId).toBeNull()
      expect(ctx.telegram.deleteForumTopic).toHaveBeenCalledWith(200)
    })

    it("handles fan-in with multiple upstream branches", async () => {
      const parent = makeSession()
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: 100,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "A", description: "", dependsOn: [], status: "done", branch: "minion/a", prUrl: "https://github.com/org/repo/pull/1" },
          { id: "b", title: "B", description: "", dependsOn: [], status: "done", branch: "minion/b", prUrl: "https://github.com/org/repo/pull/2" },
          { id: "c", title: "C", description: "", dependsOn: ["a", "b"], status: "running" },
        ],
      } as DagGraph

      vi.mocked(ctx.prepareFanInBranch).mockResolvedValue("fan-in-branch")

      await orchestrator.spawnDagChild(parent, graph, graph.nodes[2], false)

      expect(ctx.prepareFanInBranch).toHaveBeenCalled()
      expect(ctx.mergeUpstreamBranches).toHaveBeenCalled()
    })

    it("returns null when fan-in merge fails", async () => {
      const parent = makeSession()
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: 100,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "A", description: "", dependsOn: [], status: "done", branch: "minion/a", prUrl: "https://github.com/org/repo/pull/1" },
          { id: "b", title: "B", description: "", dependsOn: [], status: "done", branch: "minion/b", prUrl: "https://github.com/org/repo/pull/2" },
          { id: "c", title: "C", description: "", dependsOn: ["a", "b"], status: "running" },
        ],
      } as DagGraph

      vi.mocked(ctx.prepareFanInBranch).mockResolvedValue(null)

      const threadId = await orchestrator.spawnDagChild(parent, graph, graph.nodes[2], false)
      expect(threadId).toBeNull()
    })
  })

  describe("onDagChildComplete", () => {
    function setupDag(): { parent: TopicSession; child: TopicSession; graph: DagGraph } {
      const parent = makeSession({ threadId: 100 })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: 100,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "Task A", description: "", dependsOn: [], status: "running", branch: "minion/child-slug" },
          { id: "b", title: "Task B", description: "", dependsOn: ["a"], status: "pending" },
        ],
      } as DagGraph

      ctx.dags.set("dag-test", graph)
      ctx.topicSessions.set(100, parent)

      const child = makeSession({
        threadId: 200,
        slug: "child-slug",
        dagId: "dag-test",
        dagNodeId: "a",
        parentThreadId: 100,
        conversation: [{ role: "assistant", text: "Opened PR https://github.com/org/repo/pull/42" }],
      })
      ctx.topicSessions.set(200, child)

      return { parent, child, graph }
    }

    it("handles errored state by failing node and cascading", async () => {
      const { child, graph } = setupDag()

      await orchestrator.onDagChildComplete(child, "errored")

      expect(graph.nodes[0].status).toBe("failed")
      expect(graph.nodes[0].error).toBe("Session errored")
      expect(graph.nodes[1].status).toBe("skipped")
      expect(ctx.persistTopicSessions).toHaveBeenCalled()
    })

    it("marks node done and advances dependents on success with PR", async () => {
      const { child, graph } = setupDag()
      vi.mocked(ctx.extractPRFromConversation).mockReturnValue("https://github.com/org/repo/pull/42")

      await orchestrator.onDagChildComplete(child, "completed")

      expect(graph.nodes[0].status).toBe("done")
      expect(graph.nodes[0].prUrl).toBe("https://github.com/org/repo/pull/42")
      expect(ctx.broadcastDag).toHaveBeenCalledWith(graph, "dag_updated")
      expect(ctx.updatePinnedDagStatus).toHaveBeenCalled()
    })

    it("attempts recovery when completed without PR", async () => {
      const { child, graph } = setupDag()
      vi.mocked(ctx.extractPRFromConversation).mockReturnValue(null)
      mockFindPRByBranch.mockResolvedValue(null)

      await orchestrator.onDagChildComplete(child, "completed")

      expect(graph.nodes[0].recoveryAttempted).toBe(true)
      expect(ctx.spawnTopicAgent).toHaveBeenCalled()
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("recovery session"),
        100,
      )
    })

    it("fails node after recovery attempt still has no PR", async () => {
      const { child, graph } = setupDag()
      graph.nodes[0].recoveryAttempted = true
      vi.mocked(ctx.extractPRFromConversation).mockReturnValue(null)
      mockFindPRByBranch.mockResolvedValue(null)

      await orchestrator.onDagChildComplete(child, "completed")

      expect(graph.nodes[0].status).toBe("failed")
      expect(graph.nodes[0].error).toBe("Completed without opening a PR")
    })

    it("finds PR via branch when not in conversation", async () => {
      const { child, graph } = setupDag()
      vi.mocked(ctx.extractPRFromConversation).mockReturnValue(null)
      mockFindPRByBranch.mockResolvedValue("https://github.com/org/repo/pull/99")

      await orchestrator.onDagChildComplete(child, "completed")

      expect(graph.nodes[0].prUrl).toBe("https://github.com/org/repo/pull/99")
      expect(graph.nodes[0].status).toBe("done")
    })

    it("runs inline CI gate when policy is block", async () => {
      ctx = makeContext({
        ...ctx,
        config: {
          ...ctx.config,
          ci: { ...ctx.config.ci, babysitEnabled: true, dagCiPolicy: "block" },
        } as any,
      })
      orchestrator = new DagOrchestrator(ctx)
      const { parent, child, graph } = setupCompleteDag(ctx)

      vi.mocked(ctx.extractPRFromConversation).mockReturnValue("https://github.com/org/repo/pull/42")
      vi.mocked(ctx.babysitDagChildCI).mockResolvedValue(true)

      await orchestrator.onDagChildComplete(child, "completed")

      expect(ctx.babysitDagChildCI).toHaveBeenCalled()
      expect(graph.nodes[0].status).toBe("done")
    })

    it("marks ci-failed when CI fails with block policy", async () => {
      ctx = makeContext({
        ...ctx,
        config: {
          ...ctx.config,
          ci: { ...ctx.config.ci, babysitEnabled: true, dagCiPolicy: "block" },
        } as any,
      })
      orchestrator = new DagOrchestrator(ctx)
      const { child, graph } = setupCompleteDag(ctx)

      vi.mocked(ctx.extractPRFromConversation).mockReturnValue("https://github.com/org/repo/pull/42")
      vi.mocked(ctx.babysitDagChildCI).mockResolvedValue(false)

      await orchestrator.onDagChildComplete(child, "completed")

      expect(graph.nodes[0].status).toBe("ci-failed")
      expect(graph.nodes[0].error).toBe("CI checks failed")
    })

    it("advances anyway when CI fails with warn policy", async () => {
      ctx = makeContext({
        ...ctx,
        config: {
          ...ctx.config,
          ci: { ...ctx.config.ci, babysitEnabled: true, dagCiPolicy: "warn" },
        } as any,
      })
      orchestrator = new DagOrchestrator(ctx)
      const { child, graph } = setupCompleteDag(ctx)

      vi.mocked(ctx.extractPRFromConversation).mockReturnValue("https://github.com/org/repo/pull/42")
      vi.mocked(ctx.babysitDagChildCI).mockResolvedValue(false)

      await orchestrator.onDagChildComplete(child, "completed")

      expect(graph.nodes[0].status).toBe("done")
    })

    it("closes children and updates title when DAG fully complete", async () => {
      const { child, graph } = setupDag()
      // Only one node, no dependents — make it complete
      graph.nodes = [graph.nodes[0]]
      vi.mocked(ctx.extractPRFromConversation).mockReturnValue("https://github.com/org/repo/pull/42")

      await orchestrator.onDagChildComplete(child, "completed")

      expect(ctx.updateTopicTitle).toHaveBeenCalledWith(expect.any(Object), "✅")
      expect(ctx.closeChildSessions).toHaveBeenCalled()
    })

    it("advances ship pipeline when DAG complete in ship mode", async () => {
      const { parent, child, graph } = setupDag()
      graph.nodes = [graph.nodes[0]]
      parent.autoAdvance = { phase: "dag", featureDescription: "test feature" }
      vi.mocked(ctx.extractPRFromConversation).mockReturnValue("https://github.com/org/repo/pull/42")

      await orchestrator.onDagChildComplete(child, "completed")

      expect(ctx.shipAdvanceToVerification).toHaveBeenCalledWith(parent, graph)
    })

    it("halts ship pipeline when DAG has failures", async () => {
      const { parent, child, graph } = setupDag()
      graph.nodes = [graph.nodes[0]]
      graph.nodes[0].status = "failed"
      parent.autoAdvance = { phase: "dag", featureDescription: "test feature" }

      await orchestrator.onDagChildComplete(child, "errored")

      expect(parent.autoAdvance.phase).toBe("done")
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Ship pipeline halted"),
        parent.threadId,
      )
    })

    it("ignores sessions with no dagId", async () => {
      const child = makeSession({ dagId: undefined, dagNodeId: undefined })

      await orchestrator.onDagChildComplete(child, "completed")

      expect(ctx.telegram.sendMessage).not.toHaveBeenCalled()
    })

    it("clears child conversation to free memory", async () => {
      const { child } = setupDag()
      vi.mocked(ctx.extractPRFromConversation).mockReturnValue("https://github.com/org/repo/pull/42")

      await orchestrator.onDagChildComplete(child, "completed")

      expect(child.conversation).toEqual([])
    })
  })

  describe("handleRetryCommand", () => {
    it("reports error when not in DAG thread", async () => {
      const session = makeSession({ dagId: undefined })

      await orchestrator.handleRetryCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("/retry only works"),
        session.threadId,
      )
    })

    it("reports when no failed nodes", async () => {
      const session = makeSession({ dagId: "dag-test" })
      ctx.dags.set("dag-test", {
        id: "dag-test",
        parentThreadId: 100,
        nodes: [{ id: "a", title: "A", status: "done", dependsOn: [] }],
      } as DagGraph)

      await orchestrator.handleRetryCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        "No failed nodes to retry.",
        session.threadId,
      )
    })

    it("retries failed nodes with existing child session", async () => {
      const session = makeSession({ dagId: "dag-test" })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: 100,
        nodes: [{ id: "a", title: "Task A", description: "", status: "failed", dependsOn: [], error: "Session errored" }],
      } as DagGraph
      ctx.dags.set("dag-test", graph)

      const childSession = makeSession({
        threadId: 200,
        dagId: "dag-test",
        dagNodeId: "a",
      })
      ctx.topicSessions.set(200, childSession)

      await orchestrator.handleRetryCommand(session)

      expect(graph.nodes[0].status).toBe("running")
      expect(ctx.spawnTopicAgent).toHaveBeenCalled()
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Retrying"),
        session.threadId,
      )
    })

    it("retries specific node by ID", async () => {
      const session = makeSession({ dagId: "dag-test" })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: 100,
        nodes: [
          { id: "a", title: "Task A", status: "failed", dependsOn: [] },
          { id: "b", title: "Task B", status: "failed", dependsOn: [] },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)

      const childA = makeSession({ threadId: 201, dagId: "dag-test", dagNodeId: "a" })
      ctx.topicSessions.set(201, childA)

      await orchestrator.handleRetryCommand(session, "a")

      expect(graph.nodes[0].status).toBe("running")
      expect(graph.nodes[1].status).toBe("failed")
    })
  })

  describe("handleForceCommand", () => {
    it("reports error when not in DAG thread", async () => {
      const session = makeSession({ dagId: undefined })

      await orchestrator.handleForceCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("/force only works"),
        session.threadId,
      )
    })

    it("reports when no CI-failed nodes", async () => {
      const session = makeSession({ dagId: "dag-test" })
      ctx.dags.set("dag-test", {
        id: "dag-test",
        parentThreadId: 100,
        nodes: [{ id: "a", title: "A", status: "done", dependsOn: [] }],
      } as DagGraph)

      await orchestrator.handleForceCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        "No CI-failed nodes to force-advance.",
        session.threadId,
      )
    })

    it("force-advances CI-failed nodes", async () => {
      const session = makeSession({ dagId: "dag-test" })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: 100,
        nodes: [
          { id: "a", title: "Task A", status: "ci-failed", dependsOn: [], error: "CI checks failed" },
          { id: "b", title: "Task B", status: "pending", dependsOn: ["a"] },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)

      await orchestrator.handleForceCommand(session)

      expect(graph.nodes[0].status).toBe("done")
      expect(graph.nodes[0].error).toBeUndefined()
      expect(ctx.broadcastDag).toHaveBeenCalledWith(graph, "dag_updated")
      expect(ctx.persistTopicSessions).toHaveBeenCalled()
    })
  })
})

function setupCompleteDag(ctx: DispatcherContext) {
  const parent = makeSession({ threadId: 100 })
  const graph: DagGraph = {
    id: "dag-test",
    parentThreadId: 100,
    repo: "org/repo",
    nodes: [
      { id: "a", title: "Task A", description: "", dependsOn: [], status: "running", branch: "minion/child-slug" },
      { id: "b", title: "Task B", description: "", dependsOn: ["a"], status: "pending" },
    ],
  } as DagGraph

  ctx.dags.set("dag-test", graph)
  ctx.topicSessions.set(100, parent)

  const child = makeSession({
    threadId: 200,
    slug: "child-slug",
    dagId: "dag-test",
    dagNodeId: "a",
    parentThreadId: 100,
  })
  ctx.topicSessions.set(200, child)

  return { parent, child, graph }
}
