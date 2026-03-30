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

  describe("agentDefs from env vars", () => {
    beforeEach(() => {
      for (const key of ["AGENTS_DIR", "SKILLS_DIR", "GOOSEHINTS_PATH", "CLAUDE_MD_PATH"]) {
        originalEnv[key] = process.env[key]
        delete process.env[key]
      }
    })

    afterEach(() => {
      for (const key of ["AGENTS_DIR", "SKILLS_DIR", "GOOSEHINTS_PATH", "CLAUDE_MD_PATH"]) {
        if (originalEnv[key] === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = originalEnv[key]
        }
      }
    })

    it("returns undefined agentDefs when no env vars set", () => {
      const config = configFromEnv()
      expect(config.agentDefs).toBeUndefined()
    })

    it("parses AGENTS_DIR env var", () => {
      process.env["AGENTS_DIR"] = "/custom/agents"
      const config = configFromEnv()
      expect(config.agentDefs).toBeDefined()
      expect(config.agentDefs!.agentsDir).toBe("/custom/agents")
    })

    it("parses SKILLS_DIR env var", () => {
      process.env["SKILLS_DIR"] = "/custom/skills"
      const config = configFromEnv()
      expect(config.agentDefs).toBeDefined()
      expect(config.agentDefs!.skillsDir).toBe("/custom/skills")
    })

    it("parses GOOSEHINTS_PATH env var", () => {
      process.env["GOOSEHINTS_PATH"] = "/custom/goosehints"
      const config = configFromEnv()
      expect(config.agentDefs).toBeDefined()
      expect(config.agentDefs!.goosehintsPath).toBe("/custom/goosehints")
    })

    it("parses CLAUDE_MD_PATH env var", () => {
      process.env["CLAUDE_MD_PATH"] = "/custom/CLAUDE.md"
      const config = configFromEnv()
      expect(config.agentDefs).toBeDefined()
      expect(config.agentDefs!.claudeMd).toBe("/custom/CLAUDE.md")
    })

    it("combines multiple env vars into agentDefs", () => {
      process.env["AGENTS_DIR"] = "/a"
      process.env["SKILLS_DIR"] = "/s"
      process.env["GOOSEHINTS_PATH"] = "/g"
      process.env["CLAUDE_MD_PATH"] = "/c"
      const config = configFromEnv()
      expect(config.agentDefs).toEqual({
        agentsDir: "/a",
        skillsDir: "/s",
        goosehintsPath: "/g",
        claudeMd: "/c",
      })
    })

    it("allows overrides to replace env-derived agentDefs", () => {
      process.env["AGENTS_DIR"] = "/from-env"
      const config = configFromEnv({
        agentDefs: { agentsDir: "/from-override" },
      })
      expect(config.agentDefs!.agentsDir).toBe("/from-override")
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
})
