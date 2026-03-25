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
    return await res.json() as ClaudeUsageResponse
  } catch (err) {
    captureException(err, { operation: "claude-usage.fetch" })
    return null
  }
}
