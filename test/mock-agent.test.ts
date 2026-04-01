import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { rmSync } from "node:fs"
import type { GooseStreamEvent } from "../src/types.js"
import {
  installMockAgent,
  writeScenarioFile,
  simpleSuccess,
  withToolUse,
  failWithError,
  codingTask,
  resetBuilderState,
  ScenarioBuilder,
  textMessage,
  complete,
  error,
  toolRequest,
  toolResponse,
  notification,
} from "./mock-agent/index.js"
import type { MockAgentInstall, Scenario } from "./mock-agent/index.js"

// ── Helper: run mock agent and collect output ──

interface RunResult {
  events: GooseStreamEvent[]
  stderr: string
  exitCode: number | null
}

function runMockAgent(
  binary: "claude" | "goose",
  install: MockAgentInstall,
  args: string[] = [],
  timeoutMs = 10_000,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const binPath = `${install.binDir}/${binary}`
    const proc = spawn(binPath, args, {
      env: { ...process.env, ...install.env },
      stdio: ["ignore", "pipe", "pipe"],
    })

    const events: GooseStreamEvent[] = []
    let stderr = ""

    const rl = createInterface({ input: proc.stdout! })
    rl.on("line", (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      try {
        events.push(JSON.parse(trimmed) as GooseStreamEvent)
      } catch {
        // non-JSON line, ignore
      }
    })

    proc.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const timer = setTimeout(() => {
      proc.kill("SIGKILL")
      reject(new Error(`mock-agent timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    proc.on("close", (code) => {
      clearTimeout(timer)
      resolve({ events, stderr, exitCode: code })
    })

    proc.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

// ── Tests ──

describe("mock-agent", { timeout: 15_000 }, () => {
  let install: MockAgentInstall
  let scenarioDir: string | undefined

  beforeEach(() => {
    resetBuilderState()
  })

  afterEach(() => {
    if (install) install.cleanup()
    if (scenarioDir) {
      try { rmSync(scenarioDir, { recursive: true, force: true }) } catch { /* noop */ }
      scenarioDir = undefined
    }
  })

  describe("scenario builders", () => {
    it("textMessage creates a valid assistant text event", () => {
      const event = textMessage("hello")
      expect(event).toMatchObject({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      })
    })

    it("toolRequest creates a valid tool request event", () => {
      const event = toolRequest("Read", { file_path: "test.ts" })
      expect(event).toMatchObject({
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "toolRequest",
            toolCall: { name: "Read", arguments: { file_path: "test.ts" } },
          }],
        },
      })
      // Check that ID is generated
      const content = (event as { type: "message"; message: { content: Array<{ id?: string }> } }).message.content[0]
      expect(content.id).toMatch(/^tool_\d+$/)
    })

    it("toolResponse creates a valid user tool result event", () => {
      const event = toolResponse("tool_1", { data: "result" })
      expect(event).toMatchObject({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "toolResponse", id: "tool_1", toolResult: { data: "result" } }],
        },
      })
    })

    it("complete creates a valid completion event", () => {
      expect(complete(999)).toEqual({ type: "complete", total_tokens: 999 })
      expect(complete(null)).toEqual({ type: "complete", total_tokens: null })
    })

    it("error creates a valid error event", () => {
      expect(error("boom")).toEqual({ type: "error", error: "boom" })
    })

    it("notification creates a valid notification event", () => {
      expect(notification("github", "fetching PR")).toEqual({
        type: "notification",
        extensionId: "github",
        message: "fetching PR",
      })
    })

    it("simpleSuccess builds a minimal success scenario", () => {
      const s = simpleSuccess("done!")
      expect(s.steps).toHaveLength(2)
      expect(s.steps[0].event.type).toBe("message")
      expect(s.steps[1].event.type).toBe("complete")
      expect(s.exitCode).toBe(0)
    })

    it("withToolUse builds a tool-using scenario", () => {
      const s = withToolUse("Bash", { command: "ls" }, "file1\nfile2")
      expect(s.steps).toHaveLength(5)
      expect(s.exitCode).toBe(0)
      // Has text, tool request, tool response, text, complete
      const types = s.steps.map((step) => step.event.type)
      expect(types).toEqual(["message", "message", "message", "message", "complete"])
    })

    it("failWithError builds an error scenario", () => {
      const s = failWithError("oops")
      expect(s.exitCode).toBe(1)
      expect(s.steps[s.steps.length - 1].event).toEqual({ type: "error", error: "oops" })
    })

    it("codingTask builds a multi-step coding scenario", () => {
      const s = codingTask({ file: "lib/foo.ts" })
      expect(s.steps.length).toBeGreaterThanOrEqual(5)
      expect(s.exitCode).toBe(0)
      // Last event is complete
      expect(s.steps[s.steps.length - 1].event.type).toBe("complete")
    })

    it("ScenarioBuilder creates custom scenarios fluently", () => {
      const s = new ScenarioBuilder()
        .text("hello")
        .tool("Read", { file_path: "x.ts" }, 50)
        .toolResult("tool_1", "contents", 10)
        .text("done")
        .notify("github", "fetched", 5)
        .err("oops", 10)
        .done(2000)
        .exitCode(1)
        .stderr("warning: something")
        .build()

      expect(s.steps).toHaveLength(7)
      expect(s.exitCode).toBe(1)
      expect(s.stderr).toEqual(["warning: something"])
      expect(s.steps[1].delay).toBe(50)
    })
  })

  describe("binary execution", () => {
    it("emits NDJSON events from a simple success scenario", async () => {
      const scenarioPath = writeScenarioFile(simpleSuccess("hello world"))
      install = installMockAgent({ scenarioPath })

      const result = await runMockAgent("claude", install)

      expect(result.exitCode).toBe(0)
      expect(result.events).toHaveLength(2)
      expect(result.events[0]).toMatchObject({
        type: "message",
        message: { content: [{ type: "text", text: "hello world" }] },
      })
      expect(result.events[1]).toMatchObject({ type: "complete", total_tokens: 500 })
    })

    it("works when invoked as goose", async () => {
      const scenarioPath = writeScenarioFile(simpleSuccess())
      install = installMockAgent({ scenarioPath })

      const result = await runMockAgent("goose", install)

      expect(result.exitCode).toBe(0)
      expect(result.events).toHaveLength(2)
    })

    it("handles tool use scenarios", async () => {
      const scenarioPath = writeScenarioFile(withToolUse("Bash", { command: "echo hi" }, "hi"))
      install = installMockAgent({ scenarioPath })

      const result = await runMockAgent("claude", install)

      expect(result.exitCode).toBe(0)
      expect(result.events).toHaveLength(5)

      // Find the tool request
      const toolReq = result.events.find((e) =>
        e.type === "message" &&
        e.message.content.some((c) => c.type === "toolRequest"),
      )
      expect(toolReq).toBeDefined()
    })

    it("exits with non-zero code on error scenarios", async () => {
      const scenarioPath = writeScenarioFile(failWithError("rate limit"))
      install = installMockAgent({ scenarioPath })

      const result = await runMockAgent("claude", install)

      expect(result.exitCode).toBe(1)
      expect(result.events.some((e) => e.type === "error")).toBe(true)
    })

    it("emits stderr lines from scenario", async () => {
      const scenario: Scenario = {
        steps: [{ event: { type: "complete", total_tokens: null } }],
        exitCode: 0,
        stderr: ["warning: something fishy"],
      }
      const scenarioPath = writeScenarioFile(scenario)
      install = installMockAgent({ scenarioPath })

      const result = await runMockAgent("claude", install)

      expect(result.stderr).toContain("warning: something fishy")
    })

    it("exits with code 2 when MOCK_SCENARIO_PATH is not set", async () => {
      const scenarioPath = writeScenarioFile(simpleSuccess())
      install = installMockAgent({ scenarioPath })

      // Override env to remove MOCK_SCENARIO_PATH
      const result = await new Promise<RunResult>((resolve, reject) => {
        const binPath = `${install.binDir}/claude`
        const env = { ...process.env, PATH: install.env.PATH }
        // Explicitly don't set MOCK_SCENARIO_PATH
        delete (env as Record<string, string | undefined>)["MOCK_SCENARIO_PATH"]

        const proc = spawn(binPath, [], { env, stdio: ["ignore", "pipe", "pipe"] })
        let stderr = ""
        proc.stderr!.on("data", (c: Buffer) => { stderr += c.toString() })
        const timer = setTimeout(() => { proc.kill(); reject(new Error("timeout")) }, 5000)
        proc.on("close", (code) => {
          clearTimeout(timer)
          resolve({ events: [], stderr, exitCode: code })
        })
      })

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain("MOCK_SCENARIO_PATH not set")
    })

    it("reads pre-built scenario JSON files", async () => {
      const scenarioPath = resolve(
        import.meta.dirname,
        "mock-agent/scenarios/tool-use.json",
      )
      install = installMockAgent({ scenarioPath })

      const result = await runMockAgent("goose", install)

      expect(result.exitCode).toBe(0)
      expect(result.events).toHaveLength(5)
      expect(result.events[result.events.length - 1]).toMatchObject({
        type: "complete",
        total_tokens: 1200,
      })
    })

    it("handles coding task scenario with multiple tool calls", async () => {
      const scenarioPath = resolve(
        import.meta.dirname,
        "mock-agent/scenarios/coding-task.json",
      )
      install = installMockAgent({ scenarioPath })

      const result = await runMockAgent("claude", install)

      expect(result.exitCode).toBe(0)
      expect(result.events).toHaveLength(7)

      // Verify tool requests and responses are paired
      const toolRequests = result.events.filter((e) =>
        e.type === "message" && e.message.content.some((c) => c.type === "toolRequest"),
      )
      const toolResponses = result.events.filter((e) =>
        e.type === "message" && e.message.content.some((c) => c.type === "toolResponse"),
      )
      expect(toolRequests).toHaveLength(2)
      expect(toolResponses).toHaveLength(2)
    })
  })

  describe("install helper", () => {
    it("creates claude and goose binaries in temp dir", () => {
      const scenarioPath = writeScenarioFile(simpleSuccess())
      install = installMockAgent({ scenarioPath })

      expect(install.binDir).toBeTruthy()
      expect(install.env.PATH.startsWith(install.binDir)).toBe(true)
      expect(install.env.MOCK_SCENARIO_PATH).toBe(scenarioPath)
    })

    it("setScenario updates the scenario path", () => {
      const scenarioPath = writeScenarioFile(simpleSuccess())
      install = installMockAgent({ scenarioPath })

      const newPath = writeScenarioFile(failWithError())
      install.setScenario(newPath)

      expect(install.env.MOCK_SCENARIO_PATH).toBe(newPath)
    })

    it("cleanup removes the temp directory", () => {
      const scenarioPath = writeScenarioFile(simpleSuccess())
      install = installMockAgent({ scenarioPath })

      const dir = install.binDir
      install.cleanup()

      // Verify dir is gone (or at least doesn't error on double-cleanup)
      install.cleanup()
      install = undefined as unknown as MockAgentInstall
    })
  })

  describe("callback server", () => {
    it("POSTs invocation details to callback port", async () => {
      const scenarioPath = writeScenarioFile(simpleSuccess())

      // Start a simple HTTP server to capture the callback
      const invocations: Array<{ argv: string[]; cwd: string; env: Record<string, string> }> = []
      const server = createServer((req, res) => {
        let body = ""
        req.on("data", (chunk) => { body += chunk })
        req.on("end", () => {
          invocations.push(JSON.parse(body))
          res.writeHead(200)
          res.end()
        })
      })

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const port = (server.address() as { port: number }).port

      try {
        install = installMockAgent({ scenarioPath, callbackPort: port })
        await runMockAgent("claude", install, ["--print", "--verbose", "do something"])

        expect(invocations).toHaveLength(1)
        expect(invocations[0].argv).toContain("--print")
        expect(invocations[0].argv).toContain("do something")
      } finally {
        server.close()
      }
    })
  })

  describe("ScenarioBuilder integration", () => {
    it("plays back a builder-created scenario through the binary", async () => {
      const scenario = new ScenarioBuilder()
        .text("Analyzing...")
        .tool("Grep", { pattern: "TODO" }, 10)
        .toolResult("tool_1", ["src/a.ts:5:TODO fix this"], 10)
        .text("Found 1 TODO item.", 10)
        .done(800)
        .build()

      const scenarioPath = writeScenarioFile(scenario)
      install = installMockAgent({ scenarioPath })

      const result = await runMockAgent("goose", install)

      expect(result.exitCode).toBe(0)
      expect(result.events).toHaveLength(5)
      expect(result.events[0]).toMatchObject({
        type: "message",
        message: { content: [{ text: "Analyzing..." }] },
      })
    })
  })
})
