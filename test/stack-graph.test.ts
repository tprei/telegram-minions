import { describe, it, expect } from "vitest"
import { StackGraph, createStackMetadata, buildLinearStack } from "../src/stack-graph.js"
import type { StackNode } from "../src/types.js"

describe("StackGraph", () => {
  describe("getRoots", () => {
    it("finds root nodes with no dependencies", () => {
      const metadata = createStackMetadata(
        "test-stack",
        "test",
        1,
        undefined,
        [
          { id: "a", title: "A", description: "First", dependencies: [] },
          { id: "b", title: "B", description: "Second", dependencies: ["a"] },
          { id: "c", title: "C", description: "Third", dependencies: ["a"] },
        ],
      )
      const graph = new StackGraph(metadata)
      const roots = graph.getRoots()
      expect(roots).toHaveLength(1)
      expect(roots[0].id).toBe("a")
    })

    it("finds multiple roots in a forest", () => {
      const metadata = createStackMetadata(
        "test-stack",
        "test",
        1,
        undefined,
        [
          { id: "a", title: "A", description: "First", dependencies: [] },
          { id: "b", title: "B", description: "Second", dependencies: [] },
          { id: "c", title: "C", description: "Third", dependencies: ["a", "b"] },
        ],
      )
      const graph = new StackGraph(metadata)
      const roots = graph.getRoots()
      expect(roots).toHaveLength(2)
      expect(roots.map((r) => r.id).sort()).toEqual(["a", "b"])
    })
  })

  describe("getChildren", () => {
    it("finds nodes that depend on a given node", () => {
      const metadata = createStackMetadata(
        "test-stack",
        "test",
        1,
        undefined,
        [
          { id: "a", title: "A", description: "First", dependencies: [] },
          { id: "b", title: "B", description: "Second", dependencies: ["a"] },
          { id: "c", title: "C", description: "Third", dependencies: ["a"] },
          { id: "d", title: "D", description: "Fourth", dependencies: ["b"] },
        ],
      )
      const graph = new StackGraph(metadata)
      const children = graph.getChildren("a")
      expect(children).toHaveLength(2)
      expect(children.map((c) => c.id).sort()).toEqual(["b", "c"])
    })
  })

  describe("getDescendants", () => {
    it("finds all transitive children", () => {
      const metadata = createStackMetadata(
        "test-stack",
        "test",
        1,
        undefined,
        [
          { id: "a", title: "A", description: "First", dependencies: [] },
          { id: "b", title: "B", description: "Second", dependencies: ["a"] },
          { id: "c", title: "C", description: "Third", dependencies: ["a"] },
          { id: "d", title: "D", description: "Fourth", dependencies: ["b"] },
          { id: "e", title: "E", description: "Fifth", dependencies: ["d"] },
        ],
      )
      const graph = new StackGraph(metadata)
      const descendants = graph.getDescendants("a")
      expect(descendants).toHaveLength(4)
      expect(descendants.map((d) => d.id).sort()).toEqual(["b", "c", "d", "e"])
    })
  })

  describe("getReadyNodes", () => {
    it("finds pending nodes with all dependencies completed", () => {
      const metadata = createStackMetadata(
        "test-stack",
        "test",
        1,
        undefined,
        [
          { id: "a", title: "A", description: "First", dependencies: [] },
          { id: "b", title: "B", description: "Second", dependencies: ["a"] },
          { id: "c", title: "C", description: "Third", dependencies: ["a"] },
        ],
      )
      const graph = new StackGraph(metadata)

      // Initially only 'a' is ready
      let ready = graph.getReadyNodes(new Set())
      expect(ready).toHaveLength(1)
      expect(ready[0].id).toBe("a")

      // Mark 'a' as completed
      graph.updateNodeStatus("a", "completed")
      const completed = new Set(["a"])

      // Now 'b' and 'c' are ready (status is still pending)
      ready = graph.getReadyNodes(completed)
      expect(ready).toHaveLength(2)
      expect(ready.map((r) => r.id).sort()).toEqual(["b", "c"])
    })

    it("respects diamond dependencies", () => {
      const metadata = createStackMetadata(
        "test-stack",
        "test",
        1,
        undefined,
        [
          { id: "base", title: "Base", description: "Base", dependencies: [] },
          { id: "left", title: "Left", description: "Left", dependencies: ["base"] },
          { id: "right", title: "Right", description: "Right", dependencies: ["base"] },
          { id: "merge", title: "Merge", description: "Merge", dependencies: ["left", "right"] },
        ],
      )
      const graph = new StackGraph(metadata)

      // Only base is ready initially
      let ready = graph.getReadyNodes(new Set())
      expect(ready).toHaveLength(1)
      expect(ready[0].id).toBe("base")

      // Mark base as completed
      graph.updateNodeStatus("base", "completed")
      const completed = new Set(["base"])

      // After base completes, left and right are ready
      ready = graph.getReadyNodes(completed)
      expect(ready).toHaveLength(2)
      expect(ready.map((r) => r.id).sort()).toEqual(["left", "right"])

      // Mark left as completed
      graph.updateNodeStatus("left", "completed")
      completed.add("left")

      // After left completes, merge is NOT ready (still needs right)
      ready = graph.getReadyNodes(completed)
      expect(ready).toHaveLength(1)
      expect(ready[0].id).toBe("right")

      // Mark right as completed
      graph.updateNodeStatus("right", "completed")
      completed.add("right")

      // After both left and right complete, merge is ready
      ready = graph.getReadyNodes(completed)
      expect(ready).toHaveLength(1)
      expect(ready[0].id).toBe("merge")
    })
  })

  describe("getBaseBranch", () => {
    it("returns main for root nodes", () => {
      const metadata = createStackMetadata(
        "test-stack",
        "test",
        1,
        undefined,
        [{ id: "a", title: "A", description: "First", dependencies: [] }],
      )
      const graph = new StackGraph(metadata)
      expect(graph.getBaseBranch("a")).toBe("main")
    })

    it("returns parent branch for single dependency", () => {
      const metadata = createStackMetadata(
        "test-stack",
        "test",
        1,
        undefined,
        [
          { id: "a", title: "A", description: "First", dependencies: [] },
          { id: "b", title: "B", description: "Second", dependencies: ["a"] },
        ],
      )
      const graph = new StackGraph(metadata)
      metadata.nodes.get("a")!.branch = "stack/test/a"
      expect(graph.getBaseBranch("b")).toBe("stack/test/a")
    })

    it("returns first parent branch for multiple dependencies", () => {
      const metadata = createStackMetadata(
        "test-stack",
        "test",
        1,
        undefined,
        [
          { id: "a", title: "A", description: "First", dependencies: [] },
          { id: "b", title: "B", description: "Second", dependencies: [] },
          { id: "c", title: "C", description: "Third", dependencies: ["a", "b"] },
        ],
      )
      const graph = new StackGraph(metadata)
      metadata.nodes.get("a")!.branch = "stack/test/a"
      metadata.nodes.get("b")!.branch = "stack/test/b"
      expect(graph.getBaseBranch("c")).toBe("stack/test/a")
    })
  })

  describe("getParentBranches", () => {
    it("returns main for root nodes", () => {
      const metadata = createStackMetadata(
        "test-stack",
        "test",
        1,
        undefined,
        [{ id: "a", title: "A", description: "First", dependencies: [] }],
      )
      const graph = new StackGraph(metadata)
      expect(graph.getParentBranches("a")).toEqual(["main"])
    })

    it("returns all parent branches for diamond dependency", () => {
      const metadata = createStackMetadata(
        "test-stack",
        "test",
        1,
        undefined,
        [
          { id: "a", title: "A", description: "First", dependencies: [] },
          { id: "b", title: "B", description: "Second", dependencies: [] },
          { id: "c", title: "C", description: "Third", dependencies: ["a", "b"] },
        ],
      )
      const graph = new StackGraph(metadata)
      metadata.nodes.get("a")!.branch = "branch-a"
      metadata.nodes.get("b")!.branch = "branch-b"
      expect(graph.getParentBranches("c")).toEqual(["branch-a", "branch-b"])
    })
  })

  describe("validateDAG", () => {
    it("validates a simple DAG", () => {
      const metadata = createStackMetadata(
        "test-stack",
        "test",
        1,
        undefined,
        [
          { id: "a", title: "A", description: "First", dependencies: [] },
          { id: "b", title: "B", description: "Second", dependencies: ["a"] },
        ],
      )
      const graph = new StackGraph(metadata)
      const result = graph.validateDAG()
      expect(result.valid).toBe(true)
    })

    it("detects a cycle", () => {
      const metadata = createStackMetadata(
        "test-stack",
        "test",
        1,
        undefined,
        [
          { id: "a", title: "A", description: "First", dependencies: ["c"] },
          { id: "b", title: "B", description: "Second", dependencies: ["a"] },
          { id: "c", title: "C", description: "Third", dependencies: ["b"] },
        ],
      )
      const graph = new StackGraph(metadata)
      const result = graph.validateDAG()
      expect(result.valid).toBe(false)
      expect(result.cycle).toBeDefined()
      expect(result.cycle!.length).toBeGreaterThan(0)
    })
  })

  describe("topologicalSort", () => {
    it("orders nodes so dependencies come before dependents", () => {
      const metadata = createStackMetadata(
        "test-stack",
        "test",
        1,
        undefined,
        [
          { id: "a", title: "A", description: "First", dependencies: [] },
          { id: "b", title: "B", description: "Second", dependencies: ["a"] },
          { id: "c", title: "C", description: "Third", dependencies: ["a"] },
          { id: "d", title: "D", description: "Fourth", dependencies: ["b", "c"] },
        ],
      )
      const graph = new StackGraph(metadata)
      const sorted = graph.topologicalSort()

      const ids = sorted.map((n) => n.id)
      expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"))
      expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("c"))
      expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("d"))
      expect(ids.indexOf("c")).toBeLessThan(ids.indexOf("d"))
    })
  })

  describe("getNodeDepths", () => {
    it("calculates correct depths", () => {
      const metadata = createStackMetadata(
        "test-stack",
        "test",
        1,
        undefined,
        [
          { id: "a", title: "A", description: "First", dependencies: [] },
          { id: "b", title: "B", description: "Second", dependencies: ["a"] },
          { id: "c", title: "C", description: "Third", dependencies: ["a"] },
          { id: "d", title: "D", description: "Fourth", dependencies: ["b"] },
        ],
      )
      const graph = new StackGraph(metadata)
      const depths = graph.getNodeDepths()

      expect(depths.get("a")).toBe(0)
      expect(depths.get("b")).toBe(1)
      expect(depths.get("c")).toBe(1)
      expect(depths.get("d")).toBe(2)
    })
  })

  describe("getSummary", () => {
    it("calculates correct summary", () => {
      const metadata = createStackMetadata(
        "test-stack",
        "test",
        1,
        undefined,
        [
          { id: "a", title: "A", description: "First", dependencies: [] },
          { id: "b", title: "B", description: "Second", dependencies: ["a"] },
          { id: "c", title: "C", description: "Third", dependencies: ["a"] },
        ],
      )
      const graph = new StackGraph(metadata)
      metadata.nodes.get("a")!.status = "completed"
      metadata.nodes.get("b")!.status = "running"

      const summary = graph.getSummary()
      expect(summary.total).toBe(3)
      expect(summary.byStatus.pending).toBe(1)
      expect(summary.byStatus.completed).toBe(1)
      expect(summary.byStatus.running).toBe(1)
      expect(summary.maxDepth).toBe(1)
    })
  })
})

describe("createStackMetadata", () => {
  it("creates metadata with correct structure", () => {
    const metadata = createStackMetadata(
      "stack-123",
      "my-stack",
      42,
      "https://github.com/org/repo",
      [
        { id: "a", title: "First", description: "Do first", dependencies: [] },
        { id: "b", title: "Second", description: "Do second", dependencies: ["a"] },
      ],
      "sequential",
      "manual",
    )

    expect(metadata.stackId).toBe("stack-123")
    expect(metadata.slug).toBe("my-stack")
    expect(metadata.parentThreadId).toBe(42)
    expect(metadata.repoUrl).toBe("https://github.com/org/repo")
    expect(metadata.mode).toBe("sequential")
    expect(metadata.mergeStrategy).toBe("manual")
    expect(metadata.nodes.size).toBe(2)
    expect(metadata.createdAt).toBeGreaterThan(0)
  })

  it("initializes all nodes as pending", () => {
    const metadata = createStackMetadata("id", "slug", 1, undefined, [
      { id: "a", title: "A", description: "X", dependencies: [] },
    ])

    for (const node of metadata.nodes.values()) {
      expect(node.status).toBe("pending")
    }
  })
})

describe("buildLinearStack", () => {
  it("builds a linear chain where each item depends on the previous", () => {
    const items = [
      { title: "First", description: "Do first" },
      { title: "Second", description: "Do second" },
      { title: "Third", description: "Do third" },
    ]

    const metadata = buildLinearStack(
      "stack-id",
      "my-stack",
      1,
      undefined,
      items,
      "sequential",
    )

    const nodes = Array.from(metadata.nodes.values())
    expect(nodes).toHaveLength(3)

    // First item has no dependencies
    const first = nodes.find((n) => n.title === "First")!
    expect(first.dependencies).toEqual([])

    // Second depends on first
    const second = nodes.find((n) => n.title === "Second")!
    expect(second.dependencies).toEqual([first.id])

    // Third depends on second
    const third = nodes.find((n) => n.title === "Third")!
    expect(third.dependencies).toEqual([second.id])
  })

  it("handles single item", () => {
    const metadata = buildLinearStack(
      "stack-id",
      "my-stack",
      1,
      undefined,
      [{ title: "Only", description: "Only item" }],
    )

    expect(metadata.nodes.size).toBe(1)
    const node = Array.from(metadata.nodes.values())[0]!
    expect(node.dependencies).toEqual([])
  })
})
