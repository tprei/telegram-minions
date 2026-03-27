import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { configFromEnv } from "../src/config-env.js"
import { ConfigError, ConfigFormatError } from "../src/errors.js"

describe("configFromEnv", () => {
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    // Capture original values
    for (const key of [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_CHAT_ID",
      "SESSION_ENV_PASSTHROUGH",
      "MY_API_KEY",
      "DATABASE_URL",
      "CUSTOM_SECRET",
      "MAX_CONCURRENT_SESSIONS",
    ]) {
      originalEnv[key] = process.env[key]
    }
    // Set required env vars
    process.env["TELEGRAM_BOT_TOKEN"] = "test-token"
    process.env["TELEGRAM_CHAT_ID"] = "test-chat-id"
  })

  afterEach(() => {
    // Restore original values
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  describe("error handling", () => {
    it("throws ConfigError for missing required env var", () => {
      delete process.env["TELEGRAM_BOT_TOKEN"]
      expect(() => configFromEnv()).toThrow(ConfigError)
      try {
        configFromEnv()
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError)
        expect((err as ConfigError).varName).toBe("TELEGRAM_BOT_TOKEN")
        expect((err as ConfigError).message).toContain("Missing required env var")
      }
    })

    it("throws ConfigFormatError for invalid number format", () => {
      process.env["MAX_CONCURRENT_SESSIONS"] = "not-a-number"
      expect(() => configFromEnv()).toThrow(ConfigFormatError)
      try {
        configFromEnv()
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigFormatError)
        expect((err as ConfigFormatError).varName).toBe("MAX_CONCURRENT_SESSIONS")
        expect((err as ConfigFormatError).actualValue).toBe("not-a-number")
      }
    })
  })

  describe("sessionEnvPassthrough", () => {
    it("returns undefined when env var not set", () => {
      delete process.env["SESSION_ENV_PASSTHROUGH"]
      const config = configFromEnv()
      expect(config.sessionEnvPassthrough).toBeUndefined()
    })

    it("parses single env var name", () => {
      process.env["SESSION_ENV_PASSTHROUGH"] = "MY_API_KEY"
      const config = configFromEnv()
      expect(config.sessionEnvPassthrough).toEqual(["MY_API_KEY"])
      delete process.env["SESSION_ENV_PASSTHROUGH"]
    })

    it("parses comma-separated env var names", () => {
      process.env["SESSION_ENV_PASSTHROUGH"] = "MY_API_KEY,DATABASE_URL,CUSTOM_SECRET"
      const config = configFromEnv()
      expect(config.sessionEnvPassthrough).toEqual([
        "MY_API_KEY",
        "DATABASE_URL",
        "CUSTOM_SECRET",
      ])
      delete process.env["SESSION_ENV_PASSTHROUGH"]
    })

    it("trims whitespace from env var names", () => {
      process.env["SESSION_ENV_PASSTHROUGH"] = " KEY1 , KEY2  ,  KEY3  "
      const config = configFromEnv()
      expect(config.sessionEnvPassthrough).toEqual(["KEY1", "KEY2", "KEY3"])
      delete process.env["SESSION_ENV_PASSTHROUGH"]
    })

    it("filters empty strings", () => {
      process.env["SESSION_ENV_PASSTHROUGH"] = "KEY1,,KEY2"
      const config = configFromEnv()
      expect(config.sessionEnvPassthrough).toEqual(["KEY1", "KEY2"])
      delete process.env["SESSION_ENV_PASSTHROUGH"]
    })

    it("allows overrides to merge with env var", () => {
      process.env["SESSION_ENV_PASSTHROUGH"] = "ENV_VAR"
      const config = configFromEnv({
        sessionEnvPassthrough: ["LIB_VAR"],
      })
      // Override takes precedence
      expect(config.sessionEnvPassthrough).toEqual(["LIB_VAR"])
      delete process.env["SESSION_ENV_PASSTHROUGH"]
    })
  })

  describe("claude config", () => {
    it("defaults reviewModel to opus", () => {
      const config = configFromEnv()
      expect(config.claude.reviewModel).toBe("opus")
    })

    it("reads REVIEW_MODEL env var", () => {
      process.env["REVIEW_MODEL"] = "haiku"
      const config = configFromEnv()
      expect(config.claude.reviewModel).toBe("haiku")
      delete process.env["REVIEW_MODEL"]
    })
  })

  describe("codex config", () => {
    it("defaults to gpt-5.4, codex, full-auto", () => {
      const config = configFromEnv()
      expect(config.codex.defaultModel).toBe("gpt-5.4")
      expect(config.codex.execPath).toBe("codex")
      expect(config.codex.approvalMode).toBe("full-auto")
    })

    it("reads CODEX_DEFAULT_MODEL env var", () => {
      process.env["CODEX_DEFAULT_MODEL"] = "o3"
      const config = configFromEnv()
      expect(config.codex.defaultModel).toBe("o3")
      delete process.env["CODEX_DEFAULT_MODEL"]
    })

    it("reads CODEX_EXEC_PATH env var", () => {
      process.env["CODEX_EXEC_PATH"] = "/usr/local/bin/codex"
      const config = configFromEnv()
      expect(config.codex.execPath).toBe("/usr/local/bin/codex")
      delete process.env["CODEX_EXEC_PATH"]
    })

    it("reads CODEX_APPROVAL_MODE env var", () => {
      process.env["CODEX_APPROVAL_MODE"] = "suggest"
      const config = configFromEnv()
      expect(config.codex.approvalMode).toBe("suggest")
      delete process.env["CODEX_APPROVAL_MODE"]
    })
  })
})
