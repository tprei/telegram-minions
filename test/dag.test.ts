import { describe, it, expect } from "vitest"
import {
  buildDag,
  buildLinearDag,
  topologicalSort,
  readyNodes,
  advanceDag,
  failNode,
  resetFailedNode,
  isDagComplete,
  getUpstreamBranches,
  criticalPathLength,
  dagProgress,
  transitiveReduction,
  renderDagStatus,
  renderDagForGitHub,
  upsertDagSection,
  DAG_STATUS_START,
  DAG_STATUS_END,
  type DagGraph,
  type DagInput,
} from "../src/dag.js"

describe("buildDag", () => {
  it("builds a simple linear DAG", () => {
    const items: DagInput[] = [
      { id: "a", title: "Step A", description: "First", dependsOn: [] },
      { id: "b", title: "Step B", description: "Second", dependsOn: ["a"] },
      { id: "c", title: "Step C", description: "Third", dependsOn: ["b"] },
    ]
    const graph = buildDag("test-dag", items, 123, "myrepo")

    expect(graph.nodes).toHaveLength(3)
    expect(graph.nodes[0].status).toBe("ready")  // a has no deps
    expect(graph.nodes[1].status).toBe("pending") // b depends on a
    expect(graph.nodes[2].status).toBe("pending") // c depends on b
  })

  it("builds a diamond DAG", () => {
    const items: DagInput[] = [
      { id: "a", title: "Base", description: "Foundation", dependsOn: [] },
      { id: "b", title: "Left", description: "Left branch", dependsOn: ["a"] },
      { id: "c", title: "Right", description: "Right branch", dependsOn: ["a"] },
      { id: "d", title: "Merge", description: "Merge point", dependsOn: ["b", "c"] },
    ]
    const graph = buildDag("diamond", items, 1, "repo")

    expect(graph.nodes[0].status).toBe("ready")   // a
    expect(graph.nodes[1].status).toBe("pending")  // b
    expect(graph.nodes[2].status).toBe("pending")  // c
    expect(graph.nodes[3].status).toBe("pending")  // d
  })

  it("builds a parallel DAG (no dependencies)", () => {
    const items: DagInput[] = [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: [] },
      { id: "c", title: "C", description: "C", dependsOn: [] },
    ]
    const graph = buildDag("parallel", items, 1, "repo")

    expect(graph.nodes.every((n) => n.status === "ready")).toBe(true)
  })

  it("throws on unknown dependency", () => {
    const items: DagInput[] = [
      { id: "a", title: "A", description: "A", dependsOn: ["nonexistent"] },
    ]
    expect(() => buildDag("bad", items, 1, "repo")).toThrow("unknown node")
  })

  it("throws on self-dependency", () => {
    const items: DagInput[] = [
      { id: "a", title: "A", description: "A", dependsOn: ["a"] },
    ]
    expect(() => buildDag("bad", items, 1, "repo")).toThrow("depends on itself")
  })

  it("throws on cycle", () => {
    const items: DagInput[] = [
      { id: "a", title: "A", description: "A", dependsOn: ["b"] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
    ]
    expect(() => buildDag("cycle", items, 1, "repo")).toThrow("cycle")
  })

  it("throws on longer cycle", () => {
    const items: DagInput[] = [
      { id: "a", title: "A", description: "A", dependsOn: ["c"] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
      { id: "c", title: "C", description: "C", dependsOn: ["b"] },
    ]
    expect(() => buildDag("cycle", items, 1, "repo")).toThrow("cycle")
  })
})

describe("buildLinearDag", () => {
  it("creates a chain of dependencies", () => {
    const items = [
      { title: "First", description: "Do first" },
      { title: "Second", description: "Do second" },
      { title: "Third", description: "Do third" },
    ]
    const graph = buildLinearDag("linear", items, 1, "repo")

    expect(graph.nodes).toHaveLength(3)
    expect(graph.nodes[0].dependsOn).toEqual([])
    expect(graph.nodes[1].dependsOn).toEqual(["step-0"])
    expect(graph.nodes[2].dependsOn).toEqual(["step-1"])
    expect(graph.nodes[0].status).toBe("ready")
    expect(graph.nodes[1].status).toBe("pending")
    expect(graph.nodes[2].status).toBe("pending")
  })
})

describe("topologicalSort", () => {
  it("sorts a linear DAG", () => {
    const graph = buildDag("linear", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
      { id: "c", title: "C", description: "C", dependsOn: ["b"] },
    ], 1, "repo")

    expect(topologicalSort(graph)).toEqual(["a", "b", "c"])
  })

  it("sorts a diamond DAG", () => {
    const graph = buildDag("diamond", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
      { id: "c", title: "C", description: "C", dependsOn: ["a"] },
      { id: "d", title: "D", description: "D", dependsOn: ["b", "c"] },
    ], 1, "repo")

    const sorted = topologicalSort(graph)
    expect(sorted).toHaveLength(4)
    expect(sorted[0]).toBe("a")
    expect(sorted[sorted.length - 1]).toBe("d")
    expect(sorted.indexOf("b")).toBeLessThan(sorted.indexOf("d"))
    expect(sorted.indexOf("c")).toBeLessThan(sorted.indexOf("d"))
  })

  it("returns all independent nodes", () => {
    const graph = buildDag("parallel", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: [] },
    ], 1, "repo")

    const sorted = topologicalSort(graph)
    expect(sorted).toHaveLength(2)
    expect(sorted).toContain("a")
    expect(sorted).toContain("b")
  })
})

describe("readyNodes", () => {
  it("returns nodes with no pending dependencies", () => {
    const graph = buildDag("test", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
    ], 1, "repo")

    const ready = readyNodes(graph)
    expect(ready).toHaveLength(1)
    expect(ready[0].id).toBe("a")
  })
})

describe("advanceDag", () => {
  it("marks pending nodes as ready when deps complete", () => {
    const graph = buildDag("test", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
      { id: "c", title: "C", description: "C", dependsOn: ["b"] },
    ], 1, "repo")

    // Simulate: a is done
    graph.nodes[0].status = "done"
    const newlyReady = advanceDag(graph)

    expect(newlyReady).toHaveLength(1)
    expect(newlyReady[0].id).toBe("b")
    expect(graph.nodes[1].status).toBe("ready")
    expect(graph.nodes[2].status).toBe("pending") // c still waiting on b
  })

  it("handles fan-in: node ready only when all deps are done", () => {
    const graph = buildDag("diamond", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
      { id: "c", title: "C", description: "C", dependsOn: ["a"] },
      { id: "d", title: "D", description: "D", dependsOn: ["b", "c"] },
    ], 1, "repo")

    // a done
    graph.nodes[0].status = "done"
    let ready = advanceDag(graph)
    expect(ready).toHaveLength(2) // b and c
    expect(ready.map((n) => n.id).sort()).toEqual(["b", "c"])

    // b done but c still running
    graph.nodes[1].status = "done"
    graph.nodes[2].status = "running"
    ready = advanceDag(graph)
    expect(ready).toHaveLength(0) // d not ready yet

    // c done too
    graph.nodes[2].status = "done"
    ready = advanceDag(graph)
    expect(ready).toHaveLength(1)
    expect(ready[0].id).toBe("d")
  })

  it("returns empty when nothing new is ready", () => {
    const graph = buildDag("test", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
    ], 1, "repo")

    // a still ready, nothing changed
    const ready = advanceDag(graph)
    expect(ready).toHaveLength(0)
  })
})

describe("failNode", () => {
  it("marks node as failed and skips transitive dependents", () => {
    const graph = buildDag("test", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
      { id: "c", title: "C", description: "C", dependsOn: ["b"] },
    ], 1, "repo")

    const skipped = failNode(graph, "a")
    expect(graph.nodes[0].status).toBe("failed")
    expect(graph.nodes[1].status).toBe("skipped")
    expect(graph.nodes[2].status).toBe("skipped")
    expect(skipped).toEqual(["b", "c"])
  })

  it("only skips downstream nodes, not siblings", () => {
    const graph = buildDag("test", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
      { id: "c", title: "C", description: "C", dependsOn: [] },
    ], 1, "repo")

    const skipped = failNode(graph, "a")
    expect(graph.nodes[0].status).toBe("failed")
    expect(graph.nodes[1].status).toBe("skipped")
    expect(graph.nodes[2].status).toBe("ready") // c is independent
    expect(skipped).toEqual(["b"])
  })

  it("does not skip already done nodes", () => {
    const graph = buildDag("test", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
      { id: "c", title: "C", description: "C", dependsOn: ["a"] },
    ], 1, "repo")

    graph.nodes[1].status = "done" // b already done
    const skipped = failNode(graph, "a")
    expect(skipped).toEqual(["c"]) // only c gets skipped
    expect(graph.nodes[1].status).toBe("done") // b stays done
  })
})

describe("isDagComplete", () => {
  it("returns true when all nodes are in terminal state", () => {
    const graph = buildDag("test", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
    ], 1, "repo")

    graph.nodes[0].status = "done"
    graph.nodes[1].status = "done"
    expect(isDagComplete(graph)).toBe(true)
  })

  it("returns true when mix of done/failed/skipped", () => {
    const graph = buildDag("test", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
    ], 1, "repo")

    graph.nodes[0].status = "failed"
    graph.nodes[1].status = "skipped"
    expect(isDagComplete(graph)).toBe(true)
  })

  it("returns false when nodes still pending or running", () => {
    const graph = buildDag("test", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
    ], 1, "repo")

    graph.nodes[0].status = "done"
    expect(isDagComplete(graph)).toBe(false) // b still pending
  })
})

describe("getUpstreamBranches", () => {
  it("returns branches of direct dependencies", () => {
    const graph = buildDag("test", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: [] },
      { id: "c", title: "C", description: "C", dependsOn: ["a", "b"] },
    ], 1, "repo")

    graph.nodes[0].branch = "minion/slug-a"
    graph.nodes[1].branch = "minion/slug-b"

    const branches = getUpstreamBranches(graph, "c")
    expect(branches).toEqual(["minion/slug-a", "minion/slug-b"])
  })

  it("skips dependencies without branches", () => {
    const graph = buildDag("test", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
    ], 1, "repo")

    // a has no branch yet
    const branches = getUpstreamBranches(graph, "b")
    expect(branches).toEqual([])
  })

  it("returns empty for root nodes", () => {
    const graph = buildDag("test", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
    ], 1, "repo")

    expect(getUpstreamBranches(graph, "a")).toEqual([])
  })
})

describe("criticalPathLength", () => {
  it("returns 1 for a single node", () => {
    const graph = buildDag("test", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
    ], 1, "repo")
    expect(criticalPathLength(graph)).toBe(1)
  })

  it("returns chain length for linear DAG", () => {
    const graph = buildDag("test", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
      { id: "c", title: "C", description: "C", dependsOn: ["b"] },
    ], 1, "repo")
    expect(criticalPathLength(graph)).toBe(3)
  })

  it("returns depth of diamond DAG", () => {
    const graph = buildDag("test", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
      { id: "c", title: "C", description: "C", dependsOn: ["a"] },
      { id: "d", title: "D", description: "D", dependsOn: ["b", "c"] },
    ], 1, "repo")
    expect(criticalPathLength(graph)).toBe(3) // a -> b/c -> d
  })
})

describe("dagProgress", () => {
  it("counts all statuses correctly", () => {
    const graph = buildDag("test", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: [] },
      { id: "c", title: "C", description: "C", dependsOn: ["a"] },
      { id: "d", title: "D", description: "D", dependsOn: ["a"] },
    ], 1, "repo")

    graph.nodes[0].status = "done"
    graph.nodes[1].status = "running"
    // c should still be pending, d should be pending

    const progress = dagProgress(graph)
    expect(progress.total).toBe(4)
    expect(progress.done).toBe(1)
    expect(progress.running).toBe(1)
    expect(progress.ready).toBe(0)
    expect(progress.pending).toBe(2)
    expect(progress.failed).toBe(0)
    expect(progress.skipped).toBe(0)
  })
})

describe("transitiveReduction", () => {
  it("removes redundant edges", () => {
    // a -> b -> c, and a -> c (redundant)
    const items: DagInput[] = [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
      { id: "c", title: "C", description: "C", dependsOn: ["a", "b"] },
    ]
    const graph = buildDag("test", items, 1, "repo")

    transitiveReduction(graph)

    const c = graph.nodes.find((n) => n.id === "c")!
    expect(c.dependsOn).toEqual(["b"]) // a is redundant since b->a
  })

  it("preserves necessary edges", () => {
    const items: DagInput[] = [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
      { id: "c", title: "C", description: "C", dependsOn: ["a"] },
    ]
    const graph = buildDag("test", items, 1, "repo")

    transitiveReduction(graph)

    // Both edges are necessary (b and c independently depend on a)
    expect(graph.nodes[1].dependsOn).toEqual(["a"])
    expect(graph.nodes[2].dependsOn).toEqual(["a"])
  })
})

describe("renderDagStatus", () => {
  it("renders a basic status display", () => {
    const graph = buildDag("test", [
      { id: "a", title: "Schema", description: "DB schema", dependsOn: [] },
      { id: "b", title: "API", description: "API routes", dependsOn: ["a"] },
    ], 1, "repo")

    graph.nodes[0].status = "done"
    graph.nodes[0].prUrl = "https://github.com/repo/pull/1"

    const status = renderDagStatus(graph)
    expect(status).toContain("Schema")
    expect(status).toContain("API")
    expect(status).toContain("✅")
    expect(status).toContain("PR")
    expect(status).toContain("1/2 complete")
  })
})

describe("renderDagForGitHub", () => {
  it("wraps output in HTML comment markers", () => {
    const graph = buildDag("test", [
      { id: "a", title: "Task A", description: "A", dependsOn: [] },
    ], 1, "repo")

    const result = renderDagForGitHub(graph)
    expect(result).toMatch(/^<!-- dag-status-start -->/)
    expect(result).toMatch(/<!-- dag-status-end -->$/)
  })

  it("renders empty DAG", () => {
    const graph: DagGraph = {
      id: "empty",
      nodes: [],
      parentThreadId: 1,
      repo: "repo",
      createdAt: Date.now(),
    }

    const result = renderDagForGitHub(graph)
    expect(result).toContain(DAG_STATUS_START)
    expect(result).toContain(DAG_STATUS_END)
    expect(result).toContain("No tasks in DAG")
  })

  it("renders a single node", () => {
    const graph = buildDag("test", [
      { id: "a", title: "Only task", description: "Solo", dependsOn: [] },
    ], 1, "repo")

    const result = renderDagForGitHub(graph)
    expect(result).toContain("```mermaid")
    expect(result).toContain("flowchart TD")
    expect(result).toContain("Only task")
    expect(result).toContain("| 1 |")
    expect(result).toContain("0/1 complete")
  })

  it("renders a linear stack with edges", () => {
    const graph = buildLinearDag("stack", [
      { title: "Schema migration", description: "DB" },
      { title: "API routes", description: "Routes" },
      { title: "Frontend UI", description: "UI" },
    ], 1, "repo")

    graph.nodes[0].status = "done"
    graph.nodes[0].prUrl = "https://github.com/repo/pull/1"
    graph.nodes[1].status = "running"

    const result = renderDagForGitHub(graph, "step-1")

    // Mermaid edges: step-0 --> step-1, step-1 --> step-2
    expect(result).toContain("step-0 --> step-1")
    expect(result).toContain("step-1 --> step-2")

    // Status classes
    expect(result).toContain("class step-0 done")
    expect(result).toContain("class step-1 running")
    expect(result).toContain("class step-1 current")
    expect(result).toContain("class step-2 pending")

    // Table: current node highlighted
    expect(result).toContain("**API routes** _(this PR)_")
    expect(result).toContain("[PR](https://github.com/repo/pull/1)")

    // Progress
    expect(result).toContain("1/3 complete")
    expect(result).toContain("1 running")
  })

  it("renders a diamond DAG", () => {
    const graph = buildDag("diamond", [
      { id: "a", title: "Base", description: "Foundation", dependsOn: [] },
      { id: "b", title: "Left", description: "Left branch", dependsOn: ["a"] },
      { id: "c", title: "Right", description: "Right branch", dependsOn: ["a"] },
      { id: "d", title: "Merge", description: "Merge point", dependsOn: ["b", "c"] },
    ], 1, "repo")

    graph.nodes[0].status = "done"
    graph.nodes[1].status = "running"
    graph.nodes[2].status = "done"
    graph.nodes[3].status = "pending"

    const result = renderDagForGitHub(graph, "b")

    // Edges
    expect(result).toContain("a --> b")
    expect(result).toContain("a --> c")
    expect(result).toContain("b --> d")
    expect(result).toContain("c --> d")

    // Current node
    expect(result).toContain("class b current")
    expect(result).toContain("**Left** _(this PR)_")
  })

  it("renders all status types correctly", () => {
    const graph = buildDag("test", [
      { id: "done-node", title: "Done", description: "D", dependsOn: [] },
      { id: "running-node", title: "Running", description: "R", dependsOn: [] },
      { id: "ready-node", title: "Ready", description: "Re", dependsOn: [] },
      { id: "pending-node", title: "Pending", description: "P", dependsOn: ["done-node"] },
      { id: "failed-node", title: "Failed", description: "F", dependsOn: [] },
      { id: "skipped-node", title: "Skipped", description: "S", dependsOn: ["failed-node"] },
    ], 1, "repo")

    graph.nodes[0].status = "done"
    graph.nodes[1].status = "running"
    graph.nodes[2].status = "ready"
    graph.nodes[3].status = "pending"
    graph.nodes[4].status = "failed"
    graph.nodes[5].status = "skipped"

    const result = renderDagForGitHub(graph)

    expect(result).toContain("✅ Done")
    expect(result).toContain("⚡ Running")
    expect(result).toContain("🔜 Ready")
    expect(result).toContain("⏳ Pending")
    expect(result).toContain("❌ Failed")
    expect(result).toContain("⏭️ Skipped")

    expect(result).toContain("classDef done")
    expect(result).toContain("classDef running")
    expect(result).toContain("classDef pending")
    expect(result).toContain("classDef ready")
    expect(result).toContain("classDef failed")
    expect(result).toContain("classDef skipped")
  })

  it("renders PR links as dash when absent", () => {
    const graph = buildDag("test", [
      { id: "a", title: "No PR", description: "A", dependsOn: [] },
    ], 1, "repo")

    const result = renderDagForGitHub(graph)
    expect(result).toContain("| — |")
  })

  it("handles special characters in titles", () => {
    const graph = buildDag("test", [
      { id: "a", title: 'Fix "quotes" & <tags>', description: "A", dependsOn: [] },
    ], 1, "repo")

    const result = renderDagForGitHub(graph)
    // Mermaid labels escape double quotes to single quotes
    expect(result).toContain("'quotes'")
    // Table renders title as-is (GitHub markdown handles it)
    expect(result).toContain('Fix "quotes" & <tags>')
  })

  it("sanitizes node IDs for mermaid", () => {
    const graph = buildDag("test", [
      { id: "node.with.dots", title: "Dotty", description: "A", dependsOn: [] },
    ], 1, "repo")

    const result = renderDagForGitHub(graph)
    // Dots replaced with underscores
    expect(result).toContain("node_with_dots")
    expect(result).not.toContain('node.with.dots["')
  })

  it("does not apply current class when currentNodeId is not set", () => {
    const graph = buildDag("test", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
    ], 1, "repo")

    const result = renderDagForGitHub(graph)
    // classDef current is always present, but no node should have "class X current"
    expect(result).not.toMatch(/class \w+ current/)
    expect(result).not.toContain("_(this PR)_")
  })

  it("shows failed and skipped counts in progress", () => {
    const graph = buildDag("test", [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
      { id: "c", title: "C", description: "C", dependsOn: ["b"] },
    ], 1, "repo")

    graph.nodes[0].status = "failed"
    graph.nodes[1].status = "skipped"
    graph.nodes[2].status = "skipped"

    const result = renderDagForGitHub(graph)
    expect(result).toContain("0/3 complete")
    expect(result).toContain("1 failed")
    expect(result).toContain("2 skipped")
  })
})

describe("upsertDagSection", () => {
  it("appends to empty body", () => {
    const section = `${DAG_STATUS_START}\ncontent\n${DAG_STATUS_END}`
    const result = upsertDagSection("", section)
    expect(result).toBe(section)
  })

  it("appends to existing body", () => {
    const section = `${DAG_STATUS_START}\ncontent\n${DAG_STATUS_END}`
    const result = upsertDagSection("## My PR\n\nSome description", section)
    expect(result).toContain("## My PR")
    expect(result).toContain("Some description")
    expect(result).toContain(DAG_STATUS_START)
  })

  it("replaces existing section", () => {
    const oldSection = `${DAG_STATUS_START}\nold content\n${DAG_STATUS_END}`
    const body = `## PR\n\n${oldSection}\n\nFooter`
    const newSection = `${DAG_STATUS_START}\nnew content\n${DAG_STATUS_END}`

    const result = upsertDagSection(body, newSection)
    expect(result).toContain("new content")
    expect(result).not.toContain("old content")
    expect(result).toContain("## PR")
    expect(result).toContain("Footer")
  })

  it("preserves content before and after markers on replace", () => {
    const body = `Before\n${DAG_STATUS_START}\nmiddle\n${DAG_STATUS_END}\nAfter`
    const newSection = `${DAG_STATUS_START}\nupdated\n${DAG_STATUS_END}`

    const result = upsertDagSection(body, newSection)
    expect(result).toBe(`Before\n${DAG_STATUS_START}\nupdated\n${DAG_STATUS_END}\nAfter`)
  })
})

describe("resetFailedNode", () => {
  function makeGraph(): DagGraph {
    return buildDag("test", [
      { id: "a", title: "A", description: "", dependsOn: [] },
      { id: "b", title: "B", description: "", dependsOn: ["a"] },
      { id: "c", title: "C", description: "", dependsOn: ["b"] },
    ], 1, "repo")
  }

  it("resets a failed node to ready and un-skips dependents", () => {
    const graph = makeGraph()
    graph.nodes[0].status = "done"
    graph.nodes[1].status = "failed"
    graph.nodes[1].error = "no PR"
    graph.nodes[1].recoveryAttempted = true
    graph.nodes[2].status = "skipped"
    graph.nodes[2].error = 'Skipped: upstream node "b" failed'

    const reset = resetFailedNode(graph, "b")

    expect(graph.nodes[1].status).toBe("ready")
    expect(graph.nodes[1].error).toBeUndefined()
    expect(graph.nodes[1].recoveryAttempted).toBe(false)
    expect(graph.nodes[2].status).toBe("pending")
    expect(graph.nodes[2].error).toBeUndefined()
    expect(reset).toEqual(["c"])
  })

  it("returns empty array for non-failed node", () => {
    const graph = makeGraph()
    graph.nodes[0].status = "done"

    const reset = resetFailedNode(graph, "a")
    expect(reset).toEqual([])
    expect(graph.nodes[0].status).toBe("done")
  })

  it("returns empty array for unknown node", () => {
    const graph = makeGraph()
    expect(resetFailedNode(graph, "nonexistent")).toEqual([])
  })

  it("handles diamond dependency with partial skip", () => {
    const graph = buildDag("test", [
      { id: "a", title: "A", description: "", dependsOn: [] },
      { id: "b", title: "B", description: "", dependsOn: ["a"] },
      { id: "c", title: "C", description: "", dependsOn: ["a"] },
      { id: "d", title: "D", description: "", dependsOn: ["b", "c"] },
    ], 1, "repo")

    graph.nodes[0].status = "done"
    graph.nodes[1].status = "failed"
    graph.nodes[1].error = "no PR"
    graph.nodes[2].status = "done"
    graph.nodes[3].status = "skipped"

    const reset = resetFailedNode(graph, "b")

    expect(graph.nodes[1].status).toBe("ready")
    expect(graph.nodes[3].status).toBe("pending")
    expect(reset).toEqual(["d"])
  })
})
