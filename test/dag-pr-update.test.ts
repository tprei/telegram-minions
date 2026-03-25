import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  buildDag,
  renderDagForGitHub,
  upsertDagSection,
  DAG_STATUS_START,
  DAG_STATUS_END,
  type DagInput,
} from "../src/dag.js"

describe("DAG PR description update flow", () => {
  const items: DagInput[] = [
    { id: "api", title: "API routes", description: "Build API", dependsOn: [] },
    { id: "ui", title: "Frontend UI", description: "Build UI", dependsOn: ["api"] },
    { id: "tests", title: "E2E tests", description: "Test everything", dependsOn: ["api", "ui"] },
  ]

  it("generates a unique DAG section per node with correct current highlighting", () => {
    const graph = buildDag("test-dag", items, 1, "repo")
    graph.nodes[0].status = "done"
    graph.nodes[0].prUrl = "https://github.com/repo/pull/1"
    graph.nodes[1].status = "running"
    graph.nodes[1].prUrl = "https://github.com/repo/pull/2"
    graph.nodes[2].status = "pending"

    const sectionForApi = renderDagForGitHub(graph, "api")
    const sectionForUi = renderDagForGitHub(graph, "ui")

    // Both have the same graph structure
    expect(sectionForApi).toContain("api --> ui")
    expect(sectionForUi).toContain("api --> ui")

    // But different current node highlights
    expect(sectionForApi).toContain("class api current")
    expect(sectionForApi).not.toContain("class ui current")
    expect(sectionForUi).toContain("class ui current")
    expect(sectionForUi).not.toContain("class api current")

    // Table highlights differ
    expect(sectionForApi).toContain("**API routes** _(this PR)_")
    expect(sectionForApi).not.toContain("**Frontend UI** _(this PR)_")
    expect(sectionForUi).toContain("**Frontend UI** _(this PR)_")
    expect(sectionForUi).not.toContain("**API routes** _(this PR)_")
  })

  it("upserts DAG section into an existing PR body", () => {
    const graph = buildDag("test-dag", items, 1, "repo")
    graph.nodes[0].status = "done"
    graph.nodes[0].prUrl = "https://github.com/repo/pull/1"

    const existingBody = "## Summary\n\nThis PR adds API routes."
    const dagSection = renderDagForGitHub(graph, "api")
    const updatedBody = upsertDagSection(existingBody, dagSection)

    expect(updatedBody).toContain("## Summary")
    expect(updatedBody).toContain("This PR adds API routes.")
    expect(updatedBody).toContain(DAG_STATUS_START)
    expect(updatedBody).toContain(DAG_STATUS_END)
    expect(updatedBody).toContain("```mermaid")
  })

  it("replaces existing DAG section on subsequent updates", () => {
    const graph = buildDag("test-dag", items, 1, "repo")
    graph.nodes[0].status = "running"
    graph.nodes[0].prUrl = "https://github.com/repo/pull/1"

    const originalBody = "## Summary\n\nInitial description."
    const firstSection = renderDagForGitHub(graph, "api")
    const bodyAfterFirst = upsertDagSection(originalBody, firstSection)

    expect(bodyAfterFirst).toContain("⚡ Running")

    // Simulate node completion
    graph.nodes[0].status = "done"
    graph.nodes[1].status = "running"
    graph.nodes[1].prUrl = "https://github.com/repo/pull/2"

    const secondSection = renderDagForGitHub(graph, "api")
    const bodyAfterSecond = upsertDagSection(bodyAfterFirst, secondSection)

    // Old status gone, new status present
    expect(bodyAfterSecond).toContain("✅ Done")
    // Original content preserved
    expect(bodyAfterSecond).toContain("## Summary")
    expect(bodyAfterSecond).toContain("Initial description.")
    // Only one pair of markers
    const startCount = bodyAfterSecond.split(DAG_STATUS_START).length - 1
    const endCount = bodyAfterSecond.split(DAG_STATUS_END).length - 1
    expect(startCount).toBe(1)
    expect(endCount).toBe(1)
  })

  it("updates all sibling PRs with current graph state", () => {
    const graph = buildDag("test-dag", items, 1, "repo")
    graph.nodes[0].status = "done"
    graph.nodes[0].prUrl = "https://github.com/repo/pull/1"
    graph.nodes[1].status = "done"
    graph.nodes[1].prUrl = "https://github.com/repo/pull/2"
    graph.nodes[2].status = "running"
    graph.nodes[2].prUrl = "https://github.com/repo/pull/3"

    const nodesWithPRs = graph.nodes.filter((n) => n.prUrl)
    const bodies = new Map<string, string>()

    // Simulate what updateDagPRDescriptions does for each node
    for (const node of nodesWithPRs) {
      const dagSection = renderDagForGitHub(graph, node.id)
      const existingBody = `## ${node.title}\n\nDescription for ${node.id}.`
      const newBody = upsertDagSection(existingBody, dagSection)
      bodies.set(node.id, newBody)
    }

    // All three PRs have been updated
    expect(bodies.size).toBe(3)

    // Each PR highlights itself
    expect(bodies.get("api")).toContain("**API routes** _(this PR)_")
    expect(bodies.get("ui")).toContain("**Frontend UI** _(this PR)_")
    expect(bodies.get("tests")).toContain("**E2E tests** _(this PR)_")

    // All PRs show the same progress
    for (const body of bodies.values()) {
      expect(body).toContain("2/3 complete")
      expect(body).toContain("1 running")
    }
  })

  it("skips nodes without PR URLs", () => {
    const graph = buildDag("test-dag", items, 1, "repo")
    graph.nodes[0].status = "done"
    graph.nodes[0].prUrl = "https://github.com/repo/pull/1"
    graph.nodes[1].status = "running"
    // node 1 has no prUrl yet

    const nodesWithPRs = graph.nodes.filter((n) => n.prUrl)
    expect(nodesWithPRs).toHaveLength(1)
    expect(nodesWithPRs[0].id).toBe("api")
  })
})
