import { describe, it, expect, afterEach, beforeEach } from "vitest"
import {
  createTestHarness,
  resetHarnessState,
  type TestHarness,
} from "./harness.js"
import {
  simpleSuccess,
  failWithError,
  codingTask,
  ScenarioBuilder,
  resetBuilderState,
} from "../mock-agent/index.js"
import {
  buildDag,
  buildLinearDag,
  advanceDag,
  failNode,
  resetFailedNode,
  readyNodes,
  isDagComplete,
  getUpstreamBranches,
  getDownstreamNodes,
  topologicalSort,
  dagProgress,
  renderDagStatus,
  type DagGraph,
  type DagInput,
} from "../../src/dag/dag.js"
import { buildDagChildPrompt } from "../../src/dag/dag-extract.js"

let harness: TestHarness

beforeEach(() => {
  resetHarnessState()
  resetBuilderState()
})

afterEach(() => {
  harness?.cleanup()
})

// ── DAG construction with mini-repo workspace ──

describe("DAG construction in workspace context", () => {
  it("builds a parallel DAG where all nodes start ready", () => {
    harness = createTestHarness({ scenario: simpleSuccess() })

    const items: DagInput[] = [
      { id: "api", title: "Add API routes", description: "Create REST endpoints", dependsOn: [] },
      { id: "ui", title: "Add UI components", description: "Create React components", dependsOn: [] },
      { id: "docs", title: "Write docs", description: "API documentation", dependsOn: [] },
    ]

    const graph = buildDag("test-dag", items, 1, "test/repo")
    expect(graph.nodes).toHaveLength(3)
    expect(readyNodes(graph)).toHaveLength(3)
    expect(graph.nodes.every((n) => n.status === "ready")).toBe(true)
  })

  it("builds a diamond DAG with correct dependency ordering", () => {
    harness = createTestHarness({ scenario: simpleSuccess() })

    const items: DagInput[] = [
      { id: "schema", title: "DB schema", description: "Create database schema", dependsOn: [] },
      { id: "api", title: "API layer", description: "REST endpoints", dependsOn: ["schema"] },
      { id: "auth", title: "Auth middleware", description: "JWT auth", dependsOn: ["schema"] },
      { id: "integration", title: "Integration tests", description: "E2E tests", dependsOn: ["api", "auth"] },
    ]

    const graph = buildDag("diamond-dag", items, 1, "test/repo")

    // Only schema should be ready initially
    expect(readyNodes(graph)).toHaveLength(1)
    expect(readyNodes(graph)[0].id).toBe("schema")

    // Topological sort should respect dependencies
    const sorted = topologicalSort(graph)
    const schemaIdx = sorted.indexOf("schema")
    const apiIdx = sorted.indexOf("api")
    const authIdx = sorted.indexOf("auth")
    const integrationIdx = sorted.indexOf("integration")

    expect(schemaIdx).toBeLessThan(apiIdx)
    expect(schemaIdx).toBeLessThan(authIdx)
    expect(apiIdx).toBeLessThan(integrationIdx)
    expect(authIdx).toBeLessThan(integrationIdx)
  })

  it("builds a linear stack DAG with sequential dependencies", () => {
    harness = createTestHarness({ scenario: simpleSuccess() })

    const graph = buildLinearDag(
      "stack-dag",
      [
        { title: "Types", description: "Define TypeScript types" },
        { title: "Services", description: "Implement service layer" },
        { title: "Tests", description: "Write test suite" },
      ],
      1,
      "test/repo",
    )

    expect(graph.nodes).toHaveLength(3)
    expect(graph.nodes[0].id).toBe("step-0")
    expect(graph.nodes[1].id).toBe("step-1")
    expect(graph.nodes[2].id).toBe("step-2")

    // Only first step should be ready
    expect(readyNodes(graph)).toHaveLength(1)
    expect(readyNodes(graph)[0].id).toBe("step-0")

    // Each step depends on previous
    expect(graph.nodes[1].dependsOn).toEqual(["step-0"])
    expect(graph.nodes[2].dependsOn).toEqual(["step-1"])
  })
})

// ── DAG advancement with session simulation ──

describe("DAG advancement with session simulation", () => {
  it("advances parallel nodes independently after each completes", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess("API done"),
      timeoutMs: 15_000,
    })

    const items: DagInput[] = [
      { id: "api", title: "API", description: "API routes", dependsOn: [] },
      { id: "ui", title: "UI", description: "Components", dependsOn: [] },
      { id: "e2e", title: "E2E", description: "Integration tests", dependsOn: ["api", "ui"] },
    ]

    const graph = buildDag("parallel-dag", items, 1, "test/repo")

    // Both api and ui are ready
    expect(readyNodes(graph)).toHaveLength(2)

    // Simulate: run session for "api" node
    const apiResult = await harness.runSession("Implement API routes")
    expect(apiResult.state).toBe("completed")

    // Mark api as done
    graph.nodes.find((n) => n.id === "api")!.status = "done"

    // e2e still pending (needs ui too)
    const newlyReady = advanceDag(graph)
    expect(newlyReady).toHaveLength(0)

    // Simulate: run session for "ui" node
    harness.setScenario(simpleSuccess("UI done"))
    const uiResult = await harness.runSession("Implement UI components")
    expect(uiResult.state).toBe("completed")

    // Mark ui as done
    graph.nodes.find((n) => n.id === "ui")!.status = "done"

    // Now e2e should become ready
    const readyAfterUi = advanceDag(graph)
    expect(readyAfterUi).toHaveLength(1)
    expect(readyAfterUi[0].id).toBe("e2e")

    // Run e2e session
    harness.setScenario(simpleSuccess("E2E done"))
    const e2eResult = await harness.runSession("Run integration tests")
    expect(e2eResult.state).toBe("completed")

    graph.nodes.find((n) => n.id === "e2e")!.status = "done"
    expect(isDagComplete(graph)).toBe(true)
  }, 60_000)

  it("advances linear stack nodes sequentially", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess("Step 0 done"),
      timeoutMs: 15_000,
    })

    const graph = buildLinearDag(
      "stack",
      [
        { title: "Schema", description: "DB migrations" },
        { title: "Models", description: "ORM models" },
        { title: "Routes", description: "API routes" },
      ],
      1,
      "test/repo",
    )

    // Only step-0 is ready
    expect(readyNodes(graph)).toHaveLength(1)
    expect(readyNodes(graph)[0].id).toBe("step-0")

    // Complete step-0
    const r0 = await harness.runSession("Create DB schema")
    expect(r0.state).toBe("completed")
    graph.nodes.find((n) => n.id === "step-0")!.status = "done"

    // step-1 becomes ready
    let ready = advanceDag(graph)
    expect(ready).toHaveLength(1)
    expect(ready[0].id).toBe("step-1")

    // Complete step-1
    harness.setScenario(simpleSuccess("Step 1 done"))
    const r1 = await harness.runSession("Create ORM models")
    expect(r1.state).toBe("completed")
    graph.nodes.find((n) => n.id === "step-1")!.status = "done"

    // step-2 becomes ready
    ready = advanceDag(graph)
    expect(ready).toHaveLength(1)
    expect(ready[0].id).toBe("step-2")

    // Complete step-2
    harness.setScenario(simpleSuccess("Step 2 done"))
    const r2 = await harness.runSession("Create API routes")
    expect(r2.state).toBe("completed")
    graph.nodes.find((n) => n.id === "step-2")!.status = "done"

    expect(isDagComplete(graph)).toBe(true)

    const progress = dagProgress(graph)
    expect(progress.done).toBe(3)
    expect(progress.total).toBe(3)
  }, 60_000)
})

// ── Failure cascading ──

describe("failure cascading in DAG", () => {
  it("skips transitive dependents when a node fails", async () => {
    harness = createTestHarness({
      scenario: failWithError("compilation failed"),
      timeoutMs: 15_000,
    })

    const items: DagInput[] = [
      { id: "types", title: "Types", description: "Type definitions", dependsOn: [] },
      { id: "service", title: "Service", description: "Service layer", dependsOn: ["types"] },
      { id: "handler", title: "Handler", description: "HTTP handlers", dependsOn: ["service"] },
      { id: "docs", title: "Docs", description: "Documentation", dependsOn: [] },
    ]

    const graph = buildDag("fail-dag", items, 1, "test/repo")

    // Simulate types node failing
    const result = await harness.runSession("Define types")
    expect(result.state).toBe("errored")

    const skipped = failNode(graph, "types")

    // Both service and handler should be skipped (transitive)
    expect(skipped).toContain("service")
    expect(skipped).toContain("handler")
    expect(skipped).not.toContain("docs")

    // Check statuses
    expect(graph.nodes.find((n) => n.id === "types")!.status).toBe("failed")
    expect(graph.nodes.find((n) => n.id === "service")!.status).toBe("skipped")
    expect(graph.nodes.find((n) => n.id === "handler")!.status).toBe("skipped")
    expect(graph.nodes.find((n) => n.id === "docs")!.status).toBe("ready")

    // Docs can still run independently
    harness.setScenario(simpleSuccess("Docs written"))
    const docsResult = await harness.runSession("Write documentation")
    expect(docsResult.state).toBe("completed")

    graph.nodes.find((n) => n.id === "docs")!.status = "done"

    // DAG is complete (done + failed + skipped)
    expect(isDagComplete(graph)).toBe(true)

    const progress = dagProgress(graph)
    expect(progress.done).toBe(1)
    expect(progress.failed).toBe(1)
    expect(progress.skipped).toBe(2)
  }, 30_000)

  it("failure in diamond fan-in skips only dependent branch", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      timeoutMs: 15_000,
    })

    const items: DagInput[] = [
      { id: "base", title: "Base", description: "Foundation", dependsOn: [] },
      { id: "left", title: "Left", description: "Left path", dependsOn: ["base"] },
      { id: "right", title: "Right", description: "Right path", dependsOn: ["base"] },
      { id: "merge", title: "Merge", description: "Fan-in", dependsOn: ["left", "right"] },
    ]

    const graph = buildDag("diamond-fail", items, 1, "test/repo")

    // Complete base
    graph.nodes.find((n) => n.id === "base")!.status = "done"
    advanceDag(graph)

    // Left fails
    const skipped = failNode(graph, "left")
    expect(skipped).toContain("merge")

    // Right still runs
    expect(graph.nodes.find((n) => n.id === "right")!.status).toBe("ready")

    // Complete right
    const rightResult = await harness.runSession("Right path work")
    expect(rightResult.state).toBe("completed")
    graph.nodes.find((n) => n.id === "right")!.status = "done"

    // Merge stays skipped even though right is done
    expect(graph.nodes.find((n) => n.id === "merge")!.status).toBe("skipped")
  }, 20_000)

  it("reset failed node un-skips dependents and allows retry", async () => {
    harness = createTestHarness({
      scenario: failWithError("timeout"),
      timeoutMs: 15_000,
    })

    const items: DagInput[] = [
      { id: "build", title: "Build", description: "Compile", dependsOn: [] },
      { id: "test", title: "Test", description: "Run tests", dependsOn: ["build"] },
      { id: "deploy", title: "Deploy", description: "Ship it", dependsOn: ["test"] },
    ]

    const graph = buildDag("retry-dag", items, 1, "test/repo")

    // Build fails
    const failResult = await harness.runSession("Build project")
    expect(failResult.state).toBe("errored")

    failNode(graph, "build")
    expect(graph.nodes.find((n) => n.id === "test")!.status).toBe("skipped")
    expect(graph.nodes.find((n) => n.id === "deploy")!.status).toBe("skipped")

    // Reset build for retry
    const unskipped = resetFailedNode(graph, "build")
    expect(unskipped).toContain("test")
    expect(unskipped).toContain("deploy")

    expect(graph.nodes.find((n) => n.id === "build")!.status).toBe("ready")
    expect(graph.nodes.find((n) => n.id === "test")!.status).toBe("pending")
    expect(graph.nodes.find((n) => n.id === "deploy")!.status).toBe("pending")

    // Retry build succeeds
    harness.setScenario(simpleSuccess("Build succeeded"))
    const retryResult = await harness.runSession("Retry build")
    expect(retryResult.state).toBe("completed")

    graph.nodes.find((n) => n.id === "build")!.status = "done"
    const newlyReady = advanceDag(graph)
    expect(newlyReady).toHaveLength(1)
    expect(newlyReady[0].id).toBe("test")
  }, 30_000)
})

// ── DAG child prompt generation ──

describe("DAG child prompt generation", () => {
  it("generates child prompt with upstream context for dependent node", () => {
    const conversation = [
      { role: "user" as const, text: "Build a REST API with auth" },
      { role: "assistant" as const, text: "I'll plan this as follows:\n1. DB schema\n2. Auth middleware\n3. API routes" },
    ]

    const allNodes: DagInput[] = [
      { id: "schema", title: "DB schema", description: "Create database migrations", dependsOn: [] },
      { id: "auth", title: "Auth middleware", description: "JWT authentication", dependsOn: ["schema"] },
      { id: "routes", title: "API routes", description: "REST endpoints", dependsOn: ["auth"] },
    ]

    const prompt = buildDagChildPrompt(
      conversation,
      allNodes[1], // auth node
      allNodes,
      ["minion/schema-branch"],
      false,
    )

    // Should include original request
    expect(prompt).toContain("Build a REST API with auth")
    // Should include assigned sub-task
    expect(prompt).toContain("Your assigned sub-task: Auth middleware")
    // Should include upstream context
    expect(prompt).toContain("DB schema")
    expect(prompt).toContain("already been completed")
    // Should include scope constraints (sibling nodes)
    expect(prompt).toContain("API routes")
    expect(prompt).toContain("Scope constraints")
    // Should include deliverable section
    expect(prompt).toContain("Deliverable")
    expect(prompt).toContain("pull request targeting `main`")
  })

  it("generates stack child prompt with PR target branch", () => {
    const conversation = [
      { role: "user" as const, text: "Implement feature incrementally" },
    ]

    const allNodes: DagInput[] = [
      { id: "step-0", title: "Types", description: "Type definitions", dependsOn: [] },
      { id: "step-1", title: "Implementation", description: "Core logic", dependsOn: ["step-0"] },
    ]

    const prompt = buildDagChildPrompt(
      conversation,
      allNodes[1],
      allNodes,
      ["minion/types-branch"],
      true, // isStack
    )

    // Stack child should target upstream branch, not main
    expect(prompt).toContain("PR target")
    expect(prompt).toContain("minion/types-branch")
    expect(prompt).toContain("stacked PR")
  })

  it("generates prompt with merge conflict instructions when conflicts exist", () => {
    const conversation = [
      { role: "user" as const, text: "Build feature" },
    ]

    const allNodes: DagInput[] = [
      { id: "a", title: "Task A", description: "First task", dependsOn: [] },
      { id: "b", title: "Task B", description: "Second task", dependsOn: [] },
      { id: "c", title: "Merge task", description: "Combines A and B", dependsOn: ["a", "b"] },
    ]

    const prompt = buildDagChildPrompt(
      conversation,
      allNodes[2],
      allNodes,
      ["minion/a-branch", "minion/b-branch"],
      false,
      ["src/shared.ts", "package.json"],
    )

    expect(prompt).toContain("Merge conflicts to resolve first")
    expect(prompt).toContain("src/shared.ts")
    expect(prompt).toContain("package.json")
  })

  it("generates prompt for root node with no upstream context", () => {
    const conversation = [
      { role: "user" as const, text: "Set up the project" },
    ]

    const allNodes: DagInput[] = [
      { id: "init", title: "Project init", description: "Initialize project", dependsOn: [] },
      { id: "config", title: "Config", description: "Add configuration", dependsOn: ["init"] },
    ]

    const prompt = buildDagChildPrompt(
      conversation,
      allNodes[0],
      allNodes,
      [],
      false,
    )

    // Root node: no upstream context section
    expect(prompt).not.toContain("Upstream context")
    // Should still have scope constraints
    expect(prompt).toContain("Scope constraints")
    expect(prompt).toContain("Config")
  })
})

// ── Multi-session workspace isolation in DAG context ──

describe("multi-session DAG workspace isolation", () => {
  it("parallel DAG children run in the same workspace sequentially", async () => {
    harness = createTestHarness({
      scenario: codingTask({ file: "src/api.ts", content: "export const api = true" }),
      files: { "package.json": '{"name":"test-project"}\n' },
      timeoutMs: 15_000,
    })

    const items: DagInput[] = [
      { id: "api", title: "API", description: "API routes", dependsOn: [] },
      { id: "ui", title: "UI", description: "Components", dependsOn: [] },
    ]

    const graph = buildDag("workspace-dag", items, 1, "test/repo")

    // Session 1: API task
    const r1 = await harness.runSession("Implement API")
    expect(r1.state).toBe("completed")
    expect(r1.meta.cwd).toBe(harness.workDir)

    // Session 2: UI task
    harness.setScenario(codingTask({ file: "src/ui.tsx", content: "export const UI = () => null" }))
    const r2 = await harness.runSession("Implement UI")
    expect(r2.state).toBe("completed")
    expect(r2.meta.cwd).toBe(harness.workDir)

    // Both sessions used the same workspace
    expect(r1.meta.cwd).toBe(r2.meta.cwd)

    // Workspace still has seed files
    expect(harness.readFile("package.json")).toBe('{"name":"test-project"}\n')
  }, 30_000)

  it("DAG child sessions get unique session IDs", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess("Child 1"),
      timeoutMs: 15_000,
    })

    const r1 = await harness.runSession("DAG child 1")
    harness.setScenario(simpleSuccess("Child 2"))
    const r2 = await harness.runSession("DAG child 2")
    harness.setScenario(simpleSuccess("Child 3"))
    const r3 = await harness.runSession("DAG child 3")

    expect(r1.meta.sessionId).toBe("test-session-1")
    expect(r2.meta.sessionId).toBe("test-session-2")
    expect(r3.meta.sessionId).toBe("test-session-3")
  }, 45_000)
})

// ── DAG graph queries ──

describe("DAG graph queries for orchestration", () => {
  it("getUpstreamBranches returns branches of completed dependencies", () => {
    const items: DagInput[] = [
      { id: "a", title: "A", description: "First", dependsOn: [] },
      { id: "b", title: "B", description: "Second", dependsOn: [] },
      { id: "c", title: "C", description: "Merge", dependsOn: ["a", "b"] },
    ]

    const graph = buildDag("upstream-test", items, 1, "test/repo")

    // Set branches on completed nodes
    graph.nodes.find((n) => n.id === "a")!.branch = "minion/node-a"
    graph.nodes.find((n) => n.id === "b")!.branch = "minion/node-b"

    const upstream = getUpstreamBranches(graph, "c")
    expect(upstream).toHaveLength(2)
    expect(upstream).toContain("minion/node-a")
    expect(upstream).toContain("minion/node-b")
  })

  it("getDownstreamNodes finds all transitive dependents", () => {
    const items: DagInput[] = [
      { id: "a", title: "A", description: "Root", dependsOn: [] },
      { id: "b", title: "B", description: "Mid", dependsOn: ["a"] },
      { id: "c", title: "C", description: "Leaf 1", dependsOn: ["b"] },
      { id: "d", title: "D", description: "Leaf 2", dependsOn: ["b"] },
      { id: "e", title: "E", description: "Independent", dependsOn: [] },
    ]

    const graph = buildDag("downstream-test", items, 1, "test/repo")

    const downstream = getDownstreamNodes(graph, "a")
    const downstreamIds = downstream.map((n) => n.id)

    expect(downstreamIds).toContain("b")
    expect(downstreamIds).toContain("c")
    expect(downstreamIds).toContain("d")
    expect(downstreamIds).not.toContain("e")
    expect(downstreamIds).not.toContain("a")
  })

  it("dagProgress tracks all status counts accurately", () => {
    const items: DagInput[] = [
      { id: "a", title: "A", description: "A", dependsOn: [] },
      { id: "b", title: "B", description: "B", dependsOn: ["a"] },
      { id: "c", title: "C", description: "C", dependsOn: ["a"] },
      { id: "d", title: "D", description: "D", dependsOn: ["b", "c"] },
    ]

    const graph = buildDag("progress-dag", items, 1, "test/repo")

    // Simulate mixed state
    graph.nodes.find((n) => n.id === "a")!.status = "done"
    graph.nodes.find((n) => n.id === "b")!.status = "running"
    graph.nodes.find((n) => n.id === "c")!.status = "failed"
    graph.nodes.find((n) => n.id === "d")!.status = "skipped"

    const progress = dagProgress(graph)
    expect(progress.total).toBe(4)
    expect(progress.done).toBe(1)
    expect(progress.running).toBe(1)
    expect(progress.failed).toBe(1)
    expect(progress.skipped).toBe(1)
    expect(progress.pending).toBe(0)
    expect(progress.ready).toBe(0)
  })
})

// ── DAG status rendering ──

describe("DAG status rendering", () => {
  it("renders DAG status with correct emoji indicators", () => {
    const items: DagInput[] = [
      { id: "a", title: "Setup", description: "Initial setup", dependsOn: [] },
      { id: "b", title: "Build", description: "Build step", dependsOn: ["a"] },
      { id: "c", title: "Deploy", description: "Deploy step", dependsOn: ["b"] },
    ]

    const graph = buildDag("render-dag", items, 1, "test/repo")
    graph.nodes.find((n) => n.id === "a")!.status = "done"
    graph.nodes.find((n) => n.id === "b")!.status = "running"

    const status = renderDagStatus(graph)

    expect(status).toContain("✅")
    expect(status).toContain("⚡")
    expect(status).toContain("⏳")
    expect(status).toContain("Setup")
    expect(status).toContain("Build")
    expect(status).toContain("Deploy")
    expect(status).toContain("1/3 complete")
  })

  it("renders stack status with stack title", () => {
    const graph = buildLinearDag(
      "stack-render",
      [
        { title: "Step A", description: "First" },
        { title: "Step B", description: "Second" },
      ],
      1,
      "test/repo",
    )

    const status = renderDagStatus(graph, true)
    expect(status).toContain("Stack Status")
  })

  it("renders DAG status with PR links", () => {
    const items: DagInput[] = [
      { id: "feat", title: "Feature", description: "New feature", dependsOn: [] },
    ]

    const graph = buildDag("pr-dag", items, 1, "test/repo")
    graph.nodes[0].status = "done"
    graph.nodes[0].prUrl = "https://github.com/org/repo/pull/42"

    const status = renderDagStatus(graph)
    expect(status).toContain("PR")
    expect(status).toContain("1/1 complete")
  })
})

// ── Complex DAG topology ──

describe("complex DAG topologies", () => {
  it("handles wide fan-out then fan-in pattern", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      timeoutMs: 15_000,
    })

    const items: DagInput[] = [
      { id: "setup", title: "Setup", description: "Project setup", dependsOn: [] },
      { id: "worker-1", title: "Worker 1", description: "Parallel worker 1", dependsOn: ["setup"] },
      { id: "worker-2", title: "Worker 2", description: "Parallel worker 2", dependsOn: ["setup"] },
      { id: "worker-3", title: "Worker 3", description: "Parallel worker 3", dependsOn: ["setup"] },
      { id: "collect", title: "Collect", description: "Aggregate results", dependsOn: ["worker-1", "worker-2", "worker-3"] },
    ]

    const graph = buildDag("fanout-dag", items, 1, "test/repo")

    // Phase 1: Setup
    expect(readyNodes(graph)).toHaveLength(1)
    graph.nodes.find((n) => n.id === "setup")!.status = "done"

    // Phase 2: All workers become ready
    const workers = advanceDag(graph)
    expect(workers).toHaveLength(3)
    expect(workers.map((n) => n.id).sort()).toEqual(["worker-1", "worker-2", "worker-3"])

    // Complete workers one by one
    for (const worker of ["worker-1", "worker-2", "worker-3"]) {
      graph.nodes.find((n) => n.id === worker)!.status = "done"

      if (worker !== "worker-3") {
        // Collect not yet ready
        const ready = advanceDag(graph)
        expect(ready).toHaveLength(0)
      }
    }

    // Phase 3: Collect becomes ready after all workers done
    const collectReady = advanceDag(graph)
    expect(collectReady).toHaveLength(1)
    expect(collectReady[0].id).toBe("collect")

    // Complete collect
    const collectResult = await harness.runSession("Aggregate results")
    expect(collectResult.state).toBe("completed")
    graph.nodes.find((n) => n.id === "collect")!.status = "done"

    expect(isDagComplete(graph)).toBe(true)
  }, 20_000)

  it("handles partial failure in fan-out — independent branches continue", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      timeoutMs: 15_000,
    })

    const items: DagInput[] = [
      { id: "setup", title: "Setup", description: "Init", dependsOn: [] },
      { id: "feat-a", title: "Feature A", description: "Path A", dependsOn: ["setup"] },
      { id: "feat-b", title: "Feature B", description: "Path B", dependsOn: ["setup"] },
      { id: "deploy-a", title: "Deploy A", description: "Deploy A", dependsOn: ["feat-a"] },
      { id: "deploy-b", title: "Deploy B", description: "Deploy B", dependsOn: ["feat-b"] },
    ]

    const graph = buildDag("partial-fail", items, 1, "test/repo")

    // Complete setup
    graph.nodes.find((n) => n.id === "setup")!.status = "done"
    advanceDag(graph)

    // feat-a fails
    const skipped = failNode(graph, "feat-a")
    expect(skipped).toContain("deploy-a")
    expect(skipped).not.toContain("deploy-b")
    expect(skipped).not.toContain("feat-b")

    // feat-b still runs independently
    expect(graph.nodes.find((n) => n.id === "feat-b")!.status).toBe("ready")

    const result = await harness.runSession("Feature B implementation")
    expect(result.state).toBe("completed")

    graph.nodes.find((n) => n.id === "feat-b")!.status = "done"
    const nextReady = advanceDag(graph)
    expect(nextReady).toHaveLength(1)
    expect(nextReady[0].id).toBe("deploy-b")
  }, 20_000)

  it("deep linear chain advances through all steps", () => {
    const graph = buildLinearDag(
      "deep-stack",
      Array.from({ length: 6 }, (_, i) => ({
        title: `Step ${i}`,
        description: `Step ${i} of deep chain`,
      })),
      1,
      "test/repo",
    )

    expect(graph.nodes).toHaveLength(6)
    expect(readyNodes(graph)).toHaveLength(1)

    // Walk through the entire chain
    for (let i = 0; i < 6; i++) {
      const nodeId = `step-${i}`
      expect(graph.nodes.find((n) => n.id === nodeId)!.status).toBe("ready")

      graph.nodes.find((n) => n.id === nodeId)!.status = "done"

      if (i < 5) {
        const ready = advanceDag(graph)
        expect(ready).toHaveLength(1)
        expect(ready[0].id).toBe(`step-${i + 1}`)
      }
    }

    expect(isDagComplete(graph)).toBe(true)
  })
})

// ── Error session integration with DAG state ──

describe("error session scenarios with DAG state", () => {
  it("errored session correctly maps to DAG node failure", async () => {
    harness = createTestHarness({
      scenario: failWithError("out of memory"),
      timeoutMs: 15_000,
    })

    const items: DagInput[] = [
      { id: "compile", title: "Compile", description: "Build step", dependsOn: [] },
      { id: "test", title: "Test", description: "Test step", dependsOn: ["compile"] },
    ]

    const graph = buildDag("error-dag", items, 1, "test/repo")

    // Run session that errors
    const result = await harness.runSession("Compile the project")
    expect(result.state).toBe("errored")

    // Verify error event is in the stream
    const errorEvents = result.events.filter((e) => e.type === "error")
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(errorEvents[0]).toMatchObject({ type: "error", error: "out of memory" })

    // Map to DAG state
    failNode(graph, "compile")
    expect(graph.nodes.find((n) => n.id === "compile")!.status).toBe("failed")
    expect(graph.nodes.find((n) => n.id === "test")!.status).toBe("skipped")
  }, 20_000)

  it("mixed success and error across parallel DAG nodes", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess("API implemented"),
      timeoutMs: 15_000,
    })

    const items: DagInput[] = [
      { id: "api", title: "API", description: "REST API", dependsOn: [] },
      { id: "worker", title: "Worker", description: "Background worker", dependsOn: [] },
      { id: "dashboard", title: "Dashboard", description: "Admin UI", dependsOn: ["api", "worker"] },
    ]

    const graph = buildDag("mixed-dag", items, 1, "test/repo")

    // API succeeds
    const apiResult = await harness.runSession("Build API")
    expect(apiResult.state).toBe("completed")
    graph.nodes.find((n) => n.id === "api")!.status = "done"

    // Worker fails
    harness.setScenario(failWithError("worker crashed"))
    const workerResult = await harness.runSession("Build worker")
    expect(workerResult.state).toBe("errored")

    const skipped = failNode(graph, "worker")
    expect(skipped).toContain("dashboard")

    // Dashboard is skipped because one dependency (worker) failed
    expect(graph.nodes.find((n) => n.id === "dashboard")!.status).toBe("skipped")

    // DAG is complete with partial failure
    expect(isDagComplete(graph)).toBe(true)

    const progress = dagProgress(graph)
    expect(progress.done).toBe(1)
    expect(progress.failed).toBe(1)
    expect(progress.skipped).toBe(1)
  }, 30_000)
})

// ── DAG with workspace git operations ──

describe("DAG with workspace git operations", () => {
  it("DAG children can create branches in the workspace", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      timeoutMs: 15_000,
      files: { "src/index.ts": "export const app = true\n" },
    })

    const items: DagInput[] = [
      { id: "feat", title: "Feature", description: "New feature", dependsOn: [] },
    ]

    const graph = buildDag("git-dag", items, 1, "test/repo")

    // Create a feature branch like a real DAG child would
    harness.git("checkout -b minion/feat-child")
    const branch = harness.git("rev-parse --abbrev-ref HEAD")
    expect(branch).toBe("minion/feat-child")

    // Record branch on node
    graph.nodes[0].branch = "minion/feat-child"

    // Run session on the branch
    const result = await harness.runSession("Implement feature")
    expect(result.state).toBe("completed")

    // Branch is still checked out
    const currentBranch = harness.git("rev-parse --abbrev-ref HEAD")
    expect(currentBranch).toBe("minion/feat-child")
  }, 20_000)

  it("stack children branch from previous node's branch", () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      files: { "README.md": "# Project\n" },
    })

    // Simulate stack: step-0 creates branch
    harness.git("checkout -b minion/step-0")
    harness.writeFile("src/types.ts", "export type Foo = string\n")
    harness.git("add -A")
    harness.git("commit -m 'feat: add types'")

    // step-1 branches from step-0
    harness.git("checkout -b minion/step-1")
    const parentCommit = harness.git("rev-parse HEAD")

    harness.writeFile("src/service.ts", "import { Foo } from './types'\n")
    harness.git("add -A")
    harness.git("commit -m 'feat: add service'")

    // step-1 includes step-0 changes
    const files = harness.git("ls-files")
    expect(files).toContain("src/types.ts")
    expect(files).toContain("src/service.ts")

    // The commit history includes step-0's commit
    const log = harness.git("log --oneline")
    expect(log).toContain("add types")
    expect(log).toContain("add service")
  })
})
