import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { SessionHandle, type SessionConfig } from "../src/session.js"
import type { SessionMeta } from "../src/types.js"

const baseConfig: SessionConfig = {
  goose: { provider: "test", model: "test" },
  claude: { planModel: "test", thinkModel: "test", reviewModel: "test" },
  mcp: {
    browserEnabled: false,
    githubEnabled: false,
    context7Enabled: false,
    sentryEnabled: false,
    sentryOrgSlug: "",
    sentryProjectSlug: "",
    supabaseEnabled: false,
    supabaseProjectRef: "",
    zaiEnabled: false,
  },
}

const baseMeta: SessionMeta = {
  sessionId: "test-mcp",
  threadId: 1,
  topicName: "test-mcp",
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

function getMcpServers(handle: SessionHandle): Record<string, unknown> {
  const h = handle as unknown as { buildMcpServers: () => Record<string, unknown> }
  return h.buildMcpServers()
}

function getGooseExtensionArgs(handle: SessionHandle): string[] {
  const h = handle as unknown as { buildGooseExtensionArgs: () => string[] }
  return h.buildGooseExtensionArgs()
}

function getClaudeMcpConfigArgs(handle: SessionHandle): string[] {
  const h = handle as unknown as { buildClaudeMcpConfigArgs: () => string[] }
  return h.buildClaudeMcpConfigArgs()
}

describe("SessionHandle MCP building", () => {
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    originalEnv["ZAI_API_KEY"] = process.env["ZAI_API_KEY"]
    originalEnv["GITHUB_TOKEN"] = process.env["GITHUB_TOKEN"]
    originalEnv["SENTRY_ACCESS_TOKEN"] = process.env["SENTRY_ACCESS_TOKEN"]
    originalEnv["SUPABASE_ACCESS_TOKEN"] = process.env["SUPABASE_ACCESS_TOKEN"]
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

  describe("Z.AI MCP", () => {
    it("does not include Z.AI when zaiEnabled is false", () => {
      process.env["ZAI_API_KEY"] = "test-key"
      const handle = makeHandle({
        goose: { provider: "z-ai", model: "test" },
        mcp: { ...baseConfig.mcp, zaiEnabled: false },
      })
      const servers = getMcpServers(handle)

      expect(servers["web-search-prime"]).toBeUndefined()
    })

    it("does not include Z.AI when provider is not z-ai", () => {
      process.env["ZAI_API_KEY"] = "test-key"
      const handle = makeHandle({
        goose: { provider: "claude-acp", model: "test" },
        mcp: { ...baseConfig.mcp, zaiEnabled: true },
      })
      const servers = getMcpServers(handle)

      expect(servers["web-search-prime"]).toBeUndefined()
    })

    it("does not include Z.AI when ZAI_API_KEY is not set", () => {
      delete process.env["ZAI_API_KEY"]
      const handle = makeHandle({
        goose: { provider: "z-ai", model: "test" },
        mcp: { ...baseConfig.mcp, zaiEnabled: true },
      })
      const servers = getMcpServers(handle)

      expect(servers["web-search-prime"]).toBeUndefined()
    })

    it("includes Z.AI when enabled, provider is z-ai, and API key from profile", () => {
      delete process.env["ZAI_API_KEY"]
      const handle = makeHandle({
        goose: { provider: "z-ai", model: "test" },
        mcp: { ...baseConfig.mcp, zaiEnabled: true },
        profile: {
          id: "z-ai-profile",
          name: "Z.AI Profile",
          authToken: "profile-token-xyz",
        },
      })
      const servers = getMcpServers(handle)

      expect(servers["web-search-prime"]).toEqual({
        type: "http",
        url: "https://api.z.ai/api/mcp/web_search_prime/mcp",
        headers: {
          Authorization: "Bearer profile-token-xyz",
        },
      })
    })

    it("prefers profile.authToken over env var for Z.AI MCP", () => {
      process.env["ZAI_API_KEY"] = "env-key-should-be-ignored"
      const handle = makeHandle({
        goose: { provider: "z-ai", model: "test" },
        mcp: { ...baseConfig.mcp, zaiEnabled: true },
        profile: {
          id: "z-ai-profile",
          name: "Z.AI Profile",
          authToken: "profile-token-xyz",
        },
      })
      const servers = getMcpServers(handle)

      expect(servers["web-search-prime"]).toEqual({
        type: "http",
        url: "https://api.z.ai/api/mcp/web_search_prime/mcp",
        headers: {
          Authorization: "Bearer profile-token-xyz",
        },
      })
    })

    it("skips HTTP MCPs in Goose extension args", () => {
      process.env["ZAI_API_KEY"] = "test-key"
      const handle = makeHandle({
        goose: { provider: "z-ai", model: "test" },
        mcp: {
          ...baseConfig.mcp,
          zaiEnabled: true,
          context7Enabled: true, // stdio MCP for comparison
        },
      })
      const args = getGooseExtensionArgs(handle)

      // Should include context7 (stdio) but not Z.AI (http)
      expect(args.some(arg => arg.includes("context7-mcp"))).toBe(true)
      expect(args.some(arg => arg.includes("z.ai") || arg.includes("web-search-prime"))).toBe(false)
    })

    it("includes HTTP MCPs in Claude MCP config args", () => {
      process.env["ZAI_API_KEY"] = "test-key-456"
      const handle = makeHandle({
        goose: { provider: "z-ai", model: "test" },
        mcp: { ...baseConfig.mcp, zaiEnabled: true },
      })
      const args = getClaudeMcpConfigArgs(handle)

      expect(args).toHaveLength(2)
      expect(args[0]).toBe("--mcp-config")

      const config = JSON.parse(args[1])
      expect(config.mcpServers["web-search-prime"]).toEqual({
        type: "http",
        url: "https://api.z.ai/api/mcp/web_search_prime/mcp",
        headers: {
          Authorization: "Bearer test-key-456",
        },
      })
    })

    it("includes both stdio and HTTP MCPs in Claude config", () => {
      process.env["ZAI_API_KEY"] = "test-key"
      const handle = makeHandle({
        goose: { provider: "z-ai", model: "test" },
        mcp: {
          ...baseConfig.mcp,
          zaiEnabled: true,
          context7Enabled: true,
        },
      })
      const args = getClaudeMcpConfigArgs(handle)
      const config = JSON.parse(args[1])

      // Should have both context7 (stdio) and web-search-prime (http)
      expect(config.mcpServers["context7"]).toEqual({
        command: "context7-mcp",
        args: [],
        env: undefined,
      })
      expect(config.mcpServers["web-search-prime"].type).toBe("http")
    })
  })

  describe("Supabase MCP", () => {
    it("does not include Supabase when supabaseEnabled is false", () => {
      process.env["SUPABASE_ACCESS_TOKEN"] = "sbt_test-token"
      const handle = makeHandle({
        mcp: { ...baseConfig.mcp, supabaseEnabled: false },
      })
      const servers = getMcpServers(handle)

      expect(servers["supabase"]).toBeUndefined()
    })

    it("does not include Supabase when SUPABASE_ACCESS_TOKEN is not set", () => {
      delete process.env["SUPABASE_ACCESS_TOKEN"]
      const handle = makeHandle({
        mcp: { ...baseConfig.mcp, supabaseEnabled: true },
      })
      const servers = getMcpServers(handle)

      expect(servers["supabase"]).toBeUndefined()
    })

    it("includes Supabase when enabled with access token", () => {
      process.env["SUPABASE_ACCESS_TOKEN"] = "sbt_test-token"
      const handle = makeHandle({
        mcp: { ...baseConfig.mcp, supabaseEnabled: true },
      })
      const servers = getMcpServers(handle)

      expect(servers["supabase"]).toEqual({
        command: "npx",
        args: ["-y", "@supabase/mcp-server-supabase@latest", "--access-token", "sbt_test-token"],
      })
    })

    it("includes project ref in args when configured", () => {
      process.env["SUPABASE_ACCESS_TOKEN"] = "sbt_test-token"
      const handle = makeHandle({
        mcp: { ...baseConfig.mcp, supabaseEnabled: true, supabaseProjectRef: "abc123" },
      })
      const servers = getMcpServers(handle)

      expect(servers["supabase"]).toEqual({
        command: "npx",
        args: ["-y", "@supabase/mcp-server-supabase@latest", "--access-token", "sbt_test-token", "--project-ref", "abc123"],
      })
    })
  })

})
