import { execFile as execFileCb } from "node:child_process"
import type { CiConfig } from "../config/config-types.js"
import type { QualityReport } from "./quality-gates.js"
import { loggers } from "../logger.js"

const log = loggers.ciBabysit

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

const TERMINAL_ERROR_PATTERNS = [
  "could not resolve to a repository",
  "could not resolve to a pullrequest",
  "http 404",
  "http 403",
  "resource not accessible",
  "must have push access",
]

class TerminalGhError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TerminalGhError"
  }
}

function isTerminalError(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return TERMINAL_ERROR_PATTERNS.some((p) => lower.includes(p))
}

function execGh(
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb("gh", args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 30_000,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        if (isTerminalError(String(stderr))) {
          reject(new TerminalGhError(String(stderr).trim()))
        } else {
          reject(err)
        }
        return
      }
      resolve(String(stdout).trim())
    })
  })
}

export function extractPRUrl(conversationText: string): string | null {
  const match = conversationText.match(/https:\/\/github\.com\/[^\s)*\]>]+\/pull\/\d+/)
  return match ? match[0] : null
}

export async function findPRByBranch(branch: string, cwd: string): Promise<string | null> {
  try {
    const output = await execGh(
      ["pr", "list", "--head", branch, "--json", "url", "--jq", ".[0].url"],
      { cwd },
    )
    return output || null
  } catch {
    return null
  }
}

export async function waitForCI(prUrl: string, cwd: string, ciConfig: CiConfig): Promise<CIWaitResult> {
  const baseIntervalMs = ciConfig.pollIntervalMs
  const maxIntervalMs = Math.max(baseIntervalMs, 30_000)
  const timeoutMs = ciConfig.pollTimeoutMs
  const noChecksGraceMs = ciConfig.noChecksGraceMs ?? 120_000
  const startedAt = Date.now()
  let emptyChecksSince: number | null = null
  let pollCount = 0

  while (Date.now() - startedAt < timeoutMs) {
    const result = await getCheckStatus(prUrl, cwd)

    if (result?.terminal) {
      log.warn({ prUrl }, "terminal error from gh, aborting CI poll")
      return { passed: false, checks: [], timedOut: false }
    }

    if (result !== null) {
      if (result.checks.length === 0) {
        emptyChecksSince ??= Date.now()
        if (Date.now() - emptyChecksSince >= noChecksGraceMs) {
          log.info({ prUrl, graceMs: noChecksGraceMs }, "no checks appeared after grace period, treating as passed")
          return { passed: true, checks: [], timedOut: false }
        }
      } else {
        emptyChecksSince = null
        const pending = result.checks.filter((c) => c.bucket === "pending")
        if (pending.length === 0) {
          const failed = result.checks.filter((c) => c.bucket === "fail")
          return { passed: failed.length === 0, checks: result.checks, timedOut: false }
        }
      }
    }

    const delay = Math.min(baseIntervalMs * 2 ** pollCount, maxIntervalMs)
    pollCount++
    await sleep(delay)
  }

  const finalResult = await getCheckStatus(prUrl, cwd)
  return { passed: false, checks: finalResult?.checks ?? [], timedOut: true }
}

interface CheckStatusResult {
  checks: CICheckResult[]
  terminal: boolean
}

async function getCheckStatus(prUrl: string, cwd: string): Promise<CheckStatusResult | null> {
  try {
    const output = await execGh(
      ["pr", "checks", prUrl, "--json", "name,state,bucket"],
      { cwd },
    )

    if (!output || output === "[]") {
      log.debug({ prUrl }, "gh pr checks returned empty")
      return { checks: [], terminal: false }
    }
    const checks = JSON.parse(output) as CICheckResult[]
    log.debug({ prUrl, checkCount: checks.length }, "gh pr checks returned")
    return { checks, terminal: false }
  } catch (err) {
    if (err instanceof TerminalGhError) {
      log.error({ err, prUrl }, "gh pr checks failed with terminal error")
      return { checks: [], terminal: true }
    }
    const errMsg = String((err as Error).message ?? "")
    if (errMsg.includes("no checks reported")) {
      log.debug({ prUrl }, "no checks reported on branch")
      return { checks: [], terminal: false }
    }
    log.error({ err, prUrl }, "gh pr checks failed")
    return null
  }
}

export async function getFailedCheckLogs(prUrl: string, cwd: string): Promise<CIFailureDetail[]> {
  const runId = await getLatestRunId(prUrl, cwd)
  if (!runId) return []

  try {
    const output = await execGh(
      ["run", "view", runId, "--log-failed"],
      { cwd, timeoutMs: 60_000 },
    )
    return parseFailedLogs(output)
  } catch {
    return []
  }
}

async function getLatestRunId(prUrl: string, cwd: string): Promise<string | null> {
  const branch = await getBranchFromPR(prUrl, cwd)
  if (!branch) return null

  try {
    const output = await execGh(
      ["run", "list", "--branch", branch, "-L", "1", "--json", "databaseId,status,conclusion"],
      { cwd },
    )
    const runs = JSON.parse(output) as { databaseId: number }[]
    return runs[0]?.databaseId?.toString() ?? null
  } catch {
    return null
  }
}

async function getBranchFromPR(prUrl: string, cwd: string): Promise<string | null> {
  try {
    const output = await execGh(
      ["pr", "view", prUrl, "--json", "headRefName", "--jq", ".headRefName"],
      { cwd },
    )
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

export function buildQualityGateFixPrompt(
  prUrl: string,
  qualityReport: QualityReport,
  attempt: number,
  maxAttempts: number,
): string {
  const failed = qualityReport.results.filter((r) => !r.passed)
  const lines: string[] = [
    "## Local quality gate failures",
    "",
    `PR: ${prUrl}`,
    `Attempt: ${attempt}/${maxAttempts}`,
    "",
    "### Failed gates",
    "",
  ]

  for (const r of failed) {
    lines.push(`- **${r.gate}**`)
    if (r.output) {
      const trimmed = r.output.slice(-1500).trim()
      lines.push("```")
      lines.push(trimmed)
      lines.push("```")
    }
  }

  lines.push("")
  lines.push("---")
  lines.push("Fix the local quality gate failures above. Run the failing commands locally to verify before pushing.")

  return lines.join("\n")
}

export function buildMergeConflictPrompt(
  prUrl: string,
  attempt: number,
  maxAttempts: number,
): string {
  const lines: string[] = [
    "## Merge conflict resolution",
    "",
    `PR: ${prUrl}`,
    `Attempt: ${attempt}/${maxAttempts}`,
    "",
    "The pull request has merge conflicts with the base branch that must be resolved before CI can run.",
    "",
    "### Instructions",
    "",
    "1. Fetch the latest base branch: `git fetch origin main` (or master)",
    "2. Merge or rebase onto the base branch: `git merge origin/main` or `git rebase origin/main`",
    "3. Resolve any conflicts in the affected files",
    "4. Run local quality gates (tests, lint, typecheck) to verify the resolution didn't break anything",
    "5. Push the resolved changes",
    "",
    "---",
    "Resolve the merge conflicts above. Ensure tests pass locally before pushing.",
  ]

  return lines.join("\n")
}

export type MergeableState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN"

export async function checkPRMergeability(prUrl: string, cwd: string): Promise<MergeableState | null> {
  try {
    const output = await execGh(
      ["pr", "view", prUrl, "--json", "mergeable", "--jq", ".mergeable"],
      { cwd },
    )
    if (output === "MERGEABLE" || output === "CONFLICTING" || output === "UNKNOWN") {
      return output
    }
    return null
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
