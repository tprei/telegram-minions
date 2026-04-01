import { describe, it, expect, afterEach, beforeEach } from "vitest"
import http from "node:http"
import {
  createTestHarness,
  resetHarnessState,
  type TestHarness,
} from "./harness.js"
import {
  simpleSuccess,
  ScenarioBuilder,
  resetBuilderState,
} from "../mock-agent/index.js"

let harness: TestHarness

beforeEach(() => {
  resetHarnessState()
  resetBuilderState()
})

afterEach(() => {
  harness?.cleanup()
})

// ── Plan mode session basics ──

describe("plan mode sessions", () => {
  it("completes a plan-mode session with events", async () => {
    const scenario = new ScenarioBuilder()
      .text("Here is my analysis of the codebase...")
      .text("I propose the following plan:\n1. Refactor module A\n2. Add tests")
      .done(800)
      .build()

    harness = createTestHarness({
      scenario,
      mode: "plan",
      timeoutMs: 15_000,
    })

    const result = await harness.runSession("Plan a refactoring of the auth module")

    expect(result.state).toBe("completed")
    expect(result.meta.mode).toBe("plan")
    // Note: event count not asserted because mock agent emits Goose-format
    // events which the Claude line parser doesn't translate. Session
    // completion state is the meaningful signal here.
  }, 20_000)

  it("plan session spawns claude binary (not goose)", async () => {
    let invocation: { argv: string[]; cwd: string; env: Record<string, string> } | null = null

    const server = http.createServer((req, res) => {
      let body = ""
      req.on("data", (chunk: Buffer) => { body += chunk.toString() })
      req.on("end", () => {
        invocation = JSON.parse(body)
        res.writeHead(200)
        res.end()
      })
    })

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as { port: number }).port

    try {
      harness = createTestHarness({
        scenario: simpleSuccess("Plan complete"),
        mode: "plan",
        timeoutMs: 15_000,
        callbackPort: port,
      })

      const result = await harness.runSession("Plan feature X")

      expect(result.state).toBe("completed")
      expect(invocation).not.toBeNull()

      // The mock binary is invoked — check that it was called as "claude"
      // (the argv[0] or script path should contain "claude" in the PATH resolution)
      // Since both binaries delegate to mock-agent.ts, we verify the args
      // contain claude-specific flags like --print and --disallowed-tools
      const args = invocation!.argv
      expect(args.some((a: string) => a === "--print")).toBe(true)
      expect(args.some((a: string) => a === "--disallowed-tools")).toBe(true)
    } finally {
      server.close()
    }
  }, 20_000)

  it("plan mode passes read-only disallowed tools", async () => {
    let invocation: { argv: string[] } | null = null

    const server = http.createServer((req, res) => {
      let body = ""
      req.on("data", (chunk: Buffer) => { body += chunk.toString() })
      req.on("end", () => {
        invocation = JSON.parse(body)
        res.writeHead(200)
        res.end()
      })
    })

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as { port: number }).port

    try {
      harness = createTestHarness({
        scenario: simpleSuccess(),
        mode: "plan",
        timeoutMs: 15_000,
        callbackPort: port,
      })

      await harness.runSession("Plan something")

      expect(invocation).not.toBeNull()
      const args = invocation!.argv

      // Plan mode disallows Edit, Write, NotebookEdit
      const disallowedIdx = args.indexOf("--disallowed-tools")
      expect(disallowedIdx).toBeGreaterThan(-1)

      const disallowed = args.slice(disallowedIdx + 1)
      expect(disallowed).toContain("Edit")
      expect(disallowed).toContain("Write")
      expect(disallowed).toContain("NotebookEdit")
    } finally {
      server.close()
    }
  }, 20_000)

  it("plan session meta includes correct mode", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      mode: "plan",
      timeoutMs: 15_000,
    })

    const result = await harness.runSession("Plan")
    expect(result.meta.mode).toBe("plan")
  }, 20_000)
})

// ── Task mode session (goose) ──

describe("task mode sessions", () => {
  it("task session spawns goose binary", async () => {
    let invocation: { argv: string[] } | null = null

    const server = http.createServer((req, res) => {
      let body = ""
      req.on("data", (chunk: Buffer) => { body += chunk.toString() })
      req.on("end", () => {
        invocation = JSON.parse(body)
        res.writeHead(200)
        res.end()
      })
    })

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as { port: number }).port

    try {
      harness = createTestHarness({
        scenario: simpleSuccess("Task done"),
        mode: "task",
        timeoutMs: 15_000,
        callbackPort: port,
      })

      const result = await harness.runSession("Do a task")

      expect(result.state).toBe("completed")
      expect(invocation).not.toBeNull()

      // Task mode uses goose — check for goose-specific args
      const args = invocation!.argv
      expect(args.some((a: string) => a === "run")).toBe(true)
      expect(args.some((a: string) => a === "--output-format")).toBe(true)
      expect(args.some((a: string) => a === "stream-json")).toBe(true)
    } finally {
      server.close()
    }
  }, 20_000)

  it("task session meta has correct mode", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      timeoutMs: 15_000,
    })

    const result = await harness.runSession("Default mode task")
    expect(result.meta.mode).toBe("task")
  }, 20_000)
})

// ── Plan → task respawn flow ──

describe("plan-to-task respawn flow", () => {
  it("runs plan session then task session in same workspace", async () => {
    const planScenario = new ScenarioBuilder()
      .text("After analysis, I recommend:\n1. Add retry logic to API client\n2. Add tests for retry")
      .done(600)
      .build()

    harness = createTestHarness({
      scenario: planScenario,
      mode: "plan",
      timeoutMs: 15_000,
    })

    // Phase 1: Plan session (read-only exploration)
    const planResult = await harness.runSession("Plan retry logic for API client")
    expect(planResult.state).toBe("completed")
    expect(planResult.meta.mode).toBe("plan")

    // Phase 2: Switch to task mode with execution scenario
    const taskScenario = new ScenarioBuilder()
      .text("Implementing retry logic...")
      .tool("Write", { file_path: "src/api-client.ts", content: "retry code" })
      .toolResult("tool_1", { success: true })
      .text("Retry logic implemented and tests added.")
      .done(2000)
      .build()

    harness.setScenario(taskScenario)

    // Run as task mode with custom system prompt (overrides plan mode)
    const taskResult = await harness.runSession(
      "Implement retry logic as planned:\n1. Add retry to API client\n2. Add tests",
      { mode: "task" },
    )

    expect(taskResult.state).toBe("completed")
    expect(taskResult.meta.mode).toBe("task")

    // Both sessions used the same workspace
    expect(planResult.meta.cwd).toBe(taskResult.meta.cwd)

    // Session IDs are different
    expect(planResult.meta.sessionId).not.toBe(taskResult.meta.sessionId)
  }, 30_000)

  it("plan feedback refines and re-runs plan session", async () => {
    // First plan attempt
    const plan1 = new ScenarioBuilder()
      .text("Plan v1: Rewrite the entire module from scratch")
      .done(400)
      .build()

    harness = createTestHarness({
      scenario: plan1,
      mode: "plan",
      timeoutMs: 15_000,
    })

    const r1 = await harness.runSession("Plan auth refactor")
    expect(r1.state).toBe("completed")

    // User gives feedback, agent refines plan
    const plan2 = new ScenarioBuilder()
      .text("Plan v2 (revised): Incrementally migrate auth, keeping backward compat")
      .done(500)
      .build()

    harness.setScenario(plan2)

    const r2 = await harness.runSession(
      "The plan is too aggressive. Keep backward compat and migrate incrementally.",
      { mode: "plan" },
    )

    expect(r2.state).toBe("completed")

    // Different session IDs for each plan iteration
    expect(r1.meta.sessionId).not.toBe(r2.meta.sessionId)
  }, 30_000)

  it("plan mode then execute preserves workspace state", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess("Plan done"),
      mode: "plan",
      files: { "src/existing.ts": "export const old = true\n" },
      timeoutMs: 15_000,
    })

    // Plan session runs
    await harness.runSession("Analyze existing code")

    // Workspace files from seed still exist
    expect(harness.readFile("src/existing.ts")).toBe("export const old = true\n")

    // Git state is intact
    const status = harness.git("status --porcelain")
    // May have .home/ and .screenshots/ from session, but seed files are committed
    const tracked = harness.git("ls-files")
    expect(tracked).toContain("src/existing.ts")
  }, 20_000)
})

// ── Think mode ──

describe("think mode sessions", () => {
  it("think mode session completes with correct meta", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess("Thinking about this..."),
      mode: "think",
      timeoutMs: 15_000,
    })

    const result = await harness.runSession("Think about architecture")
    expect(result.state).toBe("completed")
    expect(result.meta.mode).toBe("think")
  }, 20_000)

  it("think mode spawns claude with disallowed write tools", async () => {
    let invocation: { argv: string[] } | null = null

    const server = http.createServer((req, res) => {
      let body = ""
      req.on("data", (chunk: Buffer) => { body += chunk.toString() })
      req.on("end", () => {
        invocation = JSON.parse(body)
        res.writeHead(200)
        res.end()
      })
    })

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as { port: number }).port

    try {
      harness = createTestHarness({
        scenario: simpleSuccess(),
        mode: "think",
        timeoutMs: 15_000,
        callbackPort: port,
      })

      await harness.runSession("Think deeply")

      expect(invocation).not.toBeNull()
      const args = invocation!.argv

      // Think mode is Claude-based with disallowed tools
      expect(args).toContain("--print")
      expect(args).toContain("--disallowed-tools")
    } finally {
      server.close()
    }
  }, 20_000)
})

// ── Custom system prompt override ──

describe("custom system prompt", () => {
  it("custom system prompt routes to goose even for plan mode", async () => {
    let invocation: { argv: string[] } | null = null

    const server = http.createServer((req, res) => {
      let body = ""
      req.on("data", (chunk: Buffer) => { body += chunk.toString() })
      req.on("end", () => {
        invocation = JSON.parse(body)
        res.writeHead(200)
        res.end()
      })
    })

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as { port: number }).port

    try {
      harness = createTestHarness({
        scenario: simpleSuccess(),
        mode: "plan",
        timeoutMs: 15_000,
        callbackPort: port,
      })

      // Providing a custom systemPrompt overrides the claude mode config
      // and falls through to startGoose()
      await harness.runSession("Execute plan", {
        systemPrompt: "You are a task executor. Implement the plan.",
      })

      expect(invocation).not.toBeNull()
      const args = invocation!.argv

      // With custom systemPrompt, goose is used (has "run" arg, not "--print")
      expect(args.some((a: string) => a === "run")).toBe(true)
      expect(args.some((a: string) => a === "--system")).toBe(true)
    } finally {
      server.close()
    }
  }, 20_000)
})

// ── Thread ID handling ──

describe("thread ID handling", () => {
  it("passes thread ID through to session meta", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      timeoutMs: 15_000,
    })

    const result = await harness.runSession("Check thread", { threadId: 42 })
    expect(result.meta.threadId).toBe(42)
  }, 20_000)

  it("defaults thread ID to 1 when not specified", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      timeoutMs: 15_000,
    })

    const result = await harness.runSession("Default thread")
    expect(result.meta.threadId).toBe(1)
  }, 20_000)
})
