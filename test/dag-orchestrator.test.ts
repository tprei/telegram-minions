import { describe, it, expect, vi, beforeEach } from "vitest"
import { DagOrchestrator } from "../src/dag/dag-orchestrator.js"
import type { DispatcherContext } from "../src/orchestration/dispatcher-context.js"
import type { TopicSession } from "../src/domain/session-types.js"
import type { DagGraph, DagNode } from "../src/dag/dag.js"
import { createMockContext, makeMockConfig, makeMockTelegram } from "./test-helpers.js"

vi.mock("../src/ci/ci-babysit.js", () => ({
  findPRByBranch: vi.fn(),
}))

vi.mock("../src/sentry.js", () => ({
  captureException: vi.fn(),
}))

vi.mock("../src/slugs.js", () => ({
  generateSlug: vi.fn().mockReturnValue("test-slug"),
}))

import { findPRByBranch } from "../src/ci/ci-babysit.js"

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
  return createMockContext({
    config: makeMockConfig({
      telegram: { botToken: "test", chatId: "-1001234567890", allowedUserIds: [1] },
      ci: { babysitEnabled: false, maxRetries: 2, pollIntervalMs: 100, pollTimeoutMs: 1000, dagCiPolicy: "skip" },
    }),
    telegram: makeMockTelegram({
      createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 200 }),
    }),
    ...overrides,
  })
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
        config: { ...ctx.config, workspace: { ...ctx.config.workspace, maxDagConcurrency: 1 } },
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
        telegram: makeMockTelegram({
          createForumTopic: vi.fn().mockRejectedValue(new Error("topic creation failed")),
        }),
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

    it("sends starting message with clickable topic link", async () => {
      const parent = makeSession()
      const graph = makeGraph()
      const node = graph.nodes[0]

      await orchestrator.spawnDagChild(parent, graph, node, false)

      const sendMsg = vi.mocked(ctx.telegram.sendMessage)
      const startingCall = sendMsg.mock.calls.find(
        c => typeof c[0] === "string" && c[0].includes("Starting"),
      )
      expect(startingCall).toBeDefined()
      expect(startingCall![0]).toContain("https://t.me/c/1234567890/200")
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

    it("returns null when fan-in pre-flight fails (fetch error)", async () => {
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

    it("proceeds with conflict files when merge has conflicts", async () => {
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

      vi.mocked(ctx.prepareFanInBranch).mockResolvedValue("minion/a")
      vi.mocked(ctx.mergeUpstreamBranches).mockReturnValue({ ok: false, conflictFiles: ["test/format.test.ts"] })

      const threadId = await orchestrator.spawnDagChild(parent, graph, graph.nodes[2], false)
      expect(threadId).toBe(200)
      expect(ctx.spawnTopicAgent).toHaveBeenCalled()
      const taskPrompt = vi.mocked(ctx.spawnTopicAgent).mock.calls[0][1]
      expect(taskPrompt).toContain("Merge conflicts to resolve first")
      expect(taskPrompt).toContain("test/format.test.ts")
    })

    it("returns null when merge fails with non-conflict error", async () => {
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

      vi.mocked(ctx.prepareFanInBranch).mockResolvedValue("minion/a")
      vi.mocked(ctx.mergeUpstreamBranches).mockReturnValue({ ok: false, conflictFiles: [] })

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

    it("marks node failed when recovery spawn is rejected", async () => {
      ctx = makeContext({
        ...ctx,
        spawnTopicAgent: vi.fn().mockResolvedValue(false),
      })
      orchestrator = new DagOrchestrator(ctx)
      const { parent, child, graph } = setupDag()
      ctx.dags.set("dag-test", graph)
      ctx.topicSessions.set(100, parent)
      ctx.topicSessions.set(200, child)

      vi.mocked(ctx.extractPRFromConversation).mockReturnValue(null)
      mockFindPRByBranch.mockResolvedValue(null)

      await orchestrator.onDagChildComplete(child, "completed")

      expect(graph.nodes[0].recoveryAttempted).toBe(true)
      expect(graph.nodes[0].status).toBe("failed")
      expect(graph.nodes[0].error).toBe("Recovery blocked: max sessions reached")
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Recovery for"),
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
        config: { ...ctx.config, ci: { ...ctx.config.ci, babysitEnabled: true, dagCiPolicy: "block" as const } },
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
        config: { ...ctx.config, ci: { ...ctx.config.ci, babysitEnabled: true, dagCiPolicy: "block" as const } },
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
        config: { ...ctx.config, ci: { ...ctx.config.ci, babysitEnabled: true, dagCiPolicy: "warn" as const } },
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

      expect(parent.autoAdvance.phase).toBe("dag")
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Ship pipeline halted"),
        parent.threadId,
      )
    })

    it("advances to verification after retry succeeds on previously failed DAG", async () => {
      const { parent, child, graph } = setupDag()
      graph.nodes = [graph.nodes[0]]
      graph.nodes[0].status = "failed"
      parent.autoAdvance = { phase: "dag", featureDescription: "test feature" }

      await orchestrator.onDagChildComplete(child, "errored")

      expect(parent.autoAdvance.phase).toBe("dag")
      expect(ctx.shipAdvanceToVerification).not.toHaveBeenCalled()

      graph.nodes[0].status = "running"
      vi.mocked(ctx.extractPRFromConversation).mockReturnValue("https://github.com/org/repo/pull/42")
      vi.mocked(ctx.telegram.sendMessage).mockClear()

      await orchestrator.onDagChildComplete(child, "completed")

      expect(ctx.shipAdvanceToVerification).toHaveBeenCalledWith(parent, graph)
    })

    it("ignores sessions with no dagId", async () => {
      const child = makeSession({ dagId: undefined, dagNodeId: undefined })

      await orchestrator.onDagChildComplete(child, "completed")

      expect(ctx.telegram.sendMessage).not.toHaveBeenCalled()
    })

    it("sends completion message with clickable topic link", async () => {
      const { child, graph } = setupDag()
      vi.mocked(ctx.extractPRFromConversation).mockReturnValue("https://github.com/org/repo/pull/42")

      await orchestrator.onDagChildComplete(child, "completed")

      const sendMsg = vi.mocked(ctx.telegram.sendMessage)
      const completeCall = sendMsg.mock.calls.find(
        c => typeof c[0] === "string" && c[0].includes("child-slug") && c[0].includes("complete"),
      )
      expect(completeCall).toBeDefined()
      expect(completeCall![0]).toContain("https://t.me/c/1234567890/200")
    })

    it("clears child conversation to free memory", async () => {
      const { child } = setupDag()
      vi.mocked(ctx.extractPRFromConversation).mockReturnValue("https://github.com/org/repo/pull/42")

      await orchestrator.onDagChildComplete(child, "completed")

      expect(child.conversation).toEqual([])
    })

    it("schedules concurrency-blocked ready node on next completion", async () => {
      ctx = makeContext({
        ...ctx,
        config: makeMockConfig({
          ...ctx.config,
          workspace: { ...ctx.config.workspace, maxDagConcurrency: 2 },
        }),
      })
      orchestrator = new DagOrchestrator(ctx)
      const scheduleSpy = vi.spyOn(orchestrator, "scheduleDagNodes").mockResolvedValue(undefined)

      const parent = makeSession({ threadId: 100 })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: 100,
        repo: "org/repo",
        nodes: [
          { id: "root", title: "Root", description: "", dependsOn: [], status: "done", branch: "minion/root", prUrl: "https://github.com/org/repo/pull/1" },
          { id: "a", title: "A", description: "", dependsOn: ["root"], status: "running", branch: "minion/a" },
          { id: "b", title: "B", description: "", dependsOn: ["root"], status: "running", branch: "minion/b" },
          { id: "c", title: "C", description: "", dependsOn: ["root"], status: "ready" },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)
      ctx.topicSessions.set(100, parent)

      const childA = makeSession({
        threadId: 201,
        slug: "child-a",
        dagId: "dag-test",
        dagNodeId: "a",
        parentThreadId: 100,
        conversation: [{ role: "assistant", text: "PR https://github.com/org/repo/pull/2" }],
      })
      ctx.topicSessions.set(201, childA)

      vi.mocked(ctx.extractPRFromConversation).mockReturnValue("https://github.com/org/repo/pull/2")

      await orchestrator.onDagChildComplete(childA, "completed")

      expect(scheduleSpy).toHaveBeenCalledWith(parent, graph, true)
    })

    it("schedules independent ready nodes after a failed completion", async () => {
      const scheduleSpy = vi.spyOn(orchestrator, "scheduleDagNodes").mockResolvedValue(undefined)

      const parent = makeSession({ threadId: 100 })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: 100,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "A", description: "", dependsOn: [], status: "running", branch: "minion/a" },
          { id: "b", title: "B", description: "", dependsOn: [], status: "ready" },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)
      ctx.topicSessions.set(100, parent)

      const childA = makeSession({
        threadId: 201,
        slug: "child-a",
        dagId: "dag-test",
        dagNodeId: "a",
        parentThreadId: 100,
      })
      ctx.topicSessions.set(201, childA)

      await orchestrator.onDagChildComplete(childA, "errored")

      expect(graph.nodes[0].status).toBe("failed")
      expect(scheduleSpy).toHaveBeenCalledWith(parent, graph, false)
    })
  })

  describe("handleRetryCommand", () => {
    it("reports error when not in DAG or ship thread", async () => {
      const session = makeSession({ dagId: undefined })

      await orchestrator.handleRetryCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("/retry requires a ship pipeline or DAG parent thread"),
        session.threadId,
      )
    })

    it("retries ship think phase by re-spawning agent", async () => {
      const session = makeSession({
        dagId: undefined,
        mode: "ship-think",
        autoAdvance: { phase: "think", featureDescription: "build a widget", autoLand: false },
        conversation: [{ role: "user", text: "build a widget" }],
      })

      await orchestrator.handleRetryCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Retrying ship <b>think</b> phase"),
        session.threadId,
      )
      expect(ctx.spawnTopicAgent).toHaveBeenCalledWith(session, "build a widget")
    })

    it("retries ship plan phase by re-spawning agent", async () => {
      const session = makeSession({
        dagId: undefined,
        mode: "ship-plan",
        autoAdvance: { phase: "plan", featureDescription: "build a widget", autoLand: false },
        conversation: [
          { role: "user", text: "build a widget" },
          { role: "assistant", text: "research findings" },
          { role: "user", text: "plan the implementation" },
        ],
      })

      await orchestrator.handleRetryCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Retrying ship <b>plan</b> phase"),
        session.threadId,
      )
      expect(ctx.spawnTopicAgent).toHaveBeenCalledWith(session, "plan the implementation")
    })

    it("retries ship dag phase by calling shipAdvanceToDag", async () => {
      const session = makeSession({
        dagId: undefined,
        mode: "ship-plan",
        autoAdvance: { phase: "dag", featureDescription: "build a widget", autoLand: false },
      })

      await orchestrator.handleRetryCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Retrying DAG extraction"),
        session.threadId,
      )
      expect(ctx.shipAdvanceToDag).toHaveBeenCalledWith(session)
    })

    it("falls back to featureDescription when no user message in conversation", async () => {
      const session = makeSession({
        dagId: undefined,
        mode: "ship-think",
        autoAdvance: { phase: "think", featureDescription: "build a widget", autoLand: false },
        conversation: [],
      })

      await orchestrator.handleRetryCommand(session)

      expect(ctx.spawnTopicAgent).toHaveBeenCalledWith(session, "build a widget")
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

    it("respects concurrency limits when retrying", async () => {
      const session = makeSession({ dagId: "dag-test" })
      ctx = makeContext({
        ...ctx,
        config: { ...ctx.config, workspace: { ...ctx.config.workspace, maxDagConcurrency: 1 } },
      })
      orchestrator = new DagOrchestrator(ctx)

      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: 100,
        nodes: [
          { id: "a", title: "Task A", status: "running", dependsOn: [] },
          { id: "b", title: "Task B", status: "failed", dependsOn: [], error: "Session errored" },
          { id: "c", title: "Task C", status: "failed", dependsOn: [], error: "Session errored" },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)

      const childB = makeSession({ threadId: 201, dagId: "dag-test", dagNodeId: "b" })
      const childC = makeSession({ threadId: 202, dagId: "dag-test", dagNodeId: "c" })
      ctx.topicSessions.set(201, childB)
      ctx.topicSessions.set(202, childC)

      await orchestrator.handleRetryCommand(session)

      expect(ctx.spawnTopicAgent).not.toHaveBeenCalled()
      expect(graph.nodes[1].status).toBe("ready")
      expect(graph.nodes[2].status).toBe("ready")
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("deferred"),
        session.threadId,
      )
    })

    it("reverts node to ready when spawn returns false", async () => {
      const session = makeSession({ dagId: "dag-test" })
      ctx = makeContext({
        ...ctx,
        spawnTopicAgent: vi.fn().mockResolvedValue(false),
      })
      orchestrator = new DagOrchestrator(ctx)

      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: 100,
        nodes: [
          { id: "a", title: "Task A", status: "failed", dependsOn: [], error: "Session errored" },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)

      const childA = makeSession({ threadId: 201, dagId: "dag-test", dagNodeId: "a" })
      ctx.topicSessions.set(201, childA)

      await orchestrator.handleRetryCommand(session)

      expect(graph.nodes[0].status).toBe("ready")
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("deferred"),
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

describe("DagOrchestrator — DAG review", () => {
  let ctx: DispatcherContext
  let orchestrator: DagOrchestrator

  beforeEach(() => {
    vi.clearAllMocks()
    ctx = makeContext()
    orchestrator = new DagOrchestrator(ctx)
  })

  describe("handleReviewCommand", () => {
    it("rejects when no DAG is active", async () => {
      const session = makeSession({ dagId: undefined })
      await orchestrator.handleReviewCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("requires an active DAG"),
        session.threadId,
      )
    })

    it("rejects when DAG is not found", async () => {
      const session = makeSession({ dagId: "dag-missing" })
      await orchestrator.handleReviewCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("DAG not found"),
        session.threadId,
      )
    })

    it("reports when no PRs are available to review", async () => {
      const session = makeSession({ dagId: "dag-test" })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: session.threadId,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "Task A", description: "", dependsOn: [], status: "running" },
          { id: "b", title: "Task B", description: "", dependsOn: ["a"], status: "pending" },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)

      await orchestrator.handleReviewCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No PRs available to review"),
        session.threadId,
      )
    })

    it("includes running/pending counts in the no-PRs message", async () => {
      const session = makeSession({ dagId: "dag-test" })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: session.threadId,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "Task A", description: "", dependsOn: [], status: "running" },
          { id: "b", title: "Task B", description: "", dependsOn: ["a"], status: "pending" },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)

      await orchestrator.handleReviewCommand(session)

      const msg = vi.mocked(ctx.telegram.sendMessage).mock.calls[0][0]
      expect(msg).toContain("1 node(s) still running")
      expect(msg).toContain("1 node(s) pending")
    })

    it("spawns review children for done nodes with PRs", async () => {
      const session = makeSession({ dagId: "dag-test", childThreadIds: [] })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: session.threadId,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "Task A", description: "Build A", dependsOn: [], status: "done", prUrl: "https://github.com/org/repo/pull/1", branch: "minion/a-slug" },
          { id: "b", title: "Task B", description: "Build B", dependsOn: ["a"], status: "done", prUrl: "https://github.com/org/repo/pull/2", branch: "minion/b-slug" },
          { id: "c", title: "Task C", description: "Build C", dependsOn: [], status: "running" },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)
      ctx.topicSessions.set(session.threadId, session)

      await orchestrator.handleReviewCommand(session)

      // Should send the start message + 2 child starting messages
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("DAG review started"),
        session.threadId,
      )
      expect(ctx.spawnTopicAgent).toHaveBeenCalledTimes(2)
      expect(session.childThreadIds).toHaveLength(2)
    })

    it("skips nodes without PRs even if done", async () => {
      const session = makeSession({ dagId: "dag-test", childThreadIds: [] })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: session.threadId,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "Task A", description: "", dependsOn: [], status: "done" }, // no prUrl
          { id: "b", title: "Task B", description: "", dependsOn: [], status: "done", prUrl: "https://github.com/org/repo/pull/1" },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)
      ctx.topicSessions.set(session.threadId, session)

      await orchestrator.handleReviewCommand(session)

      // Only one review child should be spawned (for node b)
      expect(ctx.spawnTopicAgent).toHaveBeenCalledTimes(1)
    })

    it("uses custom directive when provided", async () => {
      const session = makeSession({ dagId: "dag-test", childThreadIds: [] })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: session.threadId,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "Task A", description: "", dependsOn: [], status: "done", prUrl: "https://github.com/org/repo/pull/1", branch: "minion/a-slug" },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)
      ctx.topicSessions.set(session.threadId, session)

      await orchestrator.handleReviewCommand(session, "Focus on error handling")

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Focus on error handling"),
        session.threadId,
      )
    })

    it("stops spawning when global session limit is reached", async () => {
      const session = makeSession({ dagId: "dag-test", childThreadIds: [] })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: session.threadId,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "Task A", description: "", dependsOn: [], status: "done", prUrl: "https://github.com/org/repo/pull/1", branch: "minion/a-slug" },
          { id: "b", title: "Task B", description: "", dependsOn: [], status: "done", prUrl: "https://github.com/org/repo/pull/2", branch: "minion/b-slug" },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)
      ctx.topicSessions.set(session.threadId, session)

      // Fill all global slots so no review children can be spawned
      ctx.config.workspace.maxConcurrentSessions = 1
      ctx.sessions.set("existing", {} as any)

      await orchestrator.handleReviewCommand(session)

      // Should not spawn any children, and report the limit
      expect(ctx.spawnTopicAgent).not.toHaveBeenCalled()
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Session limit reached"),
        session.threadId,
      )
    })

    it("reports failure when no review sessions could be spawned", async () => {
      const session = makeSession({ dagId: "dag-test", childThreadIds: [] })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: session.threadId,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "Task A", description: "", dependsOn: [], status: "done", prUrl: "https://github.com/org/repo/pull/1", branch: "minion/a-slug" },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)
      ctx.topicSessions.set(session.threadId, session)

      // Make forum topic creation fail
      vi.mocked(ctx.telegram.createForumTopic).mockRejectedValue(new Error("API error"))

      await orchestrator.handleReviewCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Failed to spawn any review sessions"),
        session.threadId,
      )
    })

    it("rejects when review is already in progress", async () => {
      const session = makeSession({ dagId: "dag-test", childThreadIds: [300] })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: session.threadId,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "Task A", description: "", dependsOn: [], status: "done", prUrl: "https://github.com/org/repo/pull/1" },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)

      // Existing active review child
      ctx.topicSessions.set(300, makeSession({
        threadId: 300,
        mode: "dag-review",
        activeSessionId: "session-active",
        dagId: "dag-test",
        dagNodeId: "a",
      }))

      await orchestrator.handleReviewCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("already in progress"),
        session.threadId,
      )
      expect(ctx.spawnTopicAgent).not.toHaveBeenCalled()
    })
  })

  describe("onDagChildComplete — dag-review early return", () => {
    it("routes dag-review children to onDagReviewChildComplete", async () => {
      const session = makeSession({ dagId: "dag-test", childThreadIds: [300] })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: session.threadId,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "Task A", description: "", dependsOn: [], status: "done", prUrl: "https://github.com/org/repo/pull/1" },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)
      ctx.topicSessions.set(session.threadId, session)

      const reviewChild = makeSession({
        threadId: 300,
        mode: "dag-review",
        slug: "review-child",
        dagId: "dag-test",
        dagNodeId: "a",
        parentThreadId: session.threadId,
        childThreadIds: [],
      })
      ctx.topicSessions.set(300, reviewChild)

      await orchestrator.onDagChildComplete(reviewChild, "completed")

      // Should NOT try to extract PR (that's what the task handler does)
      expect(ctx.extractPRFromConversation).not.toHaveBeenCalled()
      // Should report completion in parent
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Review of"),
        session.threadId,
      )
    })
  })

  describe("onDagReviewChildComplete", () => {
    it("clears conversation and reports per-node status", async () => {
      const session = makeSession({ dagId: "dag-test", childThreadIds: [300] })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: session.threadId,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "Task A", description: "", dependsOn: [], status: "done", prUrl: "https://github.com/org/repo/pull/42" },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)
      ctx.topicSessions.set(session.threadId, session)

      const reviewChild = makeSession({
        threadId: 300,
        mode: "dag-review",
        slug: "review-slug",
        dagId: "dag-test",
        dagNodeId: "a",
        parentThreadId: session.threadId,
        conversation: [{ role: "user", text: "review this" }, { role: "assistant", text: "LGTM" }],
      })
      ctx.topicSessions.set(300, reviewChild)

      await orchestrator.onDagReviewChildComplete(reviewChild)

      expect(reviewChild.conversation).toEqual([])
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Task A"),
        session.threadId,
      )
    })

    it("sends DAG review complete when all review children are done", async () => {
      const session = makeSession({ dagId: "dag-test", childThreadIds: [300, 400] })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: session.threadId,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "Task A", description: "", dependsOn: [], status: "done", prUrl: "https://github.com/org/repo/pull/1" },
          { id: "b", title: "Task B", description: "", dependsOn: [], status: "done", prUrl: "https://github.com/org/repo/pull/2" },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)
      ctx.topicSessions.set(session.threadId, session)

      // Both children are dag-review, both inactive (no activeSessionId)
      ctx.topicSessions.set(300, makeSession({
        threadId: 300, mode: "dag-review", dagId: "dag-test", dagNodeId: "a", parentThreadId: session.threadId,
      }))
      ctx.topicSessions.set(400, makeSession({
        threadId: 400, mode: "dag-review", dagId: "dag-test", dagNodeId: "b", parentThreadId: session.threadId,
      }))

      // Complete the last review child (300)
      const child = ctx.topicSessions.get(300)!
      await orchestrator.onDagReviewChildComplete(child)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("DAG review complete"),
        session.threadId,
      )
    })

    it("returns early when child has no dagId", async () => {
      const child = makeSession({ dagId: undefined, dagNodeId: "a" })
      await orchestrator.onDagReviewChildComplete(child)
      expect(ctx.telegram.sendMessage).not.toHaveBeenCalled()
    })

    it("returns early when child has no dagNodeId", async () => {
      const child = makeSession({ dagId: "dag-test", dagNodeId: undefined })
      await orchestrator.onDagReviewChildComplete(child)
      expect(ctx.telegram.sendMessage).not.toHaveBeenCalled()
    })

    it("returns early when graph is not found", async () => {
      const child = makeSession({ dagId: "dag-missing", dagNodeId: "a" })
      await orchestrator.onDagReviewChildComplete(child)
      expect(ctx.telegram.sendMessage).not.toHaveBeenCalled()
    })

    it("returns early when node is not found in graph", async () => {
      const session = makeSession({ dagId: "dag-test", childThreadIds: [300] })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: session.threadId,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "Task A", description: "", dependsOn: [], status: "done", prUrl: "https://github.com/org/repo/pull/1" },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)
      ctx.topicSessions.set(session.threadId, session)

      const child = makeSession({ dagId: "dag-test", dagNodeId: "nonexistent", parentThreadId: session.threadId })
      await orchestrator.onDagReviewChildComplete(child)
      expect(ctx.telegram.sendMessage).not.toHaveBeenCalled()
    })

    it("includes PR number and link in completion message", async () => {
      const session = makeSession({ dagId: "dag-test", childThreadIds: [300] })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: session.threadId,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "Task A", description: "", dependsOn: [], status: "done", prUrl: "https://github.com/org/repo/pull/42" },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)
      ctx.topicSessions.set(session.threadId, session)

      const reviewChild = makeSession({
        threadId: 300,
        mode: "dag-review",
        slug: "review-slug",
        dagId: "dag-test",
        dagNodeId: "a",
        parentThreadId: session.threadId,
      })
      ctx.topicSessions.set(300, reviewChild)

      await orchestrator.onDagReviewChildComplete(reviewChild)

      const msg = vi.mocked(ctx.telegram.sendMessage).mock.calls[0][0] as string
      expect(msg).toContain("#42")
      expect(msg).toContain("https://github.com/org/repo/pull/42")
    })

    it("persists topic sessions after completion", async () => {
      const session = makeSession({ dagId: "dag-test", childThreadIds: [300] })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: session.threadId,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "Task A", description: "", dependsOn: [], status: "done", prUrl: "https://github.com/org/repo/pull/1" },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)
      ctx.topicSessions.set(session.threadId, session)

      const reviewChild = makeSession({
        threadId: 300,
        mode: "dag-review",
        dagId: "dag-test",
        dagNodeId: "a",
        parentThreadId: session.threadId,
      })
      ctx.topicSessions.set(300, reviewChild)

      await orchestrator.onDagReviewChildComplete(reviewChild)

      expect(ctx.persistTopicSessions).toHaveBeenCalled()
    })

    it("does not send complete when some review children are still active", async () => {
      const session = makeSession({ dagId: "dag-test", childThreadIds: [300, 400] })
      const graph: DagGraph = {
        id: "dag-test",
        parentThreadId: session.threadId,
        repo: "org/repo",
        nodes: [
          { id: "a", title: "Task A", description: "", dependsOn: [], status: "done", prUrl: "https://github.com/org/repo/pull/1" },
          { id: "b", title: "Task B", description: "", dependsOn: [], status: "done", prUrl: "https://github.com/org/repo/pull/2" },
        ],
      } as DagGraph
      ctx.dags.set("dag-test", graph)
      ctx.topicSessions.set(session.threadId, session)

      // 300 is completing, 400 is still active
      ctx.topicSessions.set(300, makeSession({
        threadId: 300, mode: "dag-review", dagId: "dag-test", dagNodeId: "a", parentThreadId: session.threadId,
      }))
      ctx.topicSessions.set(400, makeSession({
        threadId: 400, mode: "dag-review", dagId: "dag-test", dagNodeId: "b", parentThreadId: session.threadId,
        activeSessionId: "still-running",
      }))

      const child = ctx.topicSessions.get(300)!
      await orchestrator.onDagReviewChildComplete(child)

      const calls = vi.mocked(ctx.telegram.sendMessage).mock.calls
      const hasComplete = calls.some(([msg]) => typeof msg === "string" && msg.includes("DAG review complete"))
      expect(hasComplete).toBe(false)
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
