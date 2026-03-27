import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { configFromEnv } from "../src/config-env.js"
import type { SessionConfig, CodexConfig } from "../src/config-types.js"

describe("dispatcher codex config wiring", () => {
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_CHAT_ID",
      "CODEX_DEFAULT_MODEL",
      "CODEX_EXEC_PATH",
      "CODEX_APPROVAL_MODE",
    ]) {
      originalEnv[key] = process.env[key]
    }
    process.env["TELEGRAM_BOT_TOKEN"] = "test-token"
    process.env["TELEGRAM_CHAT_ID"] = "test-chat-id"
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it("passes codex config from MinionConfig through to SessionConfig", () => {
    const config = configFromEnv()
    expect(config.codex).toBeDefined()

    const sessionConfig: SessionConfig = {
      goose: config.goose,
      claude: config.claude,
      codex: config.codex,
      mcp: config.mcp,
    }

    expect(sessionConfig.codex).toEqual(config.codex)
    expect(sessionConfig.codex?.defaultModel).toBe("o4-mini")
    expect(sessionConfig.codex?.execPath).toBe("codex")
    expect(sessionConfig.codex?.approvalMode).toBe("full-auto")
  })

  it("respects custom codex env vars through to SessionConfig", () => {
    process.env["CODEX_DEFAULT_MODEL"] = "o3"
    process.env["CODEX_EXEC_PATH"] = "/usr/local/bin/codex"
    process.env["CODEX_APPROVAL_MODE"] = "suggest"

    const config = configFromEnv()

    const sessionConfig: SessionConfig = {
      goose: config.goose,
      claude: config.claude,
      codex: config.codex,
      mcp: config.mcp,
    }

    expect(sessionConfig.codex?.defaultModel).toBe("o3")
    expect(sessionConfig.codex?.execPath).toBe("/usr/local/bin/codex")
    expect(sessionConfig.codex?.approvalMode).toBe("suggest")
  })

  it("allows overrides to replace codex config in SessionConfig", () => {
    const config = configFromEnv()
    const customCodex: CodexConfig = {
      defaultModel: "custom-model",
      execPath: "/custom/codex",
      approvalMode: "yolo",
    }

    const sessionConfig: SessionConfig = {
      goose: config.goose,
      claude: config.claude,
      codex: customCodex,
      mcp: config.mcp,
    }

    expect(sessionConfig.codex).toBe(customCodex)
    expect(sessionConfig.codex?.defaultModel).toBe("custom-model")
  })

  it("SessionConfig accepts undefined codex (backward compatible)", () => {
    const config = configFromEnv()

    const sessionConfig: SessionConfig = {
      goose: config.goose,
      claude: config.claude,
      mcp: config.mcp,
    }

    expect(sessionConfig.codex).toBeUndefined()
  })

  it("includes codex alongside other session config fields", () => {
    const config = configFromEnv()

    const sessionConfig: SessionConfig = {
      goose: config.goose,
      claude: config.claude,
      codex: config.codex,
      mcp: config.mcp,
      sessionEnvPassthrough: ["MY_VAR"],
    }

    expect(sessionConfig.goose).toBeDefined()
    expect(sessionConfig.claude).toBeDefined()
    expect(sessionConfig.codex).toBeDefined()
    expect(sessionConfig.mcp).toBeDefined()
    expect(sessionConfig.sessionEnvPassthrough).toEqual(["MY_VAR"])
  })
})
