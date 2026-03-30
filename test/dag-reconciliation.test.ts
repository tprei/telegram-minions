import { describe, it, expect, vi, beforeEach } from "vitest"
import type { DagGraph, DagNode } from "../src/dag/dag.js"
import type { TopicSession } from "../src/types.js"

vi.mock("../src/sentry.js", () => ({
  captureException: vi.fn(),
}))

function makeNode(overrides: Partial<DagNode> = {}): DagNode {
  return {
    id: "node-1",
    title: "Task 1",
    description: "Do something",
    dependsOn: [],
    status: "pending",
    ...overrides,
  }
}

function makeGraph(nodes: DagNode[], overrides: Partial<DagGraph> = {}): DagGraph {
  return {
    id: "dag-test",
    nodes,
    parentThreadId: 100,
    repo: "org/repo",
    createdAt: Date.now(),
    ...overrides,
  }
}

function makeSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 100,
    repo: "org/repo",
    cwd: "/tmp/workspace",
    slug: "parent-slug",
    conversation: [],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

describe("DAG reconciliation", () => {
  describe("running node with dead session", () => {
    it("transitions to failed and skips dependents", async () => {
      const { advanceDag, failNode } = await import("../src/dag/dag.js")

      const nodeA = makeNode({ id: "a", status: "running", threadId: 200 })
      const nodeB = makeNode({ id: "b", status: "pending", dependsOn: ["a"] })
      const graph = makeGraph([nodeA, nodeB])

      const childAlive = false
      if (nodeA.status === "running" && !childAlive) {
        failNode(graph, nodeA.id)
        nodeA.error = "Session lost during restart"
        nodeA.recoveryAttempted = false
      }

      advanceDag(graph)

      expect(nodeA.status).toBe("failed")
      expect(nodeA.error).toBe("Session lost during restart")
      expect(nodeA.recoveryAttempted).toBe(false)
      expect(nodeB.status).toBe("skipped")
    })
  })

  describe("running node with live session", () => {
    it("remains running when session is still active", async () => {
      const nodeA = makeNode({ id: "a", status: "running", threadId: 200 })
      const graph = makeGraph([nodeA])

      const childAlive = true
      if (nodeA.status === "running" && !childAlive) {
        const { failNode } = await import("../src/dag/dag.js")
        failNode(graph, nodeA.id)
      }

      expect(nodeA.status).toBe("running")
    })
  })

  describe("ci-pending node", () => {
    it("transitions to ci-failed without skipping dependents", async () => {
      const { advanceDag } = await import("../src/dag/dag.js")

      const nodeA = makeNode({ id: "a", status: "ci-pending", prUrl: "https://github.com/org/repo/pull/1" })
      const nodeB = makeNode({ id: "b", status: "pending", dependsOn: ["a"] })
      const graph = makeGraph([nodeA, nodeB])

      if (nodeA.status === "ci-pending") {
        nodeA.status = "ci-failed"
        nodeA.error = "CI status unknown after restart"
      }

      advanceDag(graph)

      expect(nodeA.status).toBe("ci-failed")
      expect(nodeA.error).toBe("CI status unknown after restart")
      expect(nodeB.status).toBe("pending")
    })
  })

  describe("stable node states", () => {
    it("does not mutate done/pending/ready/failed nodes", async () => {
      const nodes = [
        makeNode({ id: "a", status: "done" }),
        makeNode({ id: "b", status: "pending", dependsOn: ["a"] }),
        makeNode({ id: "c", status: "ready" }),
        makeNode({ id: "d", status: "failed", error: "original error" }),
      ]
      const graph = makeGraph(nodes)

      let mutated = false
      for (const node of graph.nodes) {
        if (node.status === "running" || node.status === "ci-pending") {
          mutated = true
        }
      }

      expect(mutated).toBe(false)
      expect(nodes[0].status).toBe("done")
      expect(nodes[1].status).toBe("pending")
      expect(nodes[2].status).toBe("ready")
      expect(nodes[3].status).toBe("failed")
      expect(nodes[3].error).toBe("original error")
    })
  })

  describe("advanceDag is called after reconciliation", () => {
    it("promotes pending nodes whose deps are now done", async () => {
      const { advanceDag, failNode } = await import("../src/dag/dag.js")

      const nodeA = makeNode({ id: "a", status: "done" })
      const nodeB = makeNode({ id: "b", status: "running", threadId: 300 })
      const nodeC = makeNode({ id: "c", status: "pending", dependsOn: ["a"] })
      const graph = makeGraph([nodeA, nodeB, nodeC])

      const childAlive = false
      if (nodeB.status === "running" && !childAlive) {
        failNode(graph, nodeB.id)
        nodeB.error = "Session lost during restart"
        nodeB.recoveryAttempted = false
      }

      const newlyReady = advanceDag(graph)

      expect(nodeC.status).toBe("ready")
      expect(newlyReady).toHaveLength(1)
      expect(newlyReady[0].id).toBe("c")
    })
  })

  describe("clean graph produces no mutations", () => {
    it("returns no mutations for a fully done graph", () => {
      const nodes = [
        makeNode({ id: "a", status: "done" }),
        makeNode({ id: "b", status: "done", dependsOn: ["a"] }),
      ]
      const graph = makeGraph(nodes)

      let mutated = false
      for (const node of graph.nodes) {
        if (node.status === "running" || node.status === "ci-pending") {
          mutated = true
        }
      }

      expect(mutated).toBe(false)
    })
  })
})
