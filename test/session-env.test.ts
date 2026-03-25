import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { SessionHandle, type SessionConfig } from "../src/session.js"
import type { SessionMeta } from "../src/types.js"

const baseConfig: SessionConfig = {
  goose: { provider: "test", model: "test" },
  claude: { planModel: "test", thinkModel: "test" },
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
  sessionId: "test-env",
  threadId: 1,
  topicName: "test-env",
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

function getIsolatedEnv(handle: SessionHandle): Record<string, string> {
  const h = handle as unknown as { buildIsolatedEnv: () => Record<string, string> }
  return h.buildIsolatedEnv()
}

describe("SessionHandle.buildIsolatedEnv", () => {
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    // Save original env vars we'll modify
    originalEnv["MY_API_KEY"] = process.env["MY_API_KEY"]
    originalEnv["DATABASE_URL"] = process.env["DATABASE_URL"]
    originalEnv["CUSTOM_SECRET"] = process.env["CUSTOM_SECRET"]
    originalEnv["MISSING_VAR"] = process.env["MISSING_VAR"]
    originalEnv["GITHUB_TOKEN"] = process.env["GITHUB_TOKEN"]
    originalEnv["SENTRY_ACCESS_TOKEN"] = process.env["SENTRY_ACCESS_TOKEN"]
  })

  afterEach(() => {
    // Restore original env vars
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  describe("sessionEnvPassthrough", () => {
    it("includes no extra vars when passthrough is undefined", () => {
      const handle = makeHandle()
      const env = getIsolatedEnv(handle)

      expect(env["MY_API_KEY"]).toBeUndefined()
      expect(env["DATABASE_URL"]).toBeUndefined()
    })

    it("includes no extra vars when passthrough is empty", () => {
      const handle = makeHandle({ sessionEnvPassthrough: [] })
      const env = getIsolatedEnv(handle)

      expect(env["MY_API_KEY"]).toBeUndefined()
    })

    it("passes through a single env var", () => {
      process.env["MY_API_KEY"] = "secret-key-123"
      const handle = makeHandle({ sessionEnvPassthrough: ["MY_API_KEY"] })
      const env = getIsolatedEnv(handle)

      expect(env["MY_API_KEY"]).toBe("secret-key-123")
    })

    it("passes through multiple env vars", () => {
      process.env["MY_API_KEY"] = "key-123"
      process.env["DATABASE_URL"] = "postgres://localhost"
      process.env["CUSTOM_SECRET"] = "secret-value"

      const handle = makeHandle({
        sessionEnvPassthrough: ["MY_API_KEY", "DATABASE_URL", "CUSTOM_SECRET"],
      })
      const env = getIsolatedEnv(handle)

      expect(env["MY_API_KEY"]).toBe("key-123")
      expect(env["DATABASE_URL"]).toBe("postgres://localhost")
      expect(env["CUSTOM_SECRET"]).toBe("secret-value")
    })

    it("skips vars that are not set in parent env", () => {
      delete process.env["MISSING_VAR"]
      process.env["MY_API_KEY"] = "key-123"

      const handle = makeHandle({
        sessionEnvPassthrough: ["MY_API_KEY", "MISSING_VAR"],
      })
      const env = getIsolatedEnv(handle)

      expect(env["MY_API_KEY"]).toBe("key-123")
      expect(env["MISSING_VAR"]).toBeUndefined()
    })

    it("does not override hardcoded base vars", () => {
      // GITHUB_TOKEN is hardcoded in buildIsolatedEnv
      process.env["GITHUB_TOKEN"] = "ghp_original"
      process.env["MY_API_KEY"] = "key-123"

      const handle = makeHandle({
        sessionEnvPassthrough: ["GITHUB_TOKEN", "MY_API_KEY"],
      })
      const env = getIsolatedEnv(handle)

      // GITHUB_TOKEN should still be set (passthrough would be redundant here)
      expect(env["GITHUB_TOKEN"]).toBe("ghp_original")
      expect(env["MY_API_KEY"]).toBe("key-123")
    })
  })

  describe("base env vars", () => {
    it("always includes essential vars", () => {
      const handle = makeHandle()
      const env = getIsolatedEnv(handle)

      expect(env["PATH"]).toBeDefined()
      expect(env["HOME"]).toBeDefined()
      expect(env["LANG"]).toBeDefined()
    })

    it("includes GITHUB_TOKEN when set", () => {
      process.env["GITHUB_TOKEN"] = "ghp_test_token"
      const handle = makeHandle()
      const env = getIsolatedEnv(handle)

      expect(env["GITHUB_TOKEN"]).toBe("ghp_test_token")
    })

    it("includes SENTRY_ACCESS_TOKEN when set", () => {
      process.env["SENTRY_ACCESS_TOKEN"] = "sentry_token"
      const handle = makeHandle()
      const env = getIsolatedEnv(handle)

      expect(env["SENTRY_ACCESS_TOKEN"]).toBe("sentry_token")
    })
  })
})
