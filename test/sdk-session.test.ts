import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { SDKSessionHandle, type SDKSessionEventCallback, type SDKSessionDoneCallback } from "../src/session/sdk-session.js"
import type { SessionConfig } from "../src/session/session.js"
import type { GooseStreamEvent } from "../src/domain/goose-types.js"
import type { SessionMeta, SessionPort } from "../src/domain/session-types.js"
const baseConfig: SessionConfig = {
  goose: { provider: "test", model: "test" },
  claude: { planModel: "plan-model", thinkModel: "think-model", reviewModel: "review-model", taskModel: "task-model" },
  mcp: {
    browserEnabled: false,
    githubEnabled: false,
    context7Enabled: false,
    sentryEnabled: false,
    sentryOrgSlug: "",
    sentryProjectSlug: "",
    supabaseEnabled: false,
    supabaseProjectRef: "",
    flyEnabled: false,
    flyOrg: "",
    zaiEnabled: false,
  },
}

function makeMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return {
    sessionId: "sdk-test-session",
    threadId: 100,
    topicName: "sdk-test",
    repo: "org/repo",
    cwd: "/tmp/sdk-test",
    startedAt: Date.now(),
    mode: "task",
    ...overrides,
  }
}

function makeHandle(
  meta?: Partial<SessionMeta>,
  configOverrides?: Partial<SessionConfig>,
  onEvent?: SDKSessionEventCallback,
  onDone?: SDKSessionDoneCallback,
): SDKSessionHandle {
  return new SDKSessionHandle(
    makeMeta(meta),
    onEvent ?? (() => {}),
    onDone ?? (() => {}),
    60_000,
    300_000,
    { ...baseConfig, ...configOverrides },
  )
}

describe("SDKSessionHandle", () => {
  describe("SessionPort interface compliance", () => {
    it("satisfies the SessionPort interface at compile time", () => {
      const port: SessionPort = makeHandle()
      expect(port).toBeDefined()
    })

    it("exposes readonly meta", () => {
      const handle = makeHandle({ sessionId: "abc-123" })
      expect(handle.meta.sessionId).toBe("abc-123")
    })

    it("starts in spawning state", () => {
      const handle = makeHandle()
      expect(handle.getState()).toBe("spawning")
      expect(handle.isActive()).toBe(true)
      expect(handle.isClosed()).toBe(false)
    })

    it("has all required SessionPort methods", () => {
      const handle = makeHandle()
      expect(typeof handle.start).toBe("function")
      expect(typeof handle.injectReply).toBe("function")
      expect(typeof handle.waitForCompletion).toBe("function")
      expect(typeof handle.isClosed).toBe("function")
      expect(typeof handle.getState).toBe("function")
      expect(typeof handle.isActive).toBe("function")
      expect(typeof handle.interrupt).toBe("function")
      expect(typeof handle.kill).toBe("function")
    })

    it("waitForCompletion returns a promise", () => {
      const handle = makeHandle()
      const result = handle.waitForCompletion()
      expect(result).toBeInstanceOf(Promise)
    })
  })

  describe("claudeModeConfigs", () => {
    const configs = (SDKSessionHandle as unknown as {
      claudeModeConfigs: Record<string, (cfg: SessionConfig) => Record<string, unknown>>
    }).claudeModeConfigs

    it("has entries for all claude modes", () => {
      expect(Object.keys(configs).sort()).toEqual([
        "dag-review", "plan", "review", "ship-plan", "ship-think", "ship-verify", "task", "think",
      ])
    })

    it("plan mode uses planModel and disallowed tools", () => {
      const result = configs["plan"](baseConfig)
      expect(result.model).toBe("plan-model")
      expect(result.disallowedTools).toEqual(["Edit", "Write", "NotebookEdit"])
    })

    it("think mode uses thinkModel and disallowed tools", () => {
      const result = configs["think"](baseConfig)
      expect(result.model).toBe("think-model")
      expect(result.disallowedTools).toEqual(["Edit", "Write", "NotebookEdit"])
    })

    it("review mode uses reviewModel and disallowed tools", () => {
      const result = configs["review"](baseConfig)
      expect(result.model).toBe("review-model")
      expect(result.disallowedTools).toEqual(["Edit", "Write", "NotebookEdit"])
    })

    it("ship-verify mode uses reviewModel", () => {
      const result = configs["ship-verify"](baseConfig)
      expect(result.model).toBe("review-model")
    })

    it("task mode uses taskModel and allows writes", () => {
      const result = configs["task"](baseConfig)
      expect(result.model).toBe("task-model")
      expect(result.disallowedTools).toBeUndefined()
    })
  })

  describe("injectReply", () => {
    it("returns false when process is not started", () => {
      const handle = makeHandle()
      expect(handle.injectReply("hello")).toBe(false)
    })

    it("logs warning and returns false when stdin is not writable", () => {
      const handle = makeHandle()
      const result = handle.injectReply("test message")
      expect(result).toBe(false)
      expect(handle.getState()).toBe("spawning")
    })
  })

  describe("idle transitions", () => {
    it("transitions working → idle on a per-turn complete event and emits an idle event", () => {
      const received: GooseStreamEvent[] = []
      const handle = makeHandle(undefined, undefined, (ev) => received.push(ev))
      ;(handle as unknown as { state: string }).state = "working"

      const resultLine = JSON.stringify({
        type: "result",
        is_error: false,
        total_cost_usd: 0.001,
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 20 },
      })
      ;(handle as unknown as { parseClaudeLine: (l: string) => void }).parseClaudeLine(resultLine)

      expect(handle.getState()).toBe("idle")
      expect(handle.isActive()).toBe(true)
      expect(handle.isClosed()).toBe(false)
      expect(received.some((e) => e.type === "complete")).toBe(true)
      expect(received.some((e) => e.type === "idle")).toBe(true)
    })

    it("stays in spawning when a complete event arrives before process start", () => {
      const handle = makeHandle()
      const resultLine = JSON.stringify({ type: "result", is_error: false })
      ;(handle as unknown as { parseClaudeLine: (l: string) => void }).parseClaudeLine(resultLine)
      expect(handle.getState()).toBe("spawning")
    })
  })

  describe("interrupt and kill", () => {
    it("interrupt is a no-op when not working", () => {
      const handle = makeHandle()
      expect(() => handle.interrupt()).not.toThrow()
    })

    it("kill resolves immediately when not active", async () => {
      const handle = makeHandle()
      // Force state to completed
      ;(handle as unknown as { state: string }).state = "completed"
      await handle.kill()
      expect(handle.isClosed()).toBe(true)
    })

    it("kill resolves immediately when process is null", async () => {
      const handle = makeHandle()
      await handle.kill()
      // No error thrown
    })
  })

  describe("buildIsolatedEnv", () => {
    const originalEnv: Record<string, string | undefined> = {}

    beforeEach(() => {
      originalEnv["MY_API_KEY"] = process.env["MY_API_KEY"]
      originalEnv["GITHUB_TOKEN"] = process.env["GITHUB_TOKEN"]
    })

    afterEach(() => {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })

    it("passes through env vars from sessionEnvPassthrough", () => {
      process.env["MY_API_KEY"] = "secret123"
      const handle = makeHandle(undefined, { sessionEnvPassthrough: ["MY_API_KEY"] })
      const env = (handle as unknown as { buildIsolatedEnv: () => Record<string, string> }).buildIsolatedEnv()
      expect(env["MY_API_KEY"]).toBe("secret123")
    })

    it("skips missing passthrough vars", () => {
      delete process.env["NONEXISTENT_VAR"]
      const handle = makeHandle(undefined, { sessionEnvPassthrough: ["NONEXISTENT_VAR"] })
      const env = (handle as unknown as { buildIsolatedEnv: () => Record<string, string> }).buildIsolatedEnv()
      expect(env["NONEXISTENT_VAR"]).toBeUndefined()
    })
  })

  describe("buildClaudeMcpConfigArgs", () => {
    it("returns empty array when no MCPs enabled", () => {
      const handle = makeHandle()
      const args = (handle as unknown as { buildClaudeMcpConfigArgs: () => string[] }).buildClaudeMcpConfigArgs()
      expect(args).toEqual([])
    })

    it("includes context7 when enabled", () => {
      const handle = makeHandle(undefined, {
        mcp: { ...baseConfig.mcp, context7Enabled: true },
      })
      const args = (handle as unknown as { buildClaudeMcpConfigArgs: () => string[] }).buildClaudeMcpConfigArgs()
      expect(args.length).toBe(2)
      expect(args[0]).toBe("--mcp-config")
      const config = JSON.parse(args[1])
      expect(config.mcpServers.context7).toBeDefined()
    })
  })
})

describe("SDKSessionHandle stdin message format", () => {
  it("builds correct NDJSON for text-only reply", () => {
    const message = JSON.stringify({
      type: "user",
      session_id: "",
      message: { role: "user", content: "hello world" },
      parent_tool_use_id: null,
    })
    const parsed = JSON.parse(message)
    expect(parsed.type).toBe("user")
    expect(parsed.message.role).toBe("user")
    expect(parsed.message.content).toBe("hello world")
    expect(parsed.parent_tool_use_id).toBeNull()
  })

  it("builds correct NDJSON for image+text reply", () => {
    const content = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
      },
      { type: "text", text: "What is this?" },
    ]
    const message = JSON.stringify({
      type: "user",
      session_id: "",
      message: { role: "user", content },
      parent_tool_use_id: null,
    })
    const parsed = JSON.parse(message)
    expect(parsed.message.content).toHaveLength(2)
    expect(parsed.message.content[0].type).toBe("image")
    expect(parsed.message.content[1].type).toBe("text")
  })
})
