import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { captureException } from "./sentry.js"

export interface UsageTier {
  utilization: number
  resets_at: string | null
}

export interface ClaudeUsageResponse {
  five_hour: UsageTier
  seven_day: UsageTier
  seven_day_opus: UsageTier
  seven_day_sonnet: UsageTier
  extra_usage: {
    is_enabled: boolean
    monthly_limit: number | null
    used_credits: number | null
    utilization: number | null
  } | null
}

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string
    refreshToken: string
    expiresAt: string
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseUsageTier(value: unknown): UsageTier | null {
  if (!isObject(value)) return null
  if (typeof value.utilization !== "number") return null
  if (value.resets_at !== null && typeof value.resets_at !== "string") return null
  return { utilization: value.utilization, resets_at: value.resets_at }
}

function parseExtraUsage(value: unknown): ClaudeUsageResponse["extra_usage"] {
  if (value === null) return null
  if (!isObject(value)) return null
  if (typeof value.is_enabled !== "boolean") return null
  if (value.monthly_limit !== null && typeof value.monthly_limit !== "number") return null
  if (value.used_credits !== null && typeof value.used_credits !== "number") return null
  if (value.utilization !== null && typeof value.utilization !== "number") return null
  return {
    is_enabled: value.is_enabled,
    monthly_limit: value.monthly_limit,
    used_credits: value.used_credits,
    utilization: value.utilization,
  }
}

function parseClaudeUsageResponse(value: unknown): ClaudeUsageResponse | null {
  if (!isObject(value)) return null
  const fiveHour = parseUsageTier(value.five_hour)
  const sevenDay = parseUsageTier(value.seven_day)
  const sevenDayOpus = parseUsageTier(value.seven_day_opus)
  const sevenDaySonnet = parseUsageTier(value.seven_day_sonnet)
  if (!fiveHour || !sevenDay || !sevenDayOpus || !sevenDaySonnet) return null
  const extraUsage = parseExtraUsage(value.extra_usage)
  if (extraUsage === null && value.extra_usage !== null) return null
  return {
    five_hour: fiveHour,
    seven_day: sevenDay,
    seven_day_opus: sevenDayOpus,
    seven_day_sonnet: sevenDaySonnet,
    extra_usage: extraUsage,
  }
}

function getCredentialsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR
    ?? path.join(process.env.HOME ?? "/root", ".claude")
  return path.join(configDir, ".credentials.json")
}

function readCredentials(): ClaudeCredentials | null {
  try {
    const credPath = getCredentialsPath()
    if (!fs.existsSync(credPath)) return null
    return JSON.parse(fs.readFileSync(credPath, "utf-8"))
  } catch {
    return null
  }
}

function refreshTokenIfNeeded(creds: ClaudeCredentials): void {
  const oauth = creds.claudeAiOauth
  if (!oauth) return
  const expiresAt = new Date(oauth.expiresAt).getTime()
  if (Date.now() < expiresAt) return

  try {
    execFileSync("claude", ["auth", "status"], {
      timeout: 10_000,
      stdio: "ignore",
    })
  } catch {
    // best-effort refresh
  }
}

export async function fetchClaudeUsage(): Promise<ClaudeUsageResponse | null> {
  try {
    let creds = readCredentials()
    if (!creds?.claudeAiOauth?.accessToken) return null

    refreshTokenIfNeeded(creds)
    // Re-read in case refresh updated the file
    creds = readCredentials()
    if (!creds?.claudeAiOauth?.accessToken) return null

    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${creds.claudeAiOauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
    })

    if (!res.ok) return null
    return parseClaudeUsageResponse(await res.json())
  } catch (err) {
    captureException(err, { operation: "claude-usage.fetch" })
    return null
  }
}
