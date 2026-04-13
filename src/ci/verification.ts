import { execSync } from "node:child_process"
import type { CiConfig } from "../config/config-types.js"
import type { QualityReport } from "./quality-gates.js"
import { runQualityGates } from "./quality-gates.js"
import { checkPRMergeability, waitForCI } from "./ci-babysit.js"
import type { MergeableState, CIWaitResult } from "./ci-babysit.js"
import { loggers } from "../logger.js"

const log = loggers.verification

export interface VerificationResult {
  passed: boolean
  details: string
}

export interface MergeConflictResult extends VerificationResult {
  state: MergeableState | null
}

export interface CIVerificationResult extends VerificationResult {
  ciResult: CIWaitResult
}

export interface QualityGateResult extends VerificationResult {
  report: QualityReport
}

const GIT_TIMEOUT_MS = 120_000

function execGit(cmd: string, cwd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
    return { ok: true, output: output.toString().trim() }
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string }
    const out = e.stdout?.toString().trim() ?? ""
    const stderr = e.stderr?.toString().trim() ?? ""
    return { ok: false, output: (out + "\n" + stderr).trim() || e.message || "unknown error" }
  }
}

/**
 * Check whether a PR has merge conflicts with its base branch.
 */
export async function checkMergeConflicts(prUrl: string, cwd: string): Promise<MergeConflictResult> {
  const state = await checkPRMergeability(prUrl, cwd)

  if (state === null) {
    return { passed: false, state: null, details: "Could not determine merge state" }
  }

  if (state === "UNKNOWN") {
    await sleep(5_000)
    const retry = await checkPRMergeability(prUrl, cwd)
    if (retry === "MERGEABLE") {
      return { passed: true, state: retry, details: "No merge conflicts" }
    }
    return {
      passed: false,
      state: retry ?? "UNKNOWN",
      details: retry === "CONFLICTING" ? "PR has merge conflicts with base branch" : "Merge state unknown after retry",
    }
  }

  if (state === "CONFLICTING") {
    return { passed: false, state, details: "PR has merge conflicts with base branch" }
  }

  return { passed: true, state, details: "No merge conflicts" }
}

/**
 * Wait for CI checks to complete on a PR and return the result.
 */
export async function checkCI(prUrl: string, cwd: string, ciConfig: CiConfig): Promise<CIVerificationResult> {
  const ciResult = await waitForCI(prUrl, cwd, ciConfig)

  if (ciResult.timedOut) {
    const pending = ciResult.checks.filter((c) => c.bucket === "pending")
    return {
      passed: false,
      ciResult,
      details: `CI timed out with ${pending.length} pending check(s)`,
    }
  }

  if (!ciResult.passed) {
    const failed = ciResult.checks.filter((c) => c.bucket === "fail")
    const names = failed.map((c) => c.name).join(", ")
    return {
      passed: false,
      ciResult,
      details: `CI failed: ${names}`,
    }
  }

  return {
    passed: true,
    ciResult,
    details: `All ${ciResult.checks.length} CI check(s) passed`,
  }
}

/**
 * Run local quality gates (tests, typecheck, lint) on a working directory.
 */
export function checkTests(cwd: string): QualityGateResult {
  const report = runQualityGates(cwd)

  if (!report.allPassed) {
    const failed = report.results.filter((r) => !r.passed)
    const names = failed.map((r) => r.gate).join(", ")
    return {
      passed: false,
      report,
      details: `Quality gates failed: ${names}`,
    }
  }

  const gates = report.results.map((r) => r.gate).join(", ")
  return {
    passed: true,
    report,
    details: report.results.length > 0 ? `All quality gates passed: ${gates}` : "No quality gates detected",
  }
}

/**
 * Build a prompt for a verification agent that reviews whether a DAG node's
 * implementation matches its specification.
 */
export function buildCompletenessReviewPrompt(
  nodeTitle: string,
  nodeDescription: string,
  branch: string,
  prUrl: string,
): string {
  return [
    "## Code completeness review",
    "",
    `**Task:** ${nodeTitle}`,
    `**Description:** ${nodeDescription}`,
    `**Branch:** ${branch}`,
    `**PR:** ${prUrl}`,
    "",
    "### Instructions",
    "",
    "Review the code changes on this branch and verify they fully implement the task described above.",
    "",
    "Check for:",
    "1. All requirements from the description are implemented",
    "2. No placeholder or TODO code left behind",
    "3. No obvious logic errors or missing edge cases",
    "4. Tests cover the new functionality",
    "",
    "### Output format",
    "",
    "If the implementation is complete and correct, output exactly:",
    "```",
    "VERIFICATION PASSED",
    "```",
    "",
    "If there are issues, describe each one concretely and fix them.",
    "After fixing, re-run quality gates to ensure nothing broke.",
    "Then output:",
    "```",
    "VERIFICATION PASSED",
    "```",
  ].join("\n")
}

/**
 * Parse the output of a completeness review session to determine pass/fail.
 */
export function parseCompletenessResult(sessionOutput: string): VerificationResult {
  const passed = sessionOutput.includes("VERIFICATION PASSED")
  return {
    passed,
    details: passed
      ? "Completeness review passed"
      : "Completeness review found issues",
  }
}

/**
 * Fetch latest main and rebase a branch onto it.
 */
export function rebaseOntoMain(branch: string, cwd: string): VerificationResult {
  log.info({ branch, cwd }, "rebasing branch onto main")

  const fetch = execGit("git fetch origin", cwd)
  if (!fetch.ok) {
    log.error({ branch, output: fetch.output }, "git fetch failed")
    return { passed: false, details: `git fetch failed: ${fetch.output}` }
  }

  const defaultBranch = detectDefaultBranch(cwd)
  if (!defaultBranch) {
    return { passed: false, details: "Could not determine default branch" }
  }

  const checkout = execGit(`git checkout ${JSON.stringify(branch)}`, cwd)
  if (!checkout.ok) {
    log.error({ branch, output: checkout.output }, "git checkout failed")
    return { passed: false, details: `git checkout failed: ${checkout.output}` }
  }

  const fetchBase = execGit(`git fetch origin ${JSON.stringify(defaultBranch)}`, cwd)
  if (!fetchBase.ok) {
    log.error({ branch, defaultBranch, output: fetchBase.output }, "git fetch base branch failed")
    return { passed: false, details: `Fetch failed: ${fetchBase.output}` }
  }

  const rebase = execGit(`git rebase ${JSON.stringify(defaultBranch)}`, cwd)
  if (!rebase.ok) {
    execGit("git rebase --abort", cwd)
    log.error({ branch, output: rebase.output }, "git rebase failed")
    return { passed: false, details: `Rebase failed (conflicts likely): ${rebase.output}` }
  }

  const push = execGit(`git push --force-with-lease origin ${JSON.stringify(branch)}`, cwd)
  if (!push.ok) {
    log.error({ branch, output: push.output }, "git push failed after rebase")
    return { passed: false, details: `Push failed after rebase: ${push.output}` }
  }

  log.info({ branch, defaultBranch }, "rebase and push succeeded")
  return { passed: true, details: `Rebased ${branch} onto ${defaultBranch} and pushed` }
}

function detectDefaultBranch(cwd: string): string | null {
  const gh = execGit("gh repo view --json defaultBranchRef --jq .defaultBranchRef.name", cwd)
  if (gh.ok && gh.output) return gh.output

  for (const name of ["main", "master"]) {
    const check = execGit(`git rev-parse --verify refs/heads/${name}`, cwd)
    if (check.ok) return name
  }

  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
