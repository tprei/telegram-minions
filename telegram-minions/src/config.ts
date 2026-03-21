import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const dotenv = require("dotenv")

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(scriptDir, "..", ".env") })

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

export const config = {
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
    provider: optional("GOOSE_PROVIDER", "anthropic"),
    model: optional("GOOSE_MODEL", "claude-sonnet-4-5"),
  },
  workspace: {
    root: optional("WORKSPACE_ROOT", "/workspace"),
    maxConcurrentSessions: optionalNumber("MAX_CONCURRENT_SESSIONS", 5),
    sessionBudgetUsd: optionalNumber("SESSION_BUDGET_USD", 10),
    sessionTimeoutMs: optionalNumber("SESSION_TIMEOUT_MS", 3600000),
  },
  observer: {
    activityThrottleMs: optionalNumber("ACTIVITY_THROTTLE_MS", 3000),
  },
} as const
