import crypto from "node:crypto"
import fs from "node:fs"
import type { GitHubAppConfig } from "../config/config-types.js"
import { loggers } from "../logger.js"

const log = loggers.github

const REFRESH_MARGIN_MS = 5 * 60 * 1000
const REFRESH_INTERVAL_MS = 45 * 60 * 1000
const JWT_EXPIRY_SECONDS = 600

interface CachedToken {
  token: string
  expiresAt: number
}

export class GitHubTokenProvider {
  private readonly appConfig?: GitHubAppConfig
  private cached?: CachedToken
  private pendingRefresh?: Promise<string>
  private tokenFilePath?: string
  private refreshTimer?: ReturnType<typeof setInterval>

  constructor(appConfig?: GitHubAppConfig) {
    this.appConfig = appConfig
  }

  setTokenFilePath(p: string): void {
    this.tokenFilePath = p
  }

  startPeriodicRefresh(): void {
    if (!this.appConfig) return
    this.refreshTimer = setInterval(() => {
      this.refreshEnv().catch((err) => {
        log.warn({ err }, "periodic token refresh failed")
      })
    }, REFRESH_INTERVAL_MS)
    log.info({ intervalMinutes: Math.round(REFRESH_INTERVAL_MS / 60_000) }, "started periodic GitHub token refresh")
  }

  stopPeriodicRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = undefined
    }
  }

  get isAppAuth(): boolean {
    return this.appConfig != null
  }

  async getToken(): Promise<string> {
    if (!this.appConfig) {
      return process.env["GITHUB_TOKEN"] ?? ""
    }

    if (this.cached && Date.now() < this.cached.expiresAt - REFRESH_MARGIN_MS) {
      return this.cached.token
    }

    return this.refresh()
  }

  async refreshEnv(): Promise<void> {
    if (!this.appConfig) return
    const token = await this.getToken()
    process.env["GITHUB_TOKEN"] = token
    if (this.tokenFilePath) {
      try {
        fs.writeFileSync(this.tokenFilePath, token, { mode: 0o600 })
        process.env["GITHUB_TOKEN_FILE"] = this.tokenFilePath
      } catch {
        log.warn("failed to write token file")
      }
    }
    log.info("refreshed GITHUB_TOKEN from GitHub App installation token")
  }

  private async refresh(): Promise<string> {
    if (this.pendingRefresh) {
      return this.pendingRefresh
    }

    this.pendingRefresh = this.fetchInstallationToken()
    try {
      return await this.pendingRefresh
    } finally {
      this.pendingRefresh = undefined
    }
  }

  private signJwt(): string {
    const config = this.appConfig!
    const now = Math.floor(Date.now() / 1000)

    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
    const payload = Buffer.from(JSON.stringify({
      iat: now - 60,
      exp: now + JWT_EXPIRY_SECONDS,
      iss: config.appId,
    })).toString("base64url")

    const signingInput = `${header}.${payload}`
    const signature = crypto.sign("sha256", Buffer.from(signingInput), config.privateKey)

    return `${signingInput}.${signature.toString("base64url")}`
  }

  private async fetchInstallationToken(): Promise<string> {
    const config = this.appConfig!
    const jwt = this.signJwt()

    const response = await fetch(
      `https://api.github.com/app/installations/${config.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    )

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `GitHub App token request failed (${response.status}): ${body}`,
      )
    }

    const data = (await response.json()) as { token: string; expires_at: string }
    this.cached = {
      token: data.token,
      expiresAt: new Date(data.expires_at).getTime(),
    }

    log.info({ expiresAt: data.expires_at }, "obtained GitHub App installation token")
    return data.token
  }
}
