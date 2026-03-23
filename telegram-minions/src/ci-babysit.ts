import { execSync } from "node:child_process"
import { config } from "./config.js"

export interface CICheckResult {
  name: string
  state: "success" | "failure" | "pending" | "queued" | "cancelled" | string
  bucket: string
}

export interface CIWaitResult {
  passed: boolean
  checks: CICheckResult[]
  timedOut: boolean
}

export interface CIFailureDetail {
  checkName: string
  logs: string
}

const LOG_TAIL_CHARS = 3000

export function extractPRUrl(conversationText: string): string | null {
  const match = conversationText.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/)
  return match ? match[0] : null
}

export async function waitForCI(prUrl: string, cwd: string): Promise<CIWaitResult> {
  const intervalMs = config.ci.pollIntervalMs
  const timeoutMs = config.ci.pollTimeoutMs
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const checks = getCheckStatus(prUrl, cwd)
    if (checks === null) {
      return { passed: false, checks: [], timedOut: true }
    }

    const pending = checks.filter((c) => c.state === "pending" || c.state === "queued")
    if (pending.length === 0 && checks.length > 0) {
      const failed = checks.filter((c) => c.state !== "success")
      return { passed: failed.length === 0, checks, timedOut: false }
    }

    await sleep(intervalMs)
  }

  const finalChecks = getCheckStatus(prUrl, cwd) ?? []
  return { passed: false, checks: finalChecks, timedOut: true }
}

function getCheckStatus(prUrl: string, cwd: string): CICheckResult[] | null {
  try {
    const output = execSync(
      `gh pr checks ${JSON.stringify(prUrl)} --json name,state,bucket`,
      {
        cwd,
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    ).toString().trim()

    if (!output || output === "[]") return []
    return JSON.parse(output) as CICheckResult[]
  } catch {
    return null
  }
}

export function getFailedCheckLogs(prUrl: string, cwd: string): CIFailureDetail[] {
  const runId = getLatestRunId(prUrl, cwd)
  if (!runId) return []

  try {
    const output = execSync(
      `gh run view ${runId} --log-failed`,
      {
        cwd,
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    ).toString()

    return parseFailedLogs(output)
  } catch {
    return []
  }
}

function getLatestRunId(prUrl: string, cwd: string): string | null {
  const branchMatch = getBranchFromPR(prUrl, cwd)
  if (!branchMatch) return null

  try {
    const output = execSync(
      `gh run list --branch ${JSON.stringify(branchMatch)} -L 1 --json databaseId,status,conclusion`,
      {
        cwd,
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    ).toString().trim()

    const runs = JSON.parse(output) as { databaseId: number }[]
    return runs[0]?.databaseId?.toString() ?? null
  } catch {
    return null
  }
}

function getBranchFromPR(prUrl: string, cwd: string): string | null {
  try {
    const output = execSync(
      `gh pr view ${JSON.stringify(prUrl)} --json headRefName --jq .headRefName`,
      {
        cwd,
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    ).toString().trim()

    return output || null
  } catch {
    return null
  }
}

function parseFailedLogs(raw: string): CIFailureDetail[] {
  const sections = new Map<string, string>()
  let currentCheck = ""

  for (const line of raw.split("\n")) {
    const headerMatch = line.match(/^(.+?)\t/)
    if (headerMatch) {
      currentCheck = headerMatch[1].trim()
      const existing = sections.get(currentCheck) ?? ""
      sections.set(currentCheck, existing + line + "\n")
    } else if (currentCheck) {
      const existing = sections.get(currentCheck) ?? ""
      sections.set(currentCheck, existing + line + "\n")
    }
  }

  const details: CIFailureDetail[] = []
  for (const [checkName, logs] of sections) {
    const trimmed = logs.length > LOG_TAIL_CHARS
      ? logs.slice(-LOG_TAIL_CHARS)
      : logs
    details.push({ checkName, logs: trimmed.trim() })
  }

  return details
}

export function buildCIFixPrompt(
  prUrl: string,
  failedChecks: CICheckResult[],
  failureDetails: CIFailureDetail[],
  attempt: number,
  maxAttempts: number,
): string {
  const lines: string[] = [
    "## CI failure context",
    "",
    `PR: ${prUrl}`,
    `Attempt: ${attempt}/${maxAttempts}`,
    "",
    "### Failed checks",
    "",
  ]

  for (const check of failedChecks) {
    lines.push(`- **${check.name}** (${check.state})`)
  }

  if (failureDetails.length > 0) {
    lines.push("")
    lines.push("### Failure logs")

    for (const detail of failureDetails) {
      lines.push("")
      lines.push(`#### ${detail.checkName}`)
      lines.push("```")
      lines.push(detail.logs)
      lines.push("```")
    }
  }

  lines.push("")
  lines.push("---")
  lines.push("Fix the failures above. Run the failing commands locally to verify before pushing.")

  return lines.join("\n")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
