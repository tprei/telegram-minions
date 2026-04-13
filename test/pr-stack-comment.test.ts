import { describe, it, expect } from "vitest"
import { renderStackComment, SENTINEL_START, SENTINEL_END } from "../src/dag/pr-stack-comment.js"
import type { DagGraph } from "../src/dag/dag.js"

function makeGraph(): DagGraph {
  return {
    id: "dag-sole-holm",
    repo: "telegram-minions",
    parentThreadId: 1,
    createdAt: 0,
    nodes: [
      {
        id: "a",
        title: "cap stderr chunks",
        description: "",
        dependsOn: [],
        status: "landed",
        branch: "minion/a",
        prUrl: "https://github.com/org/repo/pull/423",
      },
      {
        id: "b",
        title: "clean replyqueues stale",
        description: "",
        dependsOn: ["a"],
        status: "landed",
        branch: "minion/b",
        prUrl: "https://github.com/org/repo/pull/424",
      },
      {
        id: "c",
        title: "cap textbuffer",
        description: "",
        dependsOn: ["b"],
        status: "done",
        branch: "minion/c",
        prUrl: "https://github.com/org/repo/pull/425",
      },
      {
        id: "d",
        title: "close readline",
        description: "",
        dependsOn: ["c"],
        status: "ready",
        branch: "minion/d",
        prUrl: "https://github.com/org/repo/pull/426",
      },
    ],
  }
}

describe("renderStackComment", () => {
  it("wraps the output in sentinel markers so it can be found for updates", () => {
    const graph = makeGraph()
    const out = renderStackComment(graph)
    expect(out.startsWith(SENTINEL_START)).toBe(true)
    expect(out.endsWith(SENTINEL_END)).toBe(true)
  })

  it("includes a header with the dag label and node count", () => {
    const graph = makeGraph()
    const out = renderStackComment(graph)
    expect(out).toContain("Stack: `sole-holm`")
    expect(out).toContain("(4 nodes)")
  })

  it("renders every node title in topological order", () => {
    const graph = makeGraph()
    const out = renderStackComment(graph)
    const idxA = out.indexOf("cap stderr chunks")
    const idxB = out.indexOf("clean replyqueues stale")
    const idxC = out.indexOf("cap textbuffer")
    const idxD = out.indexOf("close readline")
    expect(idxA).toBeGreaterThan(-1)
    expect(idxB).toBeGreaterThan(idxA)
    expect(idxC).toBeGreaterThan(idxB)
    expect(idxD).toBeGreaterThan(idxC)
  })

  it("includes the PR number for each node that has one", () => {
    const graph = makeGraph()
    const out = renderStackComment(graph)
    expect(out).toContain("#423")
    expect(out).toContain("#424")
    expect(out).toContain("#425")
    expect(out).toContain("#426")
  })

  it("marks the current PR with an arrow when currentNodeId is given", () => {
    const graph = makeGraph()
    const out = renderStackComment(graph, "c")
    expect(out).toContain("← this PR")

    const idxCurrent = out.indexOf("← this PR")
    const idxC = out.indexOf("cap textbuffer")
    // The arrow should be on the same line as the current node
    const before = out.slice(0, idxCurrent)
    const lastNewline = before.lastIndexOf("\n")
    expect(before.slice(lastNewline + 1)).toContain("cap textbuffer")
    expect(idxC).toBeGreaterThan(-1)
  })

  it("reports landed/ready/blocked counts correctly", () => {
    const graph = makeGraph()
    const out = renderStackComment(graph)
    expect(out).toContain("2/4 landed")
    expect(out).toContain("1 ready")
    expect(out).toContain("1 blocked")
  })

  it("reports failed count when a node has failed", () => {
    const graph = makeGraph()
    graph.nodes[2].status = "failed"
    const out = renderStackComment(graph)
    expect(out).toContain("1 failed")
  })

  it("renders a single-node stack without crashing", () => {
    const graph: DagGraph = {
      id: "dag-tiny",
      repo: "r",
      parentThreadId: 1,
      createdAt: 0,
      nodes: [
        {
          id: "only",
          title: "solo",
          description: "",
          dependsOn: [],
          status: "done",
          branch: "minion/only",
          prUrl: "https://github.com/o/r/pull/1",
        },
      ],
    }
    const out = renderStackComment(graph)
    expect(out).toContain("solo")
    expect(out).toContain("(1 node)")
    expect(out).toContain("0/1 landed")
  })

  it("caps long titles so the stack box stays aligned", () => {
    const graph: DagGraph = {
      id: "dag-x",
      repo: "r",
      parentThreadId: 1,
      createdAt: 0,
      nodes: [
        {
          id: "a",
          title: "A really really really really really really long task title that should be truncated",
          description: "",
          dependsOn: [],
          status: "ready",
        },
      ],
    }
    const out = renderStackComment(graph)
    expect(out).toContain("...")
    // Titles are truncated to ~40 chars
    expect(out).not.toContain("should be truncated")
  })
})
