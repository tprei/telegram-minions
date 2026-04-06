import type { MinionConfig, GitHubAppConfig } from "./config-types.js"
import { ConfigError, ConfigFormatError } from "../errors.js"
import { validateMinionConfig, ConfigValidationError } from "./config-validator.js"

function required(name: string): string {
  const val = process.env[name]
  if (!val) throw new ConfigError(`Missing required env var: ${name}`, name)
  return val
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}

function optionalNumber(name: string, fallback: number): number {
  const val = process.env[name]
  if (!val) return fallback
  const n = Number(val)
  if (isNaN(n)) throw new ConfigFormatError(name, "a number", val)
  return n
}

function buildGitHubAppConfig(): GitHubAppConfig | undefined {
  const appId = process.env["GITHUB_APP_ID"]
  const privateKey = process.env["GITHUB_APP_PRIVATE_KEY"]
  const installationId = process.env["GITHUB_APP_INSTALLATION_ID"]

  if (!appId && !privateKey && !installationId) return undefined

  if (!appId || !privateKey || !installationId) {
    const missing = [
      !appId && "GITHUB_APP_ID",
      !privateKey && "GITHUB_APP_PRIVATE_KEY",
      !installationId && "GITHUB_APP_INSTALLATION_ID",
    ].filter(Boolean).join(", ")
    throw new ConfigError(
      `Partial GitHub App config: missing ${missing}. Set all three GITHUB_APP_* vars or none`,
      missing.split(", ")[0],
    )
  }

  return {
    appId,
    privateKey: privateKey.replace(/\\n/g, "\n"),
    installationId,
  }
}

function buildAgentDefs(): MinionConfig["agentDefs"] {
  const agentsDir = process.env["AGENTS_DIR"]
  const skillsDir = process.env["SKILLS_DIR"]
  const goosehintsPath = process.env["GOOSEHINTS_PATH"]
  const claudeMd = process.env["CLAUDE_MD_PATH"]

  if (!agentsDir && !skillsDir && !goosehintsPath && !claudeMd) return undefined

  return {
    ...(agentsDir ? { agentsDir } : {}),
    ...(skillsDir ? { skillsDir } : {}),
    ...(goosehintsPath ? { goosehintsPath } : {}),
    ...(claudeMd ? { claudeMd } : {}),
  }
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
        .map(Number)
        .filter((n) => !isNaN(n) && n > 0),
    },
    goose: {
      provider: optional("GOOSE_PROVIDER", "claude-acp"),
      model: optional("GOOSE_MODEL", "sonnet"),
    },
    claude: {
      planModel: optional("PLAN_MODEL", "opus"),
      thinkModel: optional("THINK_MODEL", "opus"),
      reviewModel: optional("REVIEW_MODEL", "opus"),
    },
    workspace: {
      root: optional("WORKSPACE_ROOT", "/workspace"),
      maxConcurrentSessions: optionalNumber("MAX_CONCURRENT_SESSIONS", 5),
      maxDagConcurrency: optionalNumber("MAX_DAG_CONCURRENCY", 2),
      maxSplitItems: optionalNumber("MAX_SPLIT_ITEMS", 5),
      sessionTokenBudget: optionalNumber("SESSION_TOKEN_BUDGET", 200_000),
      sessionBudgetUsd: optionalNumber("SESSION_BUDGET_USD", 10),
      sessionTimeoutMs: optionalNumber("SESSION_TIMEOUT_MS", 3600000),
      sessionInactivityTimeoutMs: optionalNumber("SESSION_INACTIVITY_TIMEOUT_MS", 900_000),
      staleTtlMs: optionalNumber("SESSION_STALE_TTL_MS", 2 * 24 * 60 * 60 * 1000),
      cleanupIntervalMs: optionalNumber("CLEANUP_INTERVAL_MS", 60 * 60 * 1000),
      maxConversationLength: optionalNumber("MAX_CONVERSATION_LENGTH", 100),
      maxJudgeOptions: optionalNumber("MAX_JUDGE_OPTIONS", 4),
      judgeAdvocateTimeoutMs: optionalNumber("JUDGE_ADVOCATE_TIMEOUT_MS", 90_000),
      judgeTimeoutMs: optionalNumber("JUDGE_TIMEOUT_MS", 120_000),
    },
    ci: {
      babysitEnabled: optional("CI_BABYSIT_ENABLED", "true") === "true",
      maxRetries: optionalNumber("CI_BABYSIT_MAX_RETRIES", 2),
      pollIntervalMs: optionalNumber("CI_POLL_INTERVAL_MS", 30_000),
      pollTimeoutMs: optionalNumber("CI_POLL_TIMEOUT_MS", 600_000),
      noChecksGraceMs: optionalNumber("CI_NO_CHECKS_GRACE_MS", 120_000),
      dagCiPolicy: (optional("DAG_CI_POLICY", "warn") as "block" | "warn" | "skip"),
    },
    mcp: {
      browserEnabled: optional("ENABLE_BROWSER_MCP", "true") === "true",
      githubEnabled: optional("ENABLE_GITHUB_MCP", "true") === "true",
      context7Enabled: optional("ENABLE_CONTEXT7_MCP", "true") === "true",
      sentryEnabled: optional("ENABLE_SENTRY_MCP", "true") === "true",
      sentryOrgSlug: process.env["SENTRY_ORG_SLUG"] ?? "",
      sentryProjectSlug: process.env["SENTRY_PROJECT_SLUG"] ?? "",
      supabaseEnabled: optional("ENABLE_SUPABASE_MCP", "true") === "true",
      supabaseProjectRef: process.env["SUPABASE_PROJECT_REF"] ?? "",
      zaiEnabled: optional("ENABLE_ZAI_MCP", "true") === "true",
    },
    telegramQueue: {
      minSendIntervalMs: optionalNumber("MIN_SEND_INTERVAL_MS", 3500),
    },
    observer: {
      activityThrottleMs: optionalNumber("ACTIVITY_THROTTLE_MS", 3000),
      textFlushDebounceMs: optionalNumber("TEXT_FLUSH_DEBOUNCE_MS", 5000),
      activityEditDebounceMs: optionalNumber("ACTIVITY_EDIT_DEBOUNCE_MS", 5000),
    },
    quota: {
      retryMax: optionalNumber("QUOTA_RETRY_MAX", 3),
      defaultSleepMs: optionalNumber("QUOTA_DEFAULT_SLEEP_MS", 3600_000),
      sleepBufferMs: optionalNumber("QUOTA_SLEEP_BUFFER_MS", 60_000),
    },
    sentry: {
      dsn: process.env["SENTRY_DSN"] ?? undefined,
    },
    githubApp: buildGitHubAppConfig(),
    agentDefs: buildAgentDefs(),
    repos: {},
    sessionEnvPassthrough: process.env["SESSION_ENV_PASSTHROUGH"]
      ? process.env["SESSION_ENV_PASSTHROUGH"].split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined,
    ...overrides,
  }

  const validation = validateMinionConfig(base)
  if (!validation.valid) {
    const messages = validation.errors.map((e) => e.message).join("\n  ")
    throw new ConfigValidationError(`Invalid config:\n  ${messages}`, "configFromEnv")
  }

  return base
}
