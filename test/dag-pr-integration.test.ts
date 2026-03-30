import { describe, it, expect } from "vitest"
import {
  buildDag,
  buildLinearDag,
  advanceDag,
  failNode,
  isDagComplete,
  dagProgress,
  renderDagForGitHub,
  upsertDagSection,
  DAG_STATUS_START,
  DAG_STATUS_END,
  type DagGraph,
  type DagInput,
} from "../src/dag/dag.js"

/**
 * Simulates what the dispatcher's updateDagPRDescriptions does:
 * for each node with a prUrl, render the DAG section with that node as current,
 * then upsert it into the PR body.
 */
function updateAllPRBodies(
  graph: DagGraph,
  prBodies: Map<string, string>,
): void {
  for (const node of graph.nodes) {
    if (!node.prUrl) continue
    const dagSection = renderDagForGitHub(graph, node.id)
    const currentBody = prBodies.get(node.id) ?? ""
    prBodies.set(node.id, upsertDagSection(currentBody, dagSection))
  }
}

function countMarkers(body: string): { start: number; end: number } {
  return {
    start: body.split(DAG_STATUS_START).length - 1,
    end: body.split(DAG_STATUS_END).length - 1,
  }
}

describe("DAG PR integration — full lifecycle", () => {
  const diamondItems: DagInput[] = [
    { id: "schema", title: "DB Schema", description: "Create schema", dependsOn: [] },
    { id: "api", title: "API Routes", description: "Build API", dependsOn: ["schema"] },
    { id: "worker", title: "Background Worker", description: "Build worker", dependsOn: ["schema"] },
    { id: "integration", title: "Integration Tests", description: "E2E tests", dependsOn: ["api", "worker"] },
  ]

  it("simulates spawning first node and creating its PR with DAG section", () => {
    const graph = buildDag("lifecycle", diamondItems, 1, "repo")
    const prBodies = new Map<string, string>()

    // Dispatcher spawns schema node, it completes and opens a PR
    graph.nodes[0].status = "done"
    graph.nodes[0].prUrl = "https://github.com/org/repo/pull/10"
    graph.nodes[0].branch = "minion/schema-slug"

    // Simulate initial PR body (what the child agent wrote)
    prBodies.set("schema", "## DB Schema\n\nAdds migration for new tables.")

    // Dispatcher calls updateDagPRDescriptions
    updateAllPRBodies(graph, prBodies)

    const body = prBodies.get("schema")!
    expect(body).toContain("## DB Schema")
    expect(body).toContain("Adds migration for new tables.")
    expect(body).toContain(DAG_STATUS_START)
    expect(body).toContain(DAG_STATUS_END)
    expect(body).toContain("```mermaid")
    expect(body).toContain("**DB Schema** _(this PR)_")
    expect(body).toContain("1/4 complete")
  })

  it("simulates completing a node and re-rendering with updated statuses", () => {
    const graph = buildDag("lifecycle", diamondItems, 1, "repo")
    const prBodies = new Map<string, string>()

    // Phase 1: schema done
    graph.nodes[0].status = "done"
    graph.nodes[0].prUrl = "https://github.com/org/repo/pull/10"
    prBodies.set("schema", "## Schema PR")
    updateAllPRBodies(graph, prBodies)

    // Phase 2: advance DAG, api and worker become ready and start running
    const newlyReady = advanceDag(graph)
    expect(newlyReady.map((n) => n.id).sort()).toEqual(["api", "worker"])

    graph.nodes[1].status = "running"
    graph.nodes[2].status = "running"
    updateAllPRBodies(graph, prBodies)

    // Schema PR now shows api and worker as running
    const schemaBody = prBodies.get("schema")!
    expect(schemaBody).toContain("⚡ Running")
    expect(schemaBody).toContain("1/4 complete")
    expect(schemaBody).toContain("2 running")

    // Phase 3: api completes, opens PR
    graph.nodes[1].status = "done"
    graph.nodes[1].prUrl = "https://github.com/org/repo/pull/11"
    prBodies.set("api", "## API Routes PR\n\nImplements REST endpoints.")
    updateAllPRBodies(graph, prBodies)

    // Schema PR updated with new progress
    const schemaAfter = prBodies.get("schema")!
    expect(schemaAfter).toContain("2/4 complete")
    expect(schemaAfter).toContain("1 running")

    // API PR has DAG section with itself highlighted
    const apiBody = prBodies.get("api")!
    expect(apiBody).toContain("**API Routes** _(this PR)_")
    expect(apiBody).toContain("## API Routes PR")
    expect(apiBody).not.toContain("**DB Schema** _(this PR)_")
  })

  it("updates all sibling PRs on each node completion", () => {
    const graph = buildDag("siblings", diamondItems, 1, "repo")
    const prBodies = new Map<string, string>()

    // All four nodes done with PRs
    graph.nodes[0].status = "done"
    graph.nodes[0].prUrl = "https://github.com/org/repo/pull/1"
    graph.nodes[1].status = "done"
    graph.nodes[1].prUrl = "https://github.com/org/repo/pull/2"
    graph.nodes[2].status = "done"
    graph.nodes[2].prUrl = "https://github.com/org/repo/pull/3"
    graph.nodes[3].status = "done"
    graph.nodes[3].prUrl = "https://github.com/org/repo/pull/4"

    prBodies.set("schema", "Schema description")
    prBodies.set("api", "API description")
    prBodies.set("worker", "Worker description")
    prBodies.set("integration", "Integration description")

    updateAllPRBodies(graph, prBodies)

    // All four PRs should show the same progress
    for (const [nodeId, body] of prBodies) {
      expect(body).toContain("4/4 complete")
      expect(body).toContain("```mermaid")
      expect(body).toContain(DAG_STATUS_START)
      expect(body).toContain(DAG_STATUS_END)

      // Each highlights only itself
      const node = graph.nodes.find((n) => n.id === nodeId)!
      expect(body).toContain(`**${node.title}** _(this PR)_`)

      // Others are not highlighted
      for (const other of graph.nodes) {
        if (other.id !== nodeId) {
          expect(body).not.toContain(`**${other.title}** _(this PR)_`)
        }
      }
    }

    // Verify all PRs show the same graph structure
    for (const body of prBodies.values()) {
      expect(body).toContain("schema --> api")
      expect(body).toContain("schema --> worker")
      expect(body).toContain("api --> integration")
      expect(body).toContain("worker --> integration")
    }
  })

  it("prevents duplicate DAG sections after multiple updates", () => {
    const graph = buildDag("idempotent", diamondItems, 1, "repo")
    const prBodies = new Map<string, string>()

    graph.nodes[0].status = "done"
    graph.nodes[0].prUrl = "https://github.com/org/repo/pull/1"
    prBodies.set("schema", "Original PR body")

    // Update 5 times to simulate multiple node completions triggering updates
    for (let i = 0; i < 5; i++) {
      updateAllPRBodies(graph, prBodies)
    }

    const body = prBodies.get("schema")!
    const markers = countMarkers(body)
    expect(markers.start).toBe(1)
    expect(markers.end).toBe(1)

    // Original content preserved
    expect(body).toContain("Original PR body")
  })
})

describe("DAG PR integration — linear stack lifecycle", () => {
  it("simulates a 3-step stack progressing sequentially", () => {
    const graph = buildLinearDag("stack", [
      { title: "Schema migration", description: "DB changes" },
      { title: "API routes", description: "REST endpoints" },
      { title: "Frontend UI", description: "React components" },
    ], 1, "repo")
    const prBodies = new Map<string, string>()

    // Step 1: first node runs and completes
    graph.nodes[0].status = "done"
    graph.nodes[0].prUrl = "https://github.com/org/repo/pull/20"
    prBodies.set("step-0", "## Schema migration\n\nMigration PR.")
    updateAllPRBodies(graph, prBodies)

    expect(prBodies.get("step-0")!).toContain("1/3 complete")
    expect(prBodies.get("step-0")!).toContain("**Schema migration** _(this PR)_")

    // Step 2: advance, second node runs and completes
    advanceDag(graph)
    graph.nodes[1].status = "done"
    graph.nodes[1].prUrl = "https://github.com/org/repo/pull/21"
    prBodies.set("step-1", "## API routes\n\nAPI PR.")
    updateAllPRBodies(graph, prBodies)

    // Both PRs updated
    expect(prBodies.get("step-0")!).toContain("2/3 complete")
    expect(prBodies.get("step-1")!).toContain("2/3 complete")

    // Each highlights its own row
    expect(prBodies.get("step-0")!).toContain("**Schema migration** _(this PR)_")
    expect(prBodies.get("step-1")!).toContain("**API routes** _(this PR)_")

    // Stack edges rendered
    expect(prBodies.get("step-1")!).toContain("step-0 --> step-1")
    expect(prBodies.get("step-1")!).toContain("step-1 --> step-2")

    // Step 3: advance, third node runs and completes
    advanceDag(graph)
    graph.nodes[2].status = "done"
    graph.nodes[2].prUrl = "https://github.com/org/repo/pull/22"
    prBodies.set("step-2", "## Frontend UI\n\nUI PR.")
    updateAllPRBodies(graph, prBodies)

    // All 3 show completion
    for (const body of prBodies.values()) {
      expect(body).toContain("3/3 complete")
      const markers = countMarkers(body)
      expect(markers.start).toBe(1)
      expect(markers.end).toBe(1)
    }
  })
})

describe("DAG PR integration — failure cascading in PR descriptions", () => {
  it("shows failed and skipped statuses in sibling PRs after a node fails", () => {
    const items: DagInput[] = [
      { id: "base", title: "Base Setup", description: "Foundation", dependsOn: [] },
      { id: "feat-a", title: "Feature A", description: "First feature", dependsOn: ["base"] },
      { id: "feat-b", title: "Feature B", description: "Second feature", dependsOn: ["base"] },
      { id: "final", title: "Final Integration", description: "Merge all", dependsOn: ["feat-a", "feat-b"] },
    ]
    const graph = buildDag("fail-test", items, 1, "repo")
    const prBodies = new Map<string, string>()

    // base completes
    graph.nodes[0].status = "done"
    graph.nodes[0].prUrl = "https://github.com/org/repo/pull/30"
    prBodies.set("base", "## Base Setup PR")
    advanceDag(graph)

    // feat-a completes
    graph.nodes[1].status = "done"
    graph.nodes[1].prUrl = "https://github.com/org/repo/pull/31"
    prBodies.set("feat-a", "## Feature A PR")

    // feat-b fails — cascades skip to final
    const skipped = failNode(graph, "feat-b")
    expect(skipped).toEqual(["final"])

    updateAllPRBodies(graph, prBodies)

    // base PR shows the failure
    const baseBody = prBodies.get("base")!
    expect(baseBody).toContain("❌ Failed")
    expect(baseBody).toContain("⏭️ Skipped")
    expect(baseBody).toContain("2/4 complete")
    expect(baseBody).toContain("1 failed")
    expect(baseBody).toContain("1 skipped")

    // feat-a PR also shows the same
    const featABody = prBodies.get("feat-a")!
    expect(featABody).toContain("❌ Failed")
    expect(featABody).toContain("⏭️ Skipped")
    expect(featABody).toContain("2/4 complete")

    // feat-b has no PR (it failed before opening one), so no body
    expect(prBodies.has("feat-b")).toBe(false)

    // DAG is complete since all remaining nodes are terminal
    expect(isDagComplete(graph)).toBe(true)
  })
})

describe("DAG PR integration — edge cases", () => {
  it("handles nodes that complete without opening PRs", () => {
    const items: DagInput[] = [
      { id: "a", title: "Task A", description: "A", dependsOn: [] },
      { id: "b", title: "Task B", description: "B", dependsOn: ["a"] },
    ]
    const graph = buildDag("no-pr", items, 1, "repo")
    const prBodies = new Map<string, string>()

    // a completes but has no PR
    graph.nodes[0].status = "done"
    // no prUrl set
    updateAllPRBodies(graph, prBodies)

    // No PR bodies should be created
    expect(prBodies.size).toBe(0)

    // b completes with a PR
    advanceDag(graph)
    graph.nodes[1].status = "done"
    graph.nodes[1].prUrl = "https://github.com/org/repo/pull/40"
    prBodies.set("b", "## Task B PR")
    updateAllPRBodies(graph, prBodies)

    // Only b's PR has a DAG section
    expect(prBodies.size).toBe(1)
    const bBody = prBodies.get("b")!
    expect(bBody).toContain("**Task B** _(this PR)_")
    expect(bBody).toContain("2/2 complete")
  })

  it("preserves non-DAG content through multiple upserts with changing body", () => {
    const items: DagInput[] = [
      { id: "a", title: "A", description: "A", dependsOn: [] },
    ]
    const graph = buildDag("preserve", items, 1, "repo")

    // Initial body with custom content
    let body = "## Summary\n\nThis is important.\n\n## Test Plan\n\n- [x] Unit tests"

    // First upsert
    graph.nodes[0].status = "running"
    graph.nodes[0].prUrl = "https://github.com/org/repo/pull/50"
    body = upsertDagSection(body, renderDagForGitHub(graph, "a"))

    expect(body).toContain("## Summary")
    expect(body).toContain("## Test Plan")
    expect(body).toContain("⚡ Running")

    // Second upsert after completion
    graph.nodes[0].status = "done"
    body = upsertDagSection(body, renderDagForGitHub(graph, "a"))

    expect(body).toContain("## Summary")
    expect(body).toContain("## Test Plan")
    expect(body).toContain("✅ Done")
    expect(body).not.toContain("⚡ Running")

    // Only one set of markers
    const markers = countMarkers(body)
    expect(markers.start).toBe(1)
    expect(markers.end).toBe(1)
  })

  it("handles concurrent node completions updating the same set of PRs", () => {
    const items: DagInput[] = [
      { id: "root", title: "Root", description: "R", dependsOn: [] },
      { id: "left", title: "Left", description: "L", dependsOn: ["root"] },
      { id: "right", title: "Right", description: "R", dependsOn: ["root"] },
    ]
    const graph = buildDag("concurrent", items, 1, "repo")
    const prBodies = new Map<string, string>()

    // Root done
    graph.nodes[0].status = "done"
    graph.nodes[0].prUrl = "https://github.com/org/repo/pull/60"
    prBodies.set("root", "Root PR body")
    advanceDag(graph)

    // Both left and right are running concurrently
    graph.nodes[1].status = "running"
    graph.nodes[2].status = "running"
    updateAllPRBodies(graph, prBodies)

    // Left finishes first
    graph.nodes[1].status = "done"
    graph.nodes[1].prUrl = "https://github.com/org/repo/pull/61"
    prBodies.set("left", "Left PR body")
    updateAllPRBodies(graph, prBodies)

    // Right finishes
    graph.nodes[2].status = "done"
    graph.nodes[2].prUrl = "https://github.com/org/repo/pull/62"
    prBodies.set("right", "Right PR body")
    updateAllPRBodies(graph, prBodies)

    // All 3 PRs show 3/3 complete
    for (const body of prBodies.values()) {
      expect(body).toContain("3/3 complete")
    }

    // Each highlights itself
    expect(prBodies.get("root")!).toContain("**Root** _(this PR)_")
    expect(prBodies.get("left")!).toContain("**Left** _(this PR)_")
    expect(prBodies.get("right")!).toContain("**Right** _(this PR)_")

    // No duplicated markers
    for (const body of prBodies.values()) {
      const markers = countMarkers(body)
      expect(markers.start).toBe(1)
      expect(markers.end).toBe(1)
    }
  })

  it("handles large DAG with many nodes", () => {
    const items: DagInput[] = [
      { id: "root", title: "Root", description: "R", dependsOn: [] },
    ]
    for (let i = 0; i < 10; i++) {
      items.push({
        id: `mid-${i}`,
        title: `Middle ${i}`,
        description: `M${i}`,
        dependsOn: ["root"],
      })
    }
    items.push({
      id: "final",
      title: "Final",
      description: "F",
      dependsOn: items.filter((i) => i.id.startsWith("mid-")).map((i) => i.id),
    })

    const graph = buildDag("large", items, 1, "repo")
    const prBodies = new Map<string, string>()

    // Complete root
    graph.nodes[0].status = "done"
    graph.nodes[0].prUrl = "https://github.com/org/repo/pull/100"
    prBodies.set("root", "Root PR")
    advanceDag(graph)

    // Complete all middle nodes
    for (let i = 0; i < 10; i++) {
      const node = graph.nodes.find((n) => n.id === `mid-${i}`)!
      node.status = "done"
      node.prUrl = `https://github.com/org/repo/pull/${101 + i}`
      prBodies.set(`mid-${i}`, `Middle ${i} PR`)
    }
    advanceDag(graph)

    // Complete final
    graph.nodes.find((n) => n.id === "final")!.status = "done"
    graph.nodes.find((n) => n.id === "final")!.prUrl = "https://github.com/org/repo/pull/111"
    prBodies.set("final", "Final PR")

    updateAllPRBodies(graph, prBodies)

    // All 12 PRs rendered correctly
    expect(prBodies.size).toBe(12)
    for (const body of prBodies.values()) {
      expect(body).toContain("12/12 complete")
      const markers = countMarkers(body)
      expect(markers.start).toBe(1)
      expect(markers.end).toBe(1)
    }

    // Final node has fan-in edges from all middle nodes
    const finalBody = prBodies.get("final")!
    for (let i = 0; i < 10; i++) {
      expect(finalBody).toContain(`mid-${i} --> final`)
    }
  })
})
