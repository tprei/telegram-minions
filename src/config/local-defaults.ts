import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { execSync } from "node:child_process"

/**
 * Detect whether the process is running on a developer workstation — i.e.
 * outside the prod container image. Used to apply smart defaults that make
 * `npm run dev` / `docker compose up` work without a wall of env vars.
 *
 * Heuristics (any positive match flips to "local"):
 *   - `/workspace` volume absent (the Fly image mounts a volume there)
 *   - `IS_SANDBOX` is set and not "true"
 *   - `MINION_LOCAL_MODE=true` set explicitly
 */
export function isLocalEnvironment(): boolean {
  if (process.env["MINION_LOCAL_MODE"] === "true") return true
  if (process.env["MINION_LOCAL_MODE"] === "false") return false
  // Fly deploy sets IS_SANDBOX=true inside container
  if (process.env["IS_SANDBOX"] === "true") return false
  if (process.env["FLY_APP_NAME"] || process.env["FLY_MACHINE_ID"]) return false

  // If /workspace exists and is a directory owned by us, assume container.
  try {
    if (fs.existsSync("/workspace") && fs.statSync("/workspace").isDirectory()) {
      return false
    }
  } catch {
    // ignore
  }
  return true
}

/** Load-or-generate an API token under `${workspaceRoot}/.api-token`. */
export function loadOrCreateApiToken(workspaceRoot: string): string {
  const tokenPath = path.join(workspaceRoot, ".api-token")
  try {
    if (fs.existsSync(tokenPath)) {
      const existing = fs.readFileSync(tokenPath, "utf8").trim()
      if (existing.length >= 32) return existing
    }
  } catch {
    // fall through — regenerate
  }
  const token = crypto.randomBytes(32).toString("hex")
  try {
    fs.mkdirSync(workspaceRoot, { recursive: true })
    fs.writeFileSync(tokenPath, token + "\n", { mode: 0o600 })
  } catch {
    // non-fatal — in-memory token still works for this process
  }
  return token
}

/** Return `gh auth token` output if `gh` is on PATH and authenticated. */
export function ghAuthToken(): string | undefined {
  try {
    const out = execSync("gh auth token", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).toString().trim()
    if (out.length > 0) return out
  } catch {
    // gh missing or not authed
  }
  return undefined
}

export interface LocalDefaultsResult {
  workspaceRoot: string
  apiToken: string
  apiPort: number
  githubToken: string | undefined
  corsAllowedOrigins: string[]
  /** Side-effect logs emitted while resolving defaults. CLI prints these once at boot. */
  notices: string[]
}

/**
 * Resolve local-mode defaults. All fields are computed only when the user
 * hasn't already set the matching env var — explicit config always wins.
 */
export function resolveLocalDefaults(): LocalDefaultsResult {
  const notices: string[] = []

  const explicitRoot = process.env["WORKSPACE_ROOT"]
  const workspaceRoot = explicitRoot && explicitRoot.trim().length > 0
    ? explicitRoot
    : path.resolve(process.cwd(), ".minion-data")
  if (!explicitRoot) {
    notices.push(`WORKSPACE_ROOT not set — using ${workspaceRoot}`)
  }

  const explicitToken = process.env["MINION_API_TOKEN"]
  const apiToken = explicitToken && explicitToken.trim().length > 0
    ? explicitToken
    : loadOrCreateApiToken(workspaceRoot)
  if (!explicitToken) {
    notices.push(`MINION_API_TOKEN not set — generated and saved to ${path.join(workspaceRoot, ".api-token")}`)
  }

  const explicitPort = process.env["API_PORT"]
  const parsedPort = explicitPort ? Number(explicitPort) : NaN
  const apiPort = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8080
  if (!explicitPort) {
    notices.push(`API_PORT not set — defaulting to ${apiPort}`)
  }

  const explicitGhToken = process.env["GITHUB_TOKEN"]
  let githubToken: string | undefined = explicitGhToken && explicitGhToken.trim().length > 0
    ? explicitGhToken
    : undefined
  if (!githubToken) {
    const fromGh = ghAuthToken()
    if (fromGh) {
      githubToken = fromGh
      notices.push("GITHUB_TOKEN not set — using `gh auth token`")
    }
  }

  const explicitCors = process.env["CORS_ALLOWED_ORIGINS"]
  const corsAllowedOrigins = explicitCors && explicitCors.trim().length > 0
    ? explicitCors.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : [`http://localhost:5173`, `http://localhost:3000`, `http://localhost:${apiPort}`]
  if (!explicitCors) {
    notices.push(`CORS_ALLOWED_ORIGINS not set — allowing localhost:5173, localhost:3000, localhost:${apiPort}`)
  }

  return {
    workspaceRoot,
    apiToken,
    apiPort,
    githubToken,
    corsAllowedOrigins,
    notices,
  }
}

/**
 * Mutate `process.env` so downstream `configFromEnv()` picks up the defaults.
 * Only sets variables that are unset / empty — explicit config always wins.
 * Returns the list of human-readable notices for the caller to log.
 */
export function applyLocalDefaults(): string[] {
  const defaults = resolveLocalDefaults()
  if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = defaults.workspaceRoot
  if (!process.env["MINION_API_TOKEN"]) process.env["MINION_API_TOKEN"] = defaults.apiToken
  if (!process.env["API_PORT"]) process.env["API_PORT"] = String(defaults.apiPort)
  if (!process.env["GITHUB_TOKEN"] && defaults.githubToken) process.env["GITHUB_TOKEN"] = defaults.githubToken
  if (!process.env["CORS_ALLOWED_ORIGINS"]) process.env["CORS_ALLOWED_ORIGINS"] = defaults.corsAllowedOrigins.join(",")
  return defaults.notices
}
