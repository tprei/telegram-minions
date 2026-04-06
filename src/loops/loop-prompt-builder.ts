import type { LoopDefinition, LoopState, LoopOutcome } from "./domain-types.js"

export interface LoopPromptContext {
  definition: LoopDefinition
  repo: string
  state?: LoopState
}

export function buildLoopPrompt(ctx: LoopPromptContext): string {
  const { definition, repo, state } = ctx
  const sections: string[] = []

  sections.push(buildPreamble(repo))
  sections.push(definition.prompt)

  if (state && state.totalRuns > 0) {
    sections.push(buildRunHistory(state))
  }

  sections.push(buildDeduplicationGuard(state))
  sections.push(buildFooter())

  return sections.join("\n\n")
}

function buildPreamble(repo: string): string {
  return [
    "You are a coding minion running in a sandboxed environment.",
    "Your working directory is a fresh clone — local changes do not persist after this session ends.",
    "",
    `Repository: ${repo}`,
    "",
    "To deliver your work, you MUST:",
    "1. A branch has already been created for you — use `git branch --show-current` to confirm its name. Do NOT create a new branch.",
    "2. Commit your changes to that branch",
    "3. Push the branch and open a pull request using `gh pr create`",
    "If you skip the PR, your work is lost.",
    "",
    "The `gh` CLI is available and authenticated via GITHUB_TOKEN.",
    "Use conventional commit messages: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.",
    "Stage specific files, not `git add .`.",
    "Never commit `.env`, credentials, or secrets.",
    "Never push to `main` or `master` directly.",
    "",
    "Dependencies (`node_modules`) are pre-installed in your workspace. Do NOT run `npm install`, `npm ci`, or install any packages.",
    "",
    "## Loop context",
    "",
    "This is an automated loop run, not a human-initiated task. You run on a schedule to make small, incremental improvements.",
    "If you cannot find anything to fix, that is a VALID outcome — simply report that you found nothing.",
    "Do NOT force changes or make unnecessary modifications to justify a PR.",
  ].join("\n")
}

function buildRunHistory(state: LoopState): string {
  const recentOutcomes = state.outcomes.slice(-5)
  if (recentOutcomes.length === 0) return ""

  const lines: string[] = [
    "## Previous run history",
    "",
    `Total runs so far: ${state.totalRuns}`,
    `Consecutive failures: ${state.consecutiveFailures}`,
    "",
    "Recent outcomes (most recent last):",
  ]

  for (const outcome of recentOutcomes) {
    lines.push(formatOutcome(outcome))
  }

  if (state.lastPrUrl) {
    lines.push("")
    lines.push(`Most recent PR: ${state.lastPrUrl}`)
  }

  lines.push("")
  lines.push("Use this history to avoid duplicating previous work. Pick a DIFFERENT target than recent runs.")

  return lines.join("\n")
}

function formatOutcome(outcome: LoopOutcome): string {
  const date = new Date(outcome.startedAt).toISOString().slice(0, 16)
  const parts = [`- Run #${outcome.runNumber} (${date}): ${outcome.result}`]

  if (outcome.prUrl) {
    parts.push(` — PR: ${outcome.prUrl}`)
  }
  if (outcome.error) {
    const truncated = outcome.error.length > 120
      ? outcome.error.slice(0, 120) + "..."
      : outcome.error
    parts.push(` — error: ${truncated}`)
  }

  return parts.join("")
}

function buildDeduplicationGuard(state?: LoopState): string {
  const lines: string[] = [
    "## Deduplication rules",
    "",
    "Before starting work, check for existing open PRs that address the same issue:",
    "1. Run `gh pr list --state open --label minions` to see open minion PRs",
    "2. If a PR already covers your intended change, report no_findings instead of duplicating",
  ]

  if (state?.lastPrUrl) {
    lines.push(`3. Your most recent PR was: ${state.lastPrUrl} — do NOT open a PR for the same change`)
  }

  return lines.join("\n")
}

function buildFooter(): string {
  return [
    "## Reporting outcome",
    "",
    "When your coding work is complete, use the `post-task-router` agent to classify the next action and delegate appropriately.",
    "",
    "If you found nothing to fix:",
    "- Do NOT create a branch or PR",
    '- Simply output: "NO_FINDINGS: <brief explanation of what you searched>"',
    "- The loop scheduler will record this as a no_findings outcome",
  ].join("\n")
}
