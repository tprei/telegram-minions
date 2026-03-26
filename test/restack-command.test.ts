import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  formatRestackStart,
  formatRestackProgress,
  formatRestackComplete,
  formatRestackConflict,
  formatRestackNoop,
} from "../src/format.js"
import { needsRestack, type DagGraph } from "../src/dag.js"

describe("restack format helpers", () => {
  describe("formatRestackStart", () => {
    it("uses singular for one branch", () => {
      const result = formatRestackStart(1)
      expect(result).toContain("1 downstream branch…")
      expect(result).not.toContain("branches")
    })

    it("uses plural for multiple branches", () => {
      const result = formatRestackStart(3)
      expect(result).toContain("3 downstream branches…")
    })

    it("contains restack emoji", () => {
      expect(formatRestackStart(2)).toContain("🔄")
    })
  })

  describe("formatRestackProgress", () => {
    it("includes node title and id", () => {
      const result = formatRestackProgress("Add auth", "auth-1")
      expect(result).toContain("Add auth")
      expect(result).toContain("auth-1")
    })

    it("escapes HTML in title", () => {
      const result = formatRestackProgress("Fix <script>", "node-1")
      expect(result).toContain("&lt;script&gt;")
      expect(result).not.toContain("<script>")
    })
  })

  describe("formatRestackComplete", () => {
    it("shows success when all branches rebased", () => {
      const result = formatRestackComplete(3, 3)
      expect(result).toContain("✅")
      expect(result).toContain("3/3")
    })

    it("shows warning when some branches failed", () => {
      const result = formatRestackComplete(2, 3)
      expect(result).toContain("⚠️")
      expect(result).toContain("2/3")
      expect(result).toContain("1 failed")
    })
  })

  describe("formatRestackConflict", () => {
    it("lists conflict files", () => {
      const result = formatRestackConflict("Add auth", "auth-1", ["src/a.ts", "src/b.ts"])
      expect(result).toContain("src/a.ts")
      expect(result).toContain("src/b.ts")
    })

    it("truncates long file lists", () => {
      const files = Array.from({ length: 8 }, (_, i) => `src/file${i}.ts`)
      const result = formatRestackConflict("Node", "n-1", files)
      expect(result).toContain("+3 more")
    })

    it("handles empty file list", () => {
      const result = formatRestackConflict("Node", "n-1", [])
      expect(result).toContain("❌")
      expect(result).toContain("Node")
    })
  })

  describe("formatRestackNoop", () => {
    it("indicates nothing to do", () => {
      const result = formatRestackNoop()
      expect(result).toContain("up to date")
      expect(result).toContain("✅")
    })
  })
})

describe("restack command validation logic", () => {
  function makeDag(overrides?: Partial<DagGraph>): DagGraph {
    return {
      id: "dag-1",
      nodes: [
        { id: "a", title: "Setup", description: "", dependsOn: [], status: "done", branch: "minion/a", prUrl: "https://github.com/org/repo/pull/1", mergeBase: "abc123" },
        { id: "b", title: "Feature B", description: "", dependsOn: ["a"], status: "done", branch: "minion/b", prUrl: "https://github.com/org/repo/pull/2", mergeBase: "abc123" },
        { id: "c", title: "Feature C", description: "", dependsOn: ["a"], status: "pending", branch: "minion/c", mergeBase: "abc123" },
        { id: "d", title: "Integration", description: "", dependsOn: ["b", "c"], status: "pending" },
      ],
      parentThreadId: 100,
      repo: "test-repo",
      createdAt: Date.now(),
      ...overrides,
    }
  }

  it("identifies nodes needing restack when upstream changes", () => {
    const graph = makeDag()
    const nodes = needsRestack(graph, "a")
    // b is done (terminal state), so only c should need restacking
    expect(nodes.map((n) => n.id)).toEqual(["c"])
  })

  it("returns empty when no downstream nodes have branch + mergeBase", () => {
    const graph = makeDag()
    // d has no branch or mergeBase
    const nodes = needsRestack(graph, "b")
    expect(nodes).toEqual([])
  })

  it("skips running nodes in needsRestack (they have non-terminal status but we filter them)", () => {
    const graph = makeDag({
      nodes: [
        { id: "a", title: "Setup", description: "", dependsOn: [], status: "done", branch: "minion/a", mergeBase: "abc123" },
        { id: "b", title: "Running", description: "", dependsOn: ["a"], status: "running", branch: "minion/b", mergeBase: "abc123" },
      ],
    })
    // needsRestack does NOT filter running — the handler does the safety check
    const nodes = needsRestack(graph, "a")
    expect(nodes.map((n) => n.id)).toEqual(["b"])
  })

  it("returns nodes in topological order for multi-level restacking", () => {
    const graph: DagGraph = {
      id: "dag-2",
      nodes: [
        { id: "root", title: "Root", description: "", dependsOn: [], status: "done", branch: "minion/root", mergeBase: "aaa" },
        { id: "mid", title: "Middle", description: "", dependsOn: ["root"], status: "ready", branch: "minion/mid", mergeBase: "aaa" },
        { id: "leaf", title: "Leaf", description: "", dependsOn: ["mid"], status: "pending", branch: "minion/leaf", mergeBase: "bbb" },
      ],
      parentThreadId: 200,
      repo: "test-repo",
      createdAt: Date.now(),
    }
    const nodes = needsRestack(graph, "root")
    expect(nodes.map((n) => n.id)).toEqual(["mid", "leaf"])
  })

  describe("running node safety check", () => {
    it("detects running nodes that would block restack", () => {
      const graph = makeDag({
        nodes: [
          { id: "a", title: "Setup", description: "", dependsOn: [], status: "done", branch: "minion/a", mergeBase: "abc" },
          { id: "b", title: "Feature B", description: "", dependsOn: ["a"], status: "running", branch: "minion/b", mergeBase: "abc" },
        ],
      })
      const toRestack = needsRestack(graph, "a")
      const runningNodes = toRestack.filter((n) => n.status === "running")
      expect(runningNodes).toHaveLength(1)
      expect(runningNodes[0].id).toBe("b")
    })

    it("allows restack when all downstream are non-running", () => {
      const graph = makeDag({
        nodes: [
          { id: "a", title: "Setup", description: "", dependsOn: [], status: "done", branch: "minion/a", mergeBase: "abc" },
          { id: "b", title: "Feature B", description: "", dependsOn: ["a"], status: "pending", branch: "minion/b", mergeBase: "abc" },
          { id: "c", title: "Feature C", description: "", dependsOn: ["a"], status: "ready", branch: "minion/c", mergeBase: "abc" },
        ],
      })
      const toRestack = needsRestack(graph, "a")
      const runningNodes = toRestack.filter((n) => n.status === "running")
      expect(runningNodes).toHaveLength(0)
    })
  })
})
