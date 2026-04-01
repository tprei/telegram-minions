import { describe, it, expect, afterEach, beforeEach } from "vitest"
import fs from "node:fs"
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

describe("createTestHarness", () => {
  it("creates an isolated git repo with initial commit", () => {
    harness = createTestHarness({ scenario: simpleSuccess() })

    expect(fs.existsSync(harness.workDir)).toBe(true)

    const log = harness.git("log --oneline")
    expect(log).toContain("initial commit")

    expect(fs.existsSync(`${harness.workDir}/README.md`)).toBe(true)
  })

  it("seeds files into the mini-repo", () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      files: {
        "src/index.ts": 'export const x = 1\n',
        "package.json": '{"name": "test"}\n',
      },
    })

    expect(harness.readFile("src/index.ts")).toBe('export const x = 1\n')
    expect(harness.readFile("package.json")).toBe('{"name": "test"}\n')

    // Files should be committed
    const status = harness.git("status --porcelain")
    expect(status).toBe("")
  })

  it("can create a non-git workspace", () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      initGit: false,
      files: { "hello.txt": "world" },
    })

    expect(harness.readFile("hello.txt")).toBe("world")
    expect(fs.existsSync(`${harness.workDir}/.git`)).toBe(false)
  })

  it("provides a FakeTelegram instance", () => {
    harness = createTestHarness({ scenario: simpleSuccess() })
    expect(harness.telegram).toBeDefined()
    expect(typeof harness.telegram.sendMessage).toBe("function")
  })

  it("provides mock agent install with PATH override", () => {
    harness = createTestHarness({ scenario: simpleSuccess() })
    expect(harness.mockAgent.binDir).toBeTruthy()
    expect(harness.mockAgent.env.PATH).toContain(harness.mockAgent.binDir)
  })
})

describe("harness.writeFile / readFile", () => {
  it("writes and reads files in the mini-repo", () => {
    harness = createTestHarness({ scenario: simpleSuccess() })
    harness.writeFile("src/new.ts", "export const y = 2")
    expect(harness.readFile("src/new.ts")).toBe("export const y = 2")
  })

  it("creates nested directories as needed", () => {
    harness = createTestHarness({ scenario: simpleSuccess() })
    harness.writeFile("deep/nested/dir/file.txt", "content")
    expect(harness.readFile("deep/nested/dir/file.txt")).toBe("content")
  })
})

describe("harness.git", () => {
  it("runs git commands in the mini-repo", () => {
    harness = createTestHarness({ scenario: simpleSuccess() })
    const branch = harness.git("rev-parse --abbrev-ref HEAD")
    expect(["main", "master"]).toContain(branch)
  })

  it("can create branches and commits", () => {
    harness = createTestHarness({ scenario: simpleSuccess() })
    harness.git("checkout -b feature/test")
    harness.writeFile("feature.ts", "export const f = true")
    harness.git("add -A")
    harness.git('commit -m "add feature"')

    const log = harness.git("log --oneline")
    expect(log).toContain("add feature")
  })
})

describe("harness.setScenario", () => {
  it("switches the mock agent scenario", () => {
    harness = createTestHarness({ scenario: simpleSuccess() })

    // Verify the scenario file exists and has content
    const before = fs.readFileSync(harness.scenarioPath, "utf-8")
    expect(before).toContain('"complete"')

    harness.setScenario(failWithError("new error"))
    const after = fs.readFileSync(harness.scenarioPath, "utf-8")
    expect(after).toContain("new error")
  })
})

describe("harness.runSession", () => {
  it("runs a simple success scenario to completion", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess("Hello from mock"),
      timeoutMs: 15_000,
    })

    const result = await harness.runSession("Do something")

    expect(result.state).toBe("completed")
    expect(result.events.length).toBeGreaterThanOrEqual(2)

    const textEvents = result.events.filter(
      (e) => e.type === "message" && e.message.content.some(
        (c) => c.type === "text" && c.text.includes("Hello from mock"),
      ),
    )
    expect(textEvents.length).toBeGreaterThan(0)

    const completeEvents = result.events.filter((e) => e.type === "complete")
    expect(completeEvents.length).toBe(1)
  }, 20_000)

  it("runs a tool-use scenario", async () => {
    harness = createTestHarness({
      scenario: withToolUse("Bash", { command: "echo hi" }, "hi"),
      timeoutMs: 15_000,
    })

    const result = await harness.runSession("Run a command")

    expect(result.state).toBe("completed")

    const toolEvents = result.events.filter(
      (e) => e.type === "message" && e.message.content.some(
        (c) => c.type === "toolRequest",
      ),
    )
    expect(toolEvents.length).toBeGreaterThan(0)
  }, 20_000)

  it("captures error scenarios", async () => {
    harness = createTestHarness({
      scenario: failWithError("boom"),
      timeoutMs: 15_000,
    })

    const result = await harness.runSession("Fail please")

    expect(result.state).toBe("errored")

    const errorEvents = result.events.filter((e) => e.type === "error")
    expect(errorEvents.length).toBeGreaterThan(0)
  }, 20_000)

  it("runs a coding task scenario", async () => {
    harness = createTestHarness({
      scenario: codingTask({ file: "src/app.ts", content: "console.log('hi')" }),
      timeoutMs: 15_000,
    })

    const result = await harness.runSession("Write some code")

    expect(result.state).toBe("completed")
    expect(result.events.length).toBeGreaterThanOrEqual(4)
  }, 20_000)

  it("can switch scenarios between runs", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess("first run"),
      timeoutMs: 15_000,
    })

    const first = await harness.runSession("First task")
    expect(first.state).toBe("completed")

    harness.setScenario(failWithError("second run fails"))
    const second = await harness.runSession("Second task")
    expect(second.state).toBe("errored")
  }, 30_000)

  it("uses ScenarioBuilder for custom scenarios", async () => {
    const scenario = new ScenarioBuilder()
      .text("Analyzing...")
      .text("Done analyzing.")
      .done(100)
      .build()

    harness = createTestHarness({ scenario, timeoutMs: 15_000 })

    const result = await harness.runSession("Analyze this")

    expect(result.state).toBe("completed")
    expect(result.events.length).toBe(3)
  }, 20_000)

  it("assigns unique session IDs per run", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      timeoutMs: 15_000,
    })

    const r1 = await harness.runSession("Task 1")
    const r2 = await harness.runSession("Task 2")

    expect(r1.meta.sessionId).not.toBe(r2.meta.sessionId)
  }, 30_000)

  it("sets cwd to the mini-repo workspace", async () => {
    harness = createTestHarness({
      scenario: simpleSuccess(),
      timeoutMs: 15_000,
    })

    const result = await harness.runSession("Check cwd")
    expect(result.meta.cwd).toBe(harness.workDir)
  }, 20_000)
})

describe("harness.cleanup", () => {
  it("removes temp directories", () => {
    harness = createTestHarness({ scenario: simpleSuccess() })
    const workDir = harness.workDir
    expect(fs.existsSync(workDir)).toBe(true)

    harness.cleanup()
    expect(fs.existsSync(workDir)).toBe(false)

    // Prevent afterEach from double-cleaning
    harness = undefined as unknown as TestHarness
  })
})
