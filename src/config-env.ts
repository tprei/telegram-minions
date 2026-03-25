import type { MinionConfig } from "./config-types.js"

function required(name: string): string {
  const val = process.env[name]
  if (!val) throw new Error(`Missing required env var: ${name}`)
  return val
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}

function optionalNumber(name: string, fallback: number): number {
  const val = process.env[name]
  if (!val) return fallback
  const n = Number(val)
  if (isNaN(n)) throw new Error(`Env var ${name} must be a number, got: ${val}`)
  return n
}

export function configFromEnv(overrides?: Partial<MinionConfig>): MinionConfig {
  const base: MinionConfig = {
    telegram: {
      botToken: required("TELEGRAM_BOT_TOKEN"),
      chatId: required("TELEGRAM_CHAT_ID"),
      allowedUserIds: (process.env["ALLOWED_USER_IDS"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map(Number),
    },
    goose: {
      provider: optional("GOOSE_PROVIDER", "claude-acp"),
      model: optional("GOOSE_MODEL", "default"),
    },
    claude: {
      planModel: optional("PLAN_MODEL", "sonnet"),
      thinkModel: optional("THINK_MODEL", "opus"),
      reviewModel: optional("REVIEW_MODEL", "opus"),
    },
    workspace: {
      root: optional("WORKSPACE_ROOT", "/workspace"),
      maxConcurrentSessions: optionalNumber("MAX_CONCURRENT_SESSIONS", 5),
      sessionTokenBudget: optionalNumber("SESSION_TOKEN_BUDGET", 200_000),
      sessionBudgetUsd: optionalNumber("SESSION_BUDGET_USD", 10),
      sessionTimeoutMs: optionalNumber("SESSION_TIMEOUT_MS", 3600000),
      staleTtlMs: optionalNumber("SESSION_STALE_TTL_MS", 2 * 24 * 60 * 60 * 1000),
      cleanupIntervalMs: optionalNumber("CLEANUP_INTERVAL_MS", 60 * 60 * 1000),
    },
    ci: {
      babysitEnabled: optional("CI_BABYSIT_ENABLED", "true") === "true",
      maxRetries: optionalNumber("CI_BABYSIT_MAX_RETRIES", 2),
      pollIntervalMs: optionalNumber("CI_POLL_INTERVAL_MS", 30_000),
      pollTimeoutMs: optionalNumber("CI_POLL_TIMEOUT_MS", 600_000),
    },
    mcp: {
      browserEnabled: optional("ENABLE_BROWSER_MCP", "true") === "true",
      githubEnabled: optional("ENABLE_GITHUB_MCP", "true") === "true",
      context7Enabled: optional("ENABLE_CONTEXT7_MCP", "true") === "true",
      sentryEnabled: optional("ENABLE_SENTRY_MCP", "true") === "true",
      sentryOrgSlug: process.env["SENTRY_ORG_SLUG"] ?? "",
      sentryProjectSlug: process.env["SENTRY_PROJECT_SLUG"] ?? "",
    },
    observer: {
      activityThrottleMs: optionalNumber("ACTIVITY_THROTTLE_MS", 3000),
    },
    sentry: {
      dsn: process.env["SENTRY_DSN"] ?? undefined,
    },
    repos: {},
    sessionEnvPassthrough: process.env["SESSION_ENV_PASSTHROUGH"]
      ? process.env["SESSION_ENV_PASSTHROUGH"].split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined,
    ...overrides,
  }

  return base
}
