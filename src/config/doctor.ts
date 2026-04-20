import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { execSync } from "node:child_process"

export type CheckStatus = "ok" | "warn" | "fail"

export interface DoctorCheck {
  name: string
  status: CheckStatus
  message: string
  fix?: string
}

export interface DoctorReport {
  ok: boolean
  checks: DoctorCheck[]
}

function which(cmd: string): string | undefined {
  try {
    const out = execSync(`command -v ${cmd}`, {
      stdio: ["ignore", "pipe", "ignore"],
      shell: "/bin/sh",
    }).toString().trim()
    return out.length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.once("listening", () => {
      server.close(() => resolve(true))
    })
    server.listen(port, "127.0.0.1")
  })
}

function canWriteDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.minion-probe-${process.pid}`)
    fs.writeFileSync(probe, "probe")
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

export function checkNodeVersion(): DoctorCheck {
  const raw = process.versions.node
  const major = Number(raw.split(".")[0])
  if (major >= 22) {
    return { name: "Node.js", status: "ok", message: `v${raw}` }
  }
  if (major >= 20) {
    return {
      name: "Node.js",
      status: "warn",
      message: `v${raw} (project expects >= 22)`,
      fix: "Install Node 22 — e.g. `nvm install 22 && nvm use 22`",
    }
  }
  return {
    name: "Node.js",
    status: "fail",
    message: `v${raw} is too old`,
    fix: "Install Node 22 — e.g. `nvm install 22 && nvm use 22`",
  }
}

export function checkClaudeCli(): DoctorCheck {
  const bin = which("claude")
  if (!bin) {
    return {
      name: "claude CLI",
      status: "warn",
      message: "not found on PATH (only needed for GOOSE_PROVIDER=claude-acp)",
      fix: "npm install -g @anthropic-ai/claude-code @zed-industries/claude-agent-acp",
    }
  }
  const home = process.env["HOME"] ?? os.homedir()
  const credsPath = path.join(home, ".claude", ".credentials.json")
  if (!fs.existsSync(credsPath)) {
    return {
      name: "claude CLI",
      status: "warn",
      message: `${bin} installed but not logged in`,
      fix: "Run `claude auth login` (opens browser for OAuth)",
    }
  }
  return { name: "claude CLI", status: "ok", message: `${bin} (authed)` }
}

export function checkGhAuth(): DoctorCheck {
  const bin = which("gh")
  if (!bin) {
    return {
      name: "GitHub CLI (gh)",
      status: "warn",
      message: "not found — GITHUB_TOKEN must be set manually",
      fix: "Install gh: https://cli.github.com/ , then `gh auth login`",
    }
  }
  try {
    execSync("gh auth status", { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 })
    return { name: "GitHub CLI (gh)", status: "ok", message: `${bin} (authed)` }
  } catch {
    return {
      name: "GitHub CLI (gh)",
      status: "warn",
      message: `${bin} installed but not authenticated`,
      fix: "Run `gh auth login`",
    }
  }
}

export function checkGoose(): DoctorCheck {
  const bin = which("goose")
  if (!bin) {
    return {
      name: "goose",
      status: "warn",
      message: "not found on PATH (required when running Goose-backed sessions)",
      fix: "Install goose: https://block.github.io/goose/docs/getting-started/installation",
    }
  }
  return { name: "goose", status: "ok", message: bin }
}

export function checkGitHubToken(): DoctorCheck {
  const fromEnv = process.env["GITHUB_TOKEN"]
  if (fromEnv && fromEnv.trim().length > 0) {
    return { name: "GITHUB_TOKEN", status: "ok", message: "set via environment" }
  }
  // can we fall back to gh?
  const gh = which("gh")
  if (gh) {
    try {
      const tok = execSync("gh auth token", {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).toString().trim()
      if (tok.length > 0) {
        return { name: "GITHUB_TOKEN", status: "ok", message: "available via `gh auth token`" }
      }
    } catch {
      // fall through
    }
  }
  return {
    name: "GITHUB_TOKEN",
    status: "warn",
    message: "not set and `gh auth token` unavailable",
    fix: "Export GITHUB_TOKEN=... or run `gh auth login`",
  }
}

export function checkWorkspaceRoot(): DoctorCheck {
  const root = process.env["WORKSPACE_ROOT"] ?? path.resolve(process.cwd(), ".minion-data")
  if (canWriteDir(root)) {
    return { name: "WORKSPACE_ROOT", status: "ok", message: `${root} (writable)` }
  }
  return {
    name: "WORKSPACE_ROOT",
    status: "fail",
    message: `${root} is not writable`,
    fix: `Pick a writable path: export WORKSPACE_ROOT=$HOME/.minion-data`,
  }
}

export async function checkApiPort(): Promise<DoctorCheck> {
  const raw = process.env["API_PORT"] ?? "8080"
  const port = Number(raw)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return {
      name: "API_PORT",
      status: "fail",
      message: `invalid port "${raw}"`,
      fix: "Set API_PORT to a number between 1 and 65535",
    }
  }
  const free = await isPortFree(port)
  if (free) {
    return { name: "API_PORT", status: "ok", message: `${port} (free)` }
  }
  return {
    name: "API_PORT",
    status: "warn",
    message: `${port} is already in use`,
    fix: `Pick a different port: export API_PORT=8081 — or stop whatever's listening (lsof -i :${port})`,
  }
}

export function checkTelegram(): DoctorCheck {
  const token = process.env["TELEGRAM_BOT_TOKEN"]
  if (!token) {
    return {
      name: "Telegram (optional)",
      status: "ok",
      message: "not configured — running PWA-only",
    }
  }
  const chat = process.env["TELEGRAM_CHAT_ID"]
  const users = process.env["ALLOWED_USER_IDS"]
  if (!chat || !users) {
    return {
      name: "Telegram",
      status: "warn",
      message: "TELEGRAM_BOT_TOKEN set but TELEGRAM_CHAT_ID/ALLOWED_USER_IDS missing",
      fix: "Set all three — or unset TELEGRAM_BOT_TOKEN to boot PWA-only",
    }
  }
  return { name: "Telegram", status: "ok", message: "configured" }
}

export function checkMinionApiToken(): DoctorCheck {
  const tok = process.env["MINION_API_TOKEN"]
  if (tok && tok.length >= 32) {
    return { name: "MINION_API_TOKEN", status: "ok", message: "set (≥32 chars)" }
  }
  if (tok) {
    return {
      name: "MINION_API_TOKEN",
      status: "warn",
      message: "set but short (<32 chars)",
      fix: "Generate a strong token: openssl rand -hex 32",
    }
  }
  return {
    name: "MINION_API_TOKEN",
    status: "warn",
    message: "not set — local mode will auto-generate one under WORKSPACE_ROOT/.api-token",
  }
}

const statusIcon: Record<CheckStatus, string> = {
  ok: "[ok]  ",
  warn: "[warn]",
  fail: "[fail]",
}

function renderCheck(check: DoctorCheck): string {
  const lines = [`${statusIcon[check.status]} ${check.name}: ${check.message}`]
  if (check.fix && check.status !== "ok") {
    lines.push(`        → ${check.fix}`)
  }
  return lines.join("\n")
}

export function renderReport(report: DoctorReport): string {
  const header = "telegram-minion doctor\n" + "=".repeat(24)
  const body = report.checks.map(renderCheck).join("\n")
  const summary = report.ok
    ? "All checks passed."
    : "Some checks failed — fix the items above and re-run `telegram-minion doctor`."
  return [header, body, "", summary].join("\n") + "\n"
}

export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    checkNodeVersion(),
    checkWorkspaceRoot(),
    await checkApiPort(),
    checkMinionApiToken(),
    checkGitHubToken(),
    checkGhAuth(),
    checkClaudeCli(),
    checkGoose(),
    checkTelegram(),
  ]
  const ok = checks.every((c) => c.status !== "fail")
  const report: DoctorReport = { ok, checks }
  process.stdout.write(renderReport(report))
  return report
}
