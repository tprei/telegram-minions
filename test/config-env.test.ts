import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { configFromEnv } from "../src/config-env.js"

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
    it("defaults reviewModel to sonnet", () => {
      const config = configFromEnv()
      expect(config.claude.reviewModel).toBe("sonnet")
    })

    it("reads REVIEW_MODEL env var", () => {
      process.env["REVIEW_MODEL"] = "haiku"
      const config = configFromEnv()
      expect(config.claude.reviewModel).toBe("haiku")
      delete process.env["REVIEW_MODEL"]
    })
  })
})
