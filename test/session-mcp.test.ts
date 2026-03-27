import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
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
        bearerTokenEnvVar: "ZAI_API_KEY",
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
        bearerTokenEnvVar: "ZAI_API_KEY",
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

  describe("Codex TOML config", () => {
    function getCodexMcpToml(handle: SessionHandle): string {
      const h = handle as unknown as { buildCodexMcpToml: () => string }
      return h.buildCodexMcpToml()
    }

    function getCodexMcpConfigArgs(handle: SessionHandle, sessionHome: string): string[] {
      const h = handle as unknown as { buildCodexMcpConfigArgs: (home: string) => string[] }
      return h.buildCodexMcpConfigArgs(sessionHome)
    }

    it("returns empty string when no MCPs enabled", () => {
      const handle = makeHandle()
      const toml = getCodexMcpToml(handle)
      expect(toml).toBe("")
    })

    it("returns empty args when no MCPs enabled", () => {
      const handle = makeHandle()
      const args = getCodexMcpConfigArgs(handle, "/tmp/test-home")
      expect(args).toEqual([])
    })

    it("generates stdio MCP in TOML format", () => {
      process.env["GITHUB_TOKEN"] = "ghp_test123"
      const handle = makeHandle({
        mcp: {
          ...baseConfig.mcp,
          githubEnabled: true,
        },
      })
      const toml = getCodexMcpToml(handle)

      expect(toml).toContain('[mcp_servers.github]')
      expect(toml).toContain('command = "github-mcp-server"')
      expect(toml).toContain('args = ["stdio"]')
      expect(toml).toContain('GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_test123"')
      expect(toml).toContain("env =")
    })

    it("generates HTTP MCP with bearer_token_env_var", () => {
      process.env["ZAI_API_KEY"] = "test-key"
      const handle = makeHandle({
        goose: { provider: "z-ai", model: "test" },
        mcp: { ...baseConfig.mcp, zaiEnabled: true },
      })
      const toml = getCodexMcpToml(handle)

      expect(toml).toContain("[mcp_servers.web-search-prime]")
      expect(toml).toContain('url = "https://api.z.ai/api/mcp/web_search_prime/mcp"')
      expect(toml).toContain('bearer_token_env_var = "ZAI_API_KEY"')
      // Authorization header should NOT appear as http_header
      expect(toml).not.toContain("http_headers")
    })

    it("generates multiple MCPs in TOML", () => {
      process.env["GITHUB_TOKEN"] = "ghp_test"
      process.env["ZAI_API_KEY"] = "zai-test"
      const handle = makeHandle({
        goose: { provider: "z-ai", model: "test" },
        mcp: {
          ...baseConfig.mcp,
          githubEnabled: true,
          context7Enabled: true,
          zaiEnabled: true,
        },
      })
      const toml = getCodexMcpToml(handle)

      expect(toml).toContain("[mcp_servers.github]")
      expect(toml).toContain("[mcp_servers.context7]")
      expect(toml).toContain("[mcp_servers.web-search-prime]")
    })

    it("writes TOML file and returns --config args", () => {
      process.env["GITHUB_TOKEN"] = "ghp_test"
      const handle = makeHandle({
        mcp: {
          ...baseConfig.mcp,
          githubEnabled: true,
        },
      })

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-test-"))
      try {
        const args = getCodexMcpConfigArgs(handle, tmpDir)

        expect(args).toHaveLength(2)
        expect(args[0]).toBe("--config")

        const configPath = path.join(tmpDir, ".codex", "config.toml")
        expect(args[1]).toBe(configPath)
        expect(fs.existsSync(configPath)).toBe(true)

        const contents = fs.readFileSync(configPath, "utf-8")
        expect(contents).toContain("[mcp_servers.github]")
        expect(contents).toContain('command = "github-mcp-server"')
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it("escapes special characters in TOML strings", () => {
      process.env["GITHUB_TOKEN"] = 'token-with-"quotes"-and\\backslash'
      const handle = makeHandle({
        mcp: {
          ...baseConfig.mcp,
          githubEnabled: true,
        },
      })
      const toml = getCodexMcpToml(handle)

      expect(toml).toContain('GITHUB_PERSONAL_ACCESS_TOKEN = "token-with-\\"quotes\\"-and\\\\backslash"')
    })

    it("handles Sentry MCP with org and project slugs", () => {
      process.env["SENTRY_ACCESS_TOKEN"] = "sentry-token"
      const handle = makeHandle({
        mcp: {
          ...baseConfig.mcp,
          sentryEnabled: true,
          sentryOrgSlug: "my-org",
          sentryProjectSlug: "my-project",
        },
      })
      const toml = getCodexMcpToml(handle)

      expect(toml).toContain("[mcp_servers.sentry]")
      expect(toml).toContain('command = "npx"')
      expect(toml).toContain('"-y"')
      expect(toml).toContain('"@sentry/mcp-server@latest"')
      expect(toml).toContain('"--access-token"')
      expect(toml).toContain('"sentry-token"')
      expect(toml).toContain('"--organization-slug"')
      expect(toml).toContain('"my-org"')
      expect(toml).toContain('"--project-slug"')
      expect(toml).toContain('"my-project"')
    })
  })

})
