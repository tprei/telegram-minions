import { describe, it, expect, afterEach, beforeEach } from "vitest"
import fs from "node:fs"
import http from "node:http"
import {
  createTestHarness,
  resetHarnessState,
  type TestHarness,
} from "./harness.js"
import {
  simpleSuccess,
  withToolUse,
  failWithError,
  codingTask,
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

// ── Spawn and completion ──

describe("session spawn and completion", () => {
  it("spawns a session that emits events and completes", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess("All done"),
      timeoutMs: 15_000,
    })

    const result = await harness.runSession("Build a feature")

    expect(result.state).toBe("completed")
    expect(result.events.length).toBeGreaterThanOrEqual(2)
    expect(result.meta.sessionId).toMatch(/^test-session-/)
  }, 20_000)

  it("reports errored state when mock agent exits non-zero", async () => {
    harness = createTestHarness({
      scenario: failWithError("fatal crash"),
      timeoutMs: 15_000,
    })

    const result = await harness.runSession("Crash please")

    expect(result.state).toBe("errored")
    const errorEvents = result.events.filter((e) => e.type === "error")
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(errorEvents[0]).toMatchObject({ type: "error", error: "fatal crash" })
  }, 20_000)

  it("assigns monotonically increasing session IDs", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      timeoutMs: 15_000,
    })

    const r1 = await harness.runSession("Task 1")
    const r2 = await harness.runSession("Task 2")
    const r3 = await harness.runSession("Task 3")

    expect(r1.meta.sessionId).toBe("test-session-1")
    expect(r2.meta.sessionId).toBe("test-session-2")
    expect(r3.meta.sessionId).toBe("test-session-3")
  }, 30_000)
})

// ── Event streaming ──

describe("event streaming", () => {
  it("streams events in scenario order", async () => {
    const scenario = new ScenarioBuilder()
      .text("Step one")
      .text("Step two")
      .text("Step three")
      .done(300)
      .build()

    harness = createTestHarness({ scenario, timeoutMs: 15_000 })
    const result = await harness.runSession("Ordered steps")

    expect(result.state).toBe("completed")
    expect(result.events).toHaveLength(4)

    // Verify ordering: three text messages then complete
    const types = result.events.map((e) => e.type)
    expect(types).toEqual(["message", "message", "message", "complete"])
  }, 20_000)

  it("streams tool request and response events", async () => {
    harness = createTestHarness({
      scenario: withToolUse("Bash", { command: "ls" }, "file.txt", "Listed files."),
      timeoutMs: 15_000,
    })

    const result = await harness.runSession("List files")

    expect(result.state).toBe("completed")

    const toolRequests = result.events.filter(
      (e) => e.type === "message" && e.message.content.some((c) => c.type === "toolRequest"),
    )
    const toolResponses = result.events.filter(
      (e) => e.type === "message" && e.message.content.some((c) => c.type === "toolResponse"),
    )

    expect(toolRequests.length).toBe(1)
    expect(toolResponses.length).toBe(1)
  }, 20_000)

  it("includes token count in complete event", async () => {
    const scenario = new ScenarioBuilder()
      .text("Done")
      .done(1234)
      .build()

    harness = createTestHarness({ scenario, timeoutMs: 15_000 })
    const result = await harness.runSession("Count tokens")

    const completeEvent = result.events.find((e) => e.type === "complete")
    expect(completeEvent).toBeDefined()
    expect(completeEvent).toMatchObject({ type: "complete", total_tokens: 1234 })
  }, 20_000)

  it("streams notification events", async () => {
    const scenario = new ScenarioBuilder()
      .notify("github-mcp", "Fetching PR data...")
      .text("PR reviewed")
      .done(200)
      .build()

    harness = createTestHarness({ scenario, timeoutMs: 15_000 })
    const result = await harness.runSession("Review PR")

    const notifications = result.events.filter((e) => e.type === "notification")
    expect(notifications.length).toBe(1)
    expect(notifications[0]).toMatchObject({
      type: "notification",
      extensionId: "github-mcp",
      message: "Fetching PR data...",
    })
  }, 20_000)
})

// ── Workspace git setup ──

describe("workspace git setup", () => {
  it("creates a git repo with initial commit", () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      files: { "src/main.ts": "console.log('hello')\n" },
    })

    const log = harness.git("log --oneline")
    expect(log).toContain("initial commit")

    // Working tree should be clean after initial commit
    const status = harness.git("status --porcelain")
    expect(status).toBe("")
  })

  it("has a valid HEAD on main or master branch", () => {
    harness = createTestHarness({ scenario: simpleSuccess() })
    const branch = harness.git("rev-parse --abbrev-ref HEAD")
    expect(["main", "master"]).toContain(branch)
  })

  it("supports creating feature branches from initial commit", () => {
    harness = createTestHarness({ scenario: simpleSuccess() })

    harness.git("checkout -b minion/test-slug")
    const branch = harness.git("rev-parse --abbrev-ref HEAD")
    expect(branch).toBe("minion/test-slug")

    // The initial commit should be reachable
    const log = harness.git("log --oneline")
    expect(log).toContain("initial commit")
  })

  it("preserves seed files in git history", () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      files: {
        "package.json": '{"name":"test-repo"}\n',
        "src/index.ts": "export const x = 1\n",
      },
    })

    const tracked = harness.git("ls-files")
    expect(tracked).toContain("package.json")
    expect(tracked).toContain("src/index.ts")
    expect(tracked).toContain("README.md")
  })

  it("session cwd points to the mini-repo workspace", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      timeoutMs: 15_000,
    })

    const result = await harness.runSession("Check workspace")
    expect(result.meta.cwd).toBe(harness.workDir)

    // Verify the workspace has a .git directory
    expect(fs.existsSync(`${harness.workDir}/.git`)).toBe(true)
  }, 20_000)
})

// ── Session cleanup ──

describe("session cleanup", () => {
  it("creates .home directory during session for environment isolation", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      timeoutMs: 15_000,
    })

    await harness.runSession("Check isolation")

    // buildIsolatedEnv creates .home/ inside the workspace
    const homePath = `${harness.workDir}/.home`
    expect(fs.existsSync(homePath)).toBe(true)
  }, 20_000)

  it("creates .screenshots directory during session", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      timeoutMs: 15_000,
    })

    await harness.runSession("Check screenshots dir")

    const screenshotsPath = `${harness.workDir}/.screenshots`
    expect(fs.existsSync(screenshotsPath)).toBe(true)
  }, 20_000)

  it("cleanup removes all temp artifacts", () => {
    harness = createTestHarness({ scenario: simpleSuccess() })
    const workDir = harness.workDir
    const binDir = harness.mockAgent.binDir

    expect(fs.existsSync(workDir)).toBe(true)
    expect(fs.existsSync(binDir)).toBe(true)

    harness.cleanup()
    expect(fs.existsSync(workDir)).toBe(false)
    expect(fs.existsSync(binDir)).toBe(false)

    // Prevent double cleanup
    harness = undefined as unknown as TestHarness
  })
})

// ── Sequential sessions in same workspace ──

describe("sequential sessions", () => {
  it("runs multiple sessions in the same workspace", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess("First done"),
      timeoutMs: 15_000,
    })

    const r1 = await harness.runSession("First task")
    expect(r1.state).toBe("completed")

    harness.setScenario(simpleSuccess("Second done"))
    const r2 = await harness.runSession("Second task")
    expect(r2.state).toBe("completed")

    // Both used same workspace
    expect(r1.meta.cwd).toBe(r2.meta.cwd)
    expect(r1.meta.cwd).toBe(harness.workDir)
  }, 30_000)

  it("can switch from success to error scenario", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      timeoutMs: 15_000,
    })

    const r1 = await harness.runSession("Succeed")
    expect(r1.state).toBe("completed")

    harness.setScenario(failWithError("second fails"))
    const r2 = await harness.runSession("Fail")
    expect(r2.state).toBe("errored")
  }, 30_000)

  it("workspace files persist between sessions", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      timeoutMs: 15_000,
    })

    // Write a file before first session
    harness.writeFile("artifact.txt", "created by test")

    await harness.runSession("First session")

    // File should still exist for second session
    expect(harness.readFile("artifact.txt")).toBe("created by test")

    harness.setScenario(simpleSuccess())
    await harness.runSession("Second session")

    // File persists after second session
    expect(harness.readFile("artifact.txt")).toBe("created by test")
  }, 30_000)
})

// ── Mock agent callback inspection ──

describe("mock agent invocation", () => {
  it("mock agent receives scenario path via env", async () => {
    let invocation: { argv: string[]; cwd: string; env: Record<string, string> } | null = null

    // Start a callback server to capture invocation details
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
        timeoutMs: 15_000,
        callbackPort: port,
      })

      await harness.runSession("Inspect invocation")

      expect(invocation).not.toBeNull()
      expect(invocation!.env.MOCK_SCENARIO_PATH).toBeTruthy()
      expect(invocation!.cwd).toBe(harness.workDir)
    } finally {
      server.close()
    }
  }, 20_000)
})

// ── Multi-step coding scenario ──

describe("coding task simulation", () => {
  it("plays back a full coding scenario with tool use", async () => {
    harness = createTestHarness({
      scenario: codingTask({
        file: "src/widget.ts",
        content: "export class Widget {}",
        commitMessage: "feat: add widget",
      }),
      timeoutMs: 15_000,
    })

    const result = await harness.runSession("Create widget class")

    expect(result.state).toBe("completed")

    // Should have text messages, tool requests, tool responses, and complete
    const messageTypes = new Set<string>()
    for (const event of result.events) {
      if (event.type === "message") {
        for (const content of event.message.content) {
          messageTypes.add(content.type)
        }
      } else {
        messageTypes.add(event.type)
      }
    }

    expect(messageTypes.has("text")).toBe(true)
    expect(messageTypes.has("toolRequest")).toBe(true)
    expect(messageTypes.has("toolResponse")).toBe(true)
    expect(messageTypes.has("complete")).toBe(true)
  }, 20_000)
})
