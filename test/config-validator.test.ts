import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  validateMinionConfig,
  validateTelegramConfig,
  validateGooseConfig,
  validateClaudeConfig,
  validateCodexConfig,
  validateWorkspaceConfig,
  validateCiConfig,
  validateMcpConfig,
  validateObserverConfig,
  validateSentryConfig,
  validateAgentDefinitions,
  validateApiServerConfig,
  validateProviderProfile,
  validateConfigOrThrow,
  assertValidConfig,
  ConfigValidationError,
} from "../src/config-validator.js"
import type { MinionConfig, TelegramConfig, WorkspaceConfig, ProviderProfile } from "../src/config-types.js"
import { configFromEnv } from "../src/config-env.js"

function createValidMinionConfig(): MinionConfig {
  return {
    telegram: {
      botToken: "test-token",
      chatId: "test-chat-id",
      allowedUserIds: [12345, 67890],
    },
    goose: {
      provider: "claude-acp",
      model: "default",
    },
    claude: {
      planModel: "sonnet",
      thinkModel: "opus",
      reviewModel: "opus",
    },
    codex: {
      defaultModel: "o4-mini",
      execPath: "codex",
      approvalMode: "full-auto",
    },
    workspace: {
      root: "/workspace",
      maxConcurrentSessions: 5,
      maxDagConcurrency: 4,
      maxSplitItems: 5,
      sessionTokenBudget: 200_000,
      sessionBudgetUsd: 10,
      sessionTimeoutMs: 3600000,
      sessionInactivityTimeoutMs: 900_000,
      staleTtlMs: 2 * 24 * 60 * 60 * 1000,
      cleanupIntervalMs: 60 * 60 * 1000,
    },
    ci: {
      babysitEnabled: true,
      maxRetries: 2,
      pollIntervalMs: 30_000,
      pollTimeoutMs: 600_000,
    },
    mcp: {
      browserEnabled: true,
      githubEnabled: true,
      context7Enabled: true,
      sentryEnabled: true,
      sentryOrgSlug: "",
      sentryProjectSlug: "",
      zaiEnabled: true,
    },
    observer: {
      activityThrottleMs: 3000,
    },
    repos: {},
  }
}

describe("validateTelegramConfig", () => {
  it("validates a valid config", () => {
    const config: TelegramConfig = {
      botToken: "test-token",
      chatId: "test-chat-id",
      allowedUserIds: [12345],
    }
    const result = validateTelegramConfig(config)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it("rejects missing botToken", () => {
    const result = validateTelegramConfig({ chatId: "test", allowedUserIds: [] })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes("botToken"))).toBe(true)
  })

  it("rejects empty botToken", () => {
    const result = validateTelegramConfig({ botToken: "", chatId: "test", allowedUserIds: [] })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes("botToken"))).toBe(true)
  })

  it("rejects whitespace-only botToken", () => {
    const result = validateTelegramConfig({ botToken: "   ", chatId: "test", allowedUserIds: [] })
    expect(result.valid).toBe(false)
  })

  it("rejects invalid userIds", () => {
    const result = validateTelegramConfig({
      botToken: "test",
      chatId: "test",
      allowedUserIds: [-1, 0, "abc" as unknown as number],
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes("allowedUserIds"))).toBe(true)
  })

  it("rejects non-object config", () => {
    const result = validateTelegramConfig(null)
    expect(result.valid).toBe(false)
  })
})

describe("validateGooseConfig", () => {
  it("validates a valid config", () => {
    const result = validateGooseConfig({ provider: "claude-acp", model: "default" })
    expect(result.valid).toBe(true)
  })

  it("rejects missing provider", () => {
    const result = validateGooseConfig({ model: "default" })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes("provider"))).toBe(true)
  })

  it("rejects missing model", () => {
    const result = validateGooseConfig({ provider: "claude-acp" })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes("model"))).toBe(true)
  })
})

describe("validateClaudeConfig", () => {
  it("validates a valid config", () => {
    const result = validateClaudeConfig({
      planModel: "sonnet",
      thinkModel: "opus",
      reviewModel: "haiku",
    })
    expect(result.valid).toBe(true)
  })

  it("rejects missing model fields", () => {
    const result = validateClaudeConfig({})
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes("planModel"))).toBe(true)
    expect(result.errors.some((e) => e.path.includes("thinkModel"))).toBe(true)
    expect(result.errors.some((e) => e.path.includes("reviewModel"))).toBe(true)
  })

  it("rejects empty model names", () => {
    const result = validateClaudeConfig({
      planModel: "",
      thinkModel: "opus",
      reviewModel: "opus",
    })
    expect(result.valid).toBe(false)
  })

  it("rejects invalid model names that are not in validModels and contain no slash", () => {
    const result = validateClaudeConfig({
      planModel: "badmodel",
      thinkModel: "opus",
      reviewModel: "opus",
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes("planModel"))).toBe(true)
  })

  it("accepts custom model identifiers containing a slash", () => {
    const result = validateClaudeConfig({
      planModel: "claude-3-opus-20240229/custom",
      thinkModel: "opus",
      reviewModel: "opus",
    })
    expect(result.valid).toBe(true)
  })
})

describe("validateCodexConfig", () => {
  it("validates a valid config", () => {
    const result = validateCodexConfig({
      defaultModel: "o4-mini",
      execPath: "codex",
      approvalMode: "full-auto",
    })
    expect(result.valid).toBe(true)
  })

  it("accepts all valid approval modes", () => {
    for (const mode of ["suggest", "auto-edit", "full-auto"]) {
      const result = validateCodexConfig({
        defaultModel: "o4-mini",
        execPath: "codex",
        approvalMode: mode,
      })
      expect(result.valid).toBe(true)
    }
  })

  it("rejects missing defaultModel", () => {
    const result = validateCodexConfig({ execPath: "codex", approvalMode: "full-auto" })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes("defaultModel"))).toBe(true)
  })

  it("rejects empty defaultModel", () => {
    const result = validateCodexConfig({ defaultModel: "", execPath: "codex", approvalMode: "full-auto" })
    expect(result.valid).toBe(false)
  })

  it("rejects missing execPath", () => {
    const result = validateCodexConfig({ defaultModel: "o4-mini", approvalMode: "full-auto" })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes("execPath"))).toBe(true)
  })

  it("rejects missing approvalMode", () => {
    const result = validateCodexConfig({ defaultModel: "o4-mini", execPath: "codex" })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes("approvalMode"))).toBe(true)
  })

  it("rejects invalid approval mode", () => {
    const result = validateCodexConfig({
      defaultModel: "o4-mini",
      execPath: "codex",
      approvalMode: "yolo",
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes("approvalMode"))).toBe(true)
  })

  it("rejects non-object config", () => {
    const result = validateCodexConfig(null)
    expect(result.valid).toBe(false)
  })
})

describe("validateWorkspaceConfig", () => {
  it("validates a valid config", () => {
    const result = validateWorkspaceConfig({
      root: "/workspace",
      maxConcurrentSessions: 5,
      maxDagConcurrency: 4,
      maxSplitItems: 5,
      sessionTokenBudget: 200_000,
      sessionBudgetUsd: 10,
      sessionTimeoutMs: 3600000,
      sessionInactivityTimeoutMs: 900_000,
      staleTtlMs: 2 * 24 * 60 * 60 * 1000,
      cleanupIntervalMs: 60 * 60 * 1000,
    })
    expect(result.valid).toBe(true)
  })

  it("rejects maxConcurrentSessions below 1", () => {
    const config: Partial<WorkspaceConfig> = {
      root: "/workspace",
      maxConcurrentSessions: 0,
      maxDagConcurrency: 4,
      maxSplitItems: 5,
      sessionTokenBudget: 200_000,
      sessionBudgetUsd: 10,
      sessionTimeoutMs: 3600000,
      sessionInactivityTimeoutMs: 900_000,
      staleTtlMs: 2 * 24 * 60 * 60 * 1000,
      cleanupIntervalMs: 60 * 60 * 1000,
    }
    const result = validateWorkspaceConfig(config)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes("maxConcurrentSessions"))).toBe(true)
  })

  it("rejects maxConcurrentSessions above 100", () => {
    const config: Partial<WorkspaceConfig> = {
      root: "/workspace",
      maxConcurrentSessions: 101,
      maxDagConcurrency: 4,
      maxSplitItems: 5,
      sessionTokenBudget: 200_000,
      sessionBudgetUsd: 10,
      sessionTimeoutMs: 3600000,
      sessionInactivityTimeoutMs: 900_000,
      staleTtlMs: 2 * 24 * 60 * 60 * 1000,
      cleanupIntervalMs: 60 * 60 * 1000,
    }
    const result = validateWorkspaceConfig(config)
    expect(result.valid).toBe(false)
  })

  it("rejects non-integer concurrency", () => {
    const config: Partial<WorkspaceConfig> = {
      root: "/workspace",
      maxConcurrentSessions: 5.5,
      maxDagConcurrency: 4,
      maxSplitItems: 5,
      sessionTokenBudget: 200_000,
      sessionBudgetUsd: 10,
      sessionTimeoutMs: 3600000,
      sessionInactivityTimeoutMs: 900_000,
      staleTtlMs: 2 * 24 * 60 * 60 * 1000,
      cleanupIntervalMs: 60 * 60 * 1000,
    }
    const result = validateWorkspaceConfig(config)
    expect(result.valid).toBe(false)
  })

  it("rejects NaN values", () => {
    const config: Partial<WorkspaceConfig> = {
      root: "/workspace",
      maxConcurrentSessions: NaN,
      maxDagConcurrency: 4,
      maxSplitItems: 5,
      sessionTokenBudget: 200_000,
      sessionBudgetUsd: 10,
      sessionTimeoutMs: 3600000,
      sessionInactivityTimeoutMs: 900_000,
      staleTtlMs: 2 * 24 * 60 * 60 * 1000,
      cleanupIntervalMs: 60 * 60 * 1000,
    }
    const result = validateWorkspaceConfig(config)
    expect(result.valid).toBe(false)
  })
})

describe("validateCiConfig", () => {
  it("validates a valid config", () => {
    const result = validateCiConfig({
      babysitEnabled: true,
      maxRetries: 2,
      pollIntervalMs: 30_000,
      pollTimeoutMs: 600_000,
    })
    expect(result.valid).toBe(true)
  })

  it("rejects non-boolean babysitEnabled", () => {
    const result = validateCiConfig({
      babysitEnabled: "true" as unknown as boolean,
      maxRetries: 2,
      pollIntervalMs: 30_000,
      pollTimeoutMs: 600_000,
    })
    expect(result.valid).toBe(false)
  })

  it("rejects maxRetries below 0", () => {
    const result = validateCiConfig({
      babysitEnabled: true,
      maxRetries: -1,
      pollIntervalMs: 30_000,
      pollTimeoutMs: 600_000,
    })
    expect(result.valid).toBe(false)
  })

  it("rejects maxRetries above 10", () => {
    const result = validateCiConfig({
      babysitEnabled: true,
      maxRetries: 11,
      pollIntervalMs: 30_000,
      pollTimeoutMs: 600_000,
    })
    expect(result.valid).toBe(false)
  })
})

describe("validateMcpConfig", () => {
  it("validates a valid config", () => {
    const result = validateMcpConfig({
      browserEnabled: true,
      githubEnabled: true,
      context7Enabled: true,
      sentryEnabled: true,
      sentryOrgSlug: "my-org",
      sentryProjectSlug: "my-project",
      zaiEnabled: true,
    })
    expect(result.valid).toBe(true)
  })

  it("rejects non-boolean enabled flags", () => {
    const result = validateMcpConfig({
      browserEnabled: "yes" as unknown as boolean,
      githubEnabled: true,
      context7Enabled: true,
      sentryEnabled: true,
      sentryOrgSlug: "",
      sentryProjectSlug: "",
      zaiEnabled: true,
    })
    expect(result.valid).toBe(false)
  })
})

describe("validateObserverConfig", () => {
  it("validates a valid config", () => {
    const result = validateObserverConfig({ activityThrottleMs: 3000 })
    expect(result.valid).toBe(true)
  })

  it("rejects activityThrottleMs below 100", () => {
    const result = validateObserverConfig({ activityThrottleMs: 50 })
    expect(result.valid).toBe(false)
  })
})

describe("validateSentryConfig", () => {
  it("accepts undefined config", () => {
    const result = validateSentryConfig(undefined)
    expect(result.valid).toBe(true)
  })

  it("accepts null config", () => {
    const result = validateSentryConfig(null)
    expect(result.valid).toBe(true)
  })

  it("validates valid DSN", () => {
    const result = validateSentryConfig({ dsn: "https://key@sentry.io/123" })
    expect(result.valid).toBe(true)
  })

  it("rejects non-https DSN", () => {
    const result = validateSentryConfig({ dsn: "http://key@sentry.io/123" })
    expect(result.valid).toBe(false)
  })

  it("accepts undefined DSN", () => {
    const result = validateSentryConfig({ dsn: undefined })
    expect(result.valid).toBe(true)
  })
})

describe("validateAgentDefinitions", () => {
  it("accepts undefined config", () => {
    const result = validateAgentDefinitions(undefined)
    expect(result.valid).toBe(true)
  })

  it("validates valid config", () => {
    const result = validateAgentDefinitions({
      agentsDir: "/path/to/agents",
      claudeMd: "/path/to/CLAUDE.md",
      settingsJson: { some: "setting" },
    })
    expect(result.valid).toBe(true)
  })

  it("rejects non-string paths", () => {
    const result = validateAgentDefinitions({
      agentsDir: 123 as unknown as string,
    })
    expect(result.valid).toBe(false)
  })

  it("rejects non-object settingsJson", () => {
    const result = validateAgentDefinitions({
      settingsJson: "invalid" as unknown as object,
    })
    expect(result.valid).toBe(false)
  })
})

describe("validateApiServerConfig", () => {
  it("accepts undefined config", () => {
    const result = validateApiServerConfig(undefined)
    expect(result.valid).toBe(true)
  })

  it("validates valid config", () => {
    const result = validateApiServerConfig({
      port: 8080,
      apiToken: "secret-token",
      host: "0.0.0.0",
    })
    expect(result.valid).toBe(true)
  })

  it("rejects port below 1", () => {
    const result = validateApiServerConfig({ port: 0 })
    expect(result.valid).toBe(false)
  })

  it("rejects port above 65535", () => {
    const result = validateApiServerConfig({ port: 70000 })
    expect(result.valid).toBe(false)
  })

  it("rejects non-integer port", () => {
    const result = validateApiServerConfig({ port: 8080.5 })
    expect(result.valid).toBe(false)
  })
})

describe("validateProviderProfile", () => {
  it("validates a valid profile", () => {
    const result = validateProviderProfile({
      id: "my-profile",
      name: "My Profile",
      baseUrl: "https://api.example.com",
      authToken: "secret",
    })
    expect(result.valid).toBe(true)
  })

  it("rejects missing id", () => {
    const result = validateProviderProfile({
      name: "My Profile",
    } as Partial<ProviderProfile>)
    expect(result.valid).toBe(false)
  })

  it("rejects missing name", () => {
    const result = validateProviderProfile({
      id: "my-profile",
    } as Partial<ProviderProfile>)
    expect(result.valid).toBe(false)
  })

  it("rejects invalid baseUrl", () => {
    const result = validateProviderProfile({
      id: "my-profile",
      name: "My Profile",
      baseUrl: "not-a-url",
    })
    expect(result.valid).toBe(false)
  })
})

describe("validateMinionConfig", () => {
  it("validates a complete valid config", () => {
    const config = createValidMinionConfig()
    const result = validateMinionConfig(config)
    expect(result.valid).toBe(true)
  })

  it("rejects null config", () => {
    const result = validateMinionConfig(null)
    expect(result.valid).toBe(false)
  })

  it("rejects non-object config", () => {
    const result = validateMinionConfig("invalid")
    expect(result.valid).toBe(false)
  })

  it("validates optional sessionEnvPassthrough", () => {
    const config = createValidMinionConfig()
    config.sessionEnvPassthrough = ["MY_API_KEY", "DATABASE_URL"]
    const result = validateMinionConfig(config)
    expect(result.valid).toBe(true)
  })

  it("rejects invalid env var names in sessionEnvPassthrough", () => {
    const config = createValidMinionConfig()
    config.sessionEnvPassthrough = ["INVALID-NAME", "123BAD"]
    const result = validateMinionConfig(config)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes("sessionEnvPassthrough"))).toBe(true)
  })

  it("rejects empty strings in sessionEnvPassthrough", () => {
    const config = createValidMinionConfig()
    config.sessionEnvPassthrough = ["VALID_NAME", ""]
    const result = validateMinionConfig(config)
    expect(result.valid).toBe(false)
  })

  it("validates optional api config", () => {
    const config = createValidMinionConfig()
    config.api = { port: 8080, apiToken: "secret" }
    const result = validateMinionConfig(config)
    expect(result.valid).toBe(true)
  })

  it("validates optional sentry config", () => {
    const config = createValidMinionConfig()
    config.sentry = { dsn: "https://key@sentry.io/123" }
    const result = validateMinionConfig(config)
    expect(result.valid).toBe(true)
  })

  it("validates repos record", () => {
    const config = createValidMinionConfig()
    config.repos = { "my-repo": "https://github.com/org/repo" }
    const result = validateMinionConfig(config)
    expect(result.valid).toBe(true)
  })

  it("rejects array as repos", () => {
    const config = createValidMinionConfig()
    config.repos = [] as unknown as Record<string, string>
    const result = validateMinionConfig(config)
    expect(result.valid).toBe(false)
  })
})

describe("validateConfigOrThrow", () => {
  it("does not throw for valid config", () => {
    const config = createValidMinionConfig()
    expect(() => validateConfigOrThrow(config)).not.toThrow()
  })

  it("throws for invalid config", () => {
    const config = createValidMinionConfig()
    config.telegram.botToken = ""
    expect(() => validateConfigOrThrow(config)).toThrow(ConfigValidationError)
  })
})

describe("assertValidConfig", () => {
  it("returns config for valid input", () => {
    const config = createValidMinionConfig()
    const result = assertValidConfig(config)
    expect(result).toBe(config)
  })

  it("throws for invalid config", () => {
    const config = createValidMinionConfig()
    config.workspace.maxConcurrentSessions = -1
    expect(() => assertValidConfig(config)).toThrow()
  })
})

describe("ConfigValidationError", () => {
  it("formats message correctly", () => {
    const error = new ConfigValidationError("expected string", "config.telegram.botToken")
    expect(error.message).toBe("config.telegram.botToken: expected string")
    expect(error.path).toBe("config.telegram.botToken")
    expect(error.name).toBe("ConfigValidationError")
  })
})

describe("configFromEnv integration", () => {
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "ALLOWED_USER_IDS"]) {
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

  it("validates config from env", () => {
    const config = configFromEnv()
    expect(config).toBeDefined()
    expect(config.telegram.botToken).toBe("test-token")
  })

  it("filters invalid ALLOWED_USER_IDS entries", () => {
    process.env["ALLOWED_USER_IDS"] = "not,a,number,12345"
    const config = configFromEnv()
    // NaN and non-positive values are filtered out
    expect(config.telegram.allowedUserIds).toEqual([12345])
  })
})
