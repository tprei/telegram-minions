import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { SessionHandle, type SessionConfig } from "../src/session.js"
import type { SessionMeta, GooseStreamEvent } from "../src/types.js"

const codexConfig: SessionConfig["codex"] = {
  defaultModel: "o4-mini",
  execPath: "codex",
  approvalMode: "full-auto",
}

const baseConfig: SessionConfig = {
  goose: { provider: "test", model: "test" },
  claude: { planModel: "test", thinkModel: "test", reviewModel: "test" },
  codex: codexConfig,
  mcp: {
    browserEnabled: false,
    githubEnabled: false,
    context7Enabled: false,
    sentryEnabled: false,
    sentryOrgSlug: "",
    sentryProjectSlug: "",
    zaiEnabled: false,
  },
}

const baseMeta: SessionMeta = {
  sessionId: "test-codex",
  threadId: 1,
  topicName: "test-codex",
  repo: "test",
  cwd: "/tmp",
  startedAt: Date.now(),
  mode: "task",
}

function makeHandle(configOverrides?: Partial<SessionConfig>): SessionHandle {
  return new SessionHandle(
    baseMeta,
    () => {},
    () => {},
    60_000,
    300_000,
    { ...baseConfig, ...configOverrides },
  )
}

describe("SessionHandle.parseCodexLine", () => {
  it("translates assistant message events", () => {
    const events: GooseStreamEvent[] = []
    const handle = new SessionHandle(
      baseMeta,
      (e) => events.push(e),
      () => {},
      60_000,
      300_000,
      baseConfig,
    )

    const parseCodexLine = (handle as unknown as { parseCodexLine: (s: string) => void }).parseCodexLine.bind(handle)
    parseCodexLine(JSON.stringify({
      type: "item.completed",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello!" }],
      },
    }))

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("message")
    if (events[0].type === "message") {
      expect(events[0].message.content[0]).toEqual({ type: "text", text: "Hello!" })
    }
  })

  it("translates function_call events", () => {
    const events: GooseStreamEvent[] = []
    const handle = new SessionHandle(
      baseMeta,
      (e) => events.push(e),
      () => {},
      60_000,
      300_000,
      baseConfig,
    )

    const parseCodexLine = (handle as unknown as { parseCodexLine: (s: string) => void }).parseCodexLine.bind(handle)
    parseCodexLine(JSON.stringify({
      type: "item.completed",
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "bash",
        arguments: '{"command":"ls"}',
      },
    }))

    expect(events).toHaveLength(1)
    if (events[0].type === "message") {
      const block = events[0].message.content[0]
      if (block.type === "toolRequest") {
        expect(block.toolCall).toEqual({ name: "bash", arguments: { command: "ls" } })
      }
    }
  })

  it("translates done events and captures total tokens", () => {
    const meta = { ...baseMeta }
    const handle = new SessionHandle(
      meta,
      () => {},
      () => {},
      60_000,
      300_000,
      baseConfig,
    )

    const parseCodexLine = (handle as unknown as { parseCodexLine: (s: string) => void }).parseCodexLine.bind(handle)
    parseCodexLine(JSON.stringify({
      type: "done",
      usage: { input_tokens: 100, output_tokens: 50 },
    }))

    expect(meta.totalTokens).toBe(150)
  })

  it("ignores item.started events", () => {
    const events: GooseStreamEvent[] = []
    const handle = new SessionHandle(
      baseMeta,
      (e) => events.push(e),
      () => {},
      60_000,
      300_000,
      baseConfig,
    )

    const parseCodexLine = (handle as unknown as { parseCodexLine: (s: string) => void }).parseCodexLine.bind(handle)
    parseCodexLine(JSON.stringify({ type: "item.started", item: { type: "message" } }))

    expect(events).toHaveLength(0)
  })

  it("translates error events", () => {
    const events: GooseStreamEvent[] = []
    const handle = new SessionHandle(
      baseMeta,
      (e) => events.push(e),
      () => {},
      60_000,
      300_000,
      baseConfig,
    )

    const parseCodexLine = (handle as unknown as { parseCodexLine: (s: string) => void }).parseCodexLine.bind(handle)
    parseCodexLine(JSON.stringify({ type: "error", error: { message: "fail" } }))

    expect(events).toEqual([{ type: "error", error: "fail" }])
  })

  it("handles invalid JSON gracefully", () => {
    const events: GooseStreamEvent[] = []
    const handle = new SessionHandle(
      baseMeta,
      (e) => events.push(e),
      () => {},
      60_000,
      300_000,
      baseConfig,
    )

    const parseCodexLine = (handle as unknown as { parseCodexLine: (s: string) => void }).parseCodexLine.bind(handle)
    parseCodexLine("not valid json")

    expect(events).toHaveLength(0)
  })

  it("handles empty lines", () => {
    const events: GooseStreamEvent[] = []
    const handle = new SessionHandle(
      baseMeta,
      (e) => events.push(e),
      () => {},
      60_000,
      300_000,
      baseConfig,
    )

    const parseCodexLine = (handle as unknown as { parseCodexLine: (s: string) => void }).parseCodexLine.bind(handle)
    parseCodexLine("")

    expect(events).toHaveLength(0)
  })
})

describe("SessionHandle.startCodex", () => {
  it("throws when codex config is not provided", () => {
    const handle = new SessionHandle(
      baseMeta,
      () => {},
      () => {},
      60_000,
      300_000,
      { ...baseConfig, codex: undefined },
    )

    expect(() => handle.startCodex("test task")).toThrow("Codex config not provided")
  })

  it("spawns with correct command and args", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-test-"))
    const fakeCodex = path.join(tmpDir, "fake-codex")

    // Create a fake codex script that outputs a done event and exits
    fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const args = process.argv.slice(2);
// Write args to stderr for verification
process.stderr.write(JSON.stringify(args) + '\\n');
// Output a valid Codex done event
process.stdout.write(JSON.stringify({ type: "done", usage: { input_tokens: 10, output_tokens: 5 } }) + '\\n');
process.exit(0);
`)
    fs.chmodSync(fakeCodex, 0o755)

    const meta = { ...baseMeta, cwd: tmpDir }
    const events: GooseStreamEvent[] = []
    const donePromise = new Promise<{ meta: SessionMeta; state: string }>((resolve) => {
      const handle = new SessionHandle(
        meta,
        (e) => events.push(e),
        (m, state) => resolve({ meta: m, state }),
        60_000,
        300_000,
        {
          ...baseConfig,
          codex: { defaultModel: "o3", execPath: fakeCodex, approvalMode: "auto-edit" },
        },
      )
      handle.startCodex("do the thing")
    })

    const { meta: doneMeta, state } = await donePromise

    expect(state).toBe("completed")
    expect(doneMeta.totalTokens).toBe(15)

    // Should have a complete event
    const completeEvents = events.filter((e) => e.type === "complete")
    expect(completeEvents).toHaveLength(1)
    if (completeEvents[0].type === "complete") {
      expect(completeEvents[0].total_tokens).toBe(15)
    }

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("captures stderr spawn args including model and approval-mode", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-args-test-"))
    const fakeCodex = path.join(tmpDir, "fake-codex")

    fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
process.stderr.write(JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({ type: "done", usage: {} }) + '\\n');
process.exit(0);
`)
    fs.chmodSync(fakeCodex, 0o755)

    const meta = { ...baseMeta, cwd: tmpDir }
    const stderrChunks: string[] = []

    await new Promise<void>((resolve) => {
      const handle = new SessionHandle(
        meta,
        () => {},
        () => resolve(),
        60_000,
        300_000,
        {
          ...baseConfig,
          codex: { defaultModel: "o4-mini", execPath: fakeCodex, approvalMode: "full-auto" },
        },
      )
      handle.startCodex("my task")

      // Capture stderr from the spawned process
      const h = handle as unknown as { process: { stderr: NodeJS.ReadableStream } }
      h.process.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()))
    })

    const args = JSON.parse(stderrChunks.join(""))
    expect(args[0]).toBe("exec")
    expect(args).toContain("--model")
    const modelIdx = args.indexOf("--model")
    expect(args[modelIdx + 1]).toBe("o4-mini")
    expect(args).toContain("--approval-mode")
    const modeIdx = args.indexOf("--approval-mode")
    expect(args[modeIdx + 1]).toBe("full-auto")
    expect(args).toContain("--quiet")

    // Last arg should contain system prompt + task text
    const lastArg = args[args.length - 1]
    expect(lastArg).toContain("my task")

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("uses custom system prompt when provided", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-prompt-test-"))
    const fakeCodex = path.join(tmpDir, "fake-codex")

    fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
process.stderr.write(JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({ type: "done", usage: {} }) + '\\n');
process.exit(0);
`)
    fs.chmodSync(fakeCodex, 0o755)

    const meta = { ...baseMeta, cwd: tmpDir }
    const stderrChunks: string[] = []

    await new Promise<void>((resolve) => {
      const handle = new SessionHandle(
        meta,
        () => {},
        () => resolve(),
        60_000,
        300_000,
        {
          ...baseConfig,
          codex: { defaultModel: "o4-mini", execPath: fakeCodex, approvalMode: "full-auto" },
        },
      )
      handle.startCodex("build feature", "Custom system prompt here")

      const h = handle as unknown as { process: { stderr: NodeJS.ReadableStream } }
      h.process.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()))
    })

    const args = JSON.parse(stderrChunks.join(""))
    const lastArg = args[args.length - 1]
    expect(lastArg).toContain("Custom system prompt here")
    expect(lastArg).toContain("build feature")

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("uses default task prompt when no system prompt provided", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-default-prompt-"))
    const fakeCodex = path.join(tmpDir, "fake-codex")

    fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
process.stderr.write(JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({ type: "done", usage: {} }) + '\\n');
process.exit(0);
`)
    fs.chmodSync(fakeCodex, 0o755)

    const meta = { ...baseMeta, cwd: tmpDir }
    const stderrChunks: string[] = []

    await new Promise<void>((resolve) => {
      const handle = new SessionHandle(
        meta,
        () => {},
        () => resolve(),
        60_000,
        300_000,
        {
          ...baseConfig,
          codex: { defaultModel: "o4-mini", execPath: fakeCodex, approvalMode: "full-auto" },
        },
      )
      handle.startCodex("do work")

      const h = handle as unknown as { process: { stderr: NodeJS.ReadableStream } }
      h.process.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()))
    })

    const args = JSON.parse(stderrChunks.join(""))
    const lastArg = args[args.length - 1]
    // Should contain DEFAULT_TASK_PROMPT content (which includes "coding minion")
    expect(lastArg).toContain("coding minion")
    expect(lastArg).toContain("do work")

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("reports errored state on non-zero exit", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-error-test-"))
    const fakeCodex = path.join(tmpDir, "fake-codex")

    fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
process.stderr.write("fatal error\\n");
process.exit(1);
`)
    fs.chmodSync(fakeCodex, 0o755)

    const meta = { ...baseMeta, cwd: tmpDir }

    const result = await new Promise<{ state: string }>((resolve) => {
      const handle = new SessionHandle(
        meta,
        () => {},
        (m, state) => resolve({ state }),
        60_000,
        300_000,
        {
          ...baseConfig,
          codex: { defaultModel: "o4-mini", execPath: fakeCodex, approvalMode: "full-auto" },
        },
      )
      handle.startCodex("fail task")
    })

    expect(result.state).toBe("errored")

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("writes MCP TOML config when MCPs are enabled", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-test-"))
    const fakeCodex = path.join(tmpDir, "fake-codex")
    const originalGitHubToken = process.env["GITHUB_TOKEN"]

    fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
process.stderr.write(JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({ type: "done", usage: {} }) + '\\n');
process.exit(0);
`)
    fs.chmodSync(fakeCodex, 0o755)

    process.env["GITHUB_TOKEN"] = "ghp_test_mcp"

    const meta = { ...baseMeta, cwd: tmpDir }
    const stderrChunks: string[] = []

    await new Promise<void>((resolve) => {
      const handle = new SessionHandle(
        meta,
        () => {},
        () => resolve(),
        60_000,
        300_000,
        {
          ...baseConfig,
          codex: { defaultModel: "o4-mini", execPath: fakeCodex, approvalMode: "full-auto" },
          mcp: {
            ...baseConfig.mcp,
            githubEnabled: true,
          },
        },
      )
      handle.startCodex("task with mcp")

      const h = handle as unknown as { process: { stderr: NodeJS.ReadableStream } }
      h.process.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()))
    })

    const args = JSON.parse(stderrChunks.join(""))

    // Should have --config flag pointing to the TOML file
    const configIdx = args.indexOf("--config")
    expect(configIdx).toBeGreaterThan(-1)
    const configPath = args[configIdx + 1]
    expect(configPath).toContain(".codex")
    expect(configPath).toContain("config.toml")

    // Verify the TOML file exists and has github MCP
    expect(fs.existsSync(configPath)).toBe(true)
    const toml = fs.readFileSync(configPath, "utf-8")
    expect(toml).toContain("[mcp_servers.github]")
    expect(toml).toContain("github-mcp-server")

    if (originalGitHubToken !== undefined) {
      process.env["GITHUB_TOKEN"] = originalGitHubToken
    } else {
      delete process.env["GITHUB_TOKEN"]
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
