/**
 * Command parsing utilities for Telegram bot commands.
 * Extracts repo URLs, task descriptions, and builds keyboard UIs.
 */

// Command prefixes
export const TASK_PREFIX = "/task"
export const TASK_SHORT = "/w"
export const PLAN_PREFIX = "/plan"
export const THINK_PREFIX = "/think"
export const REVIEW_PREFIX = "/review"
export const EXECUTE_CMD = "/execute"
export const STATUS_CMD = "/status"
export const STATS_CMD = "/stats"
export const REPLY_PREFIX = "/reply"
export const REPLY_SHORT = "/r"
export const CLOSE_CMD = "/close"
export const STOP_CMD = "/stop"
export const HELP_CMD = "/help"
export const CLEAN_CMD = "/clean"
export const USAGE_CMD = "/usage"
export const CONFIG_CMD = "/config"
export const SPLIT_CMD = "/split"
export const STACK_CMD = "/stack"
export const DAG_CMD = "/dag"
export const LAND_CMD = "/land"
export const RUN_CMD = "/run"
export const RETRY_CMD = "/retry"

/**
 * Parse task arguments to extract repo URL and task description.
 * Supports:
 * - `/task https://github.com/org/repo Description of the task`
 * - `/task repo-alias Description of the task`
 * - `/task Description of the task (no repo)`
 */
export function parseTaskArgs(
  repos: Record<string, string>,
  args: string,
): { repoUrl?: string; task: string } {
  const urlPattern = /^(https?:\/\/[^\s]+)\s+([\s\S]+)$/
  const match = urlPattern.exec(args)

  if (match) {
    return { repoUrl: match[1], task: match[2].trim() }
  }

  // Check for repo alias as first word
  const spaceIdx = args.indexOf(" ")
  if (spaceIdx > 0) {
    const firstWord = args.slice(0, spaceIdx)
    const aliasUrl = repos[firstWord]
    if (aliasUrl) {
      return { repoUrl: aliasUrl, task: args.slice(spaceIdx + 1).trim() }
    }
  }

  return { task: args.trim() }
}

/**
 * Parse review command arguments to extract repo URL and task description.
 * Supports:
 * - `/review https://github.com/org/repo 123` (PR number)
 * - `/review https://github.com/org/repo` (review all)
 * - `/review repo-alias 123` (alias + PR number)
 * - `/review repo-alias` (alias, review all)
 * - `/review 123` (PR number, no repo - uses configured repos)
 */
export function parseReviewArgs(
  repos: Record<string, string>,
  args: string,
): { repoUrl?: string; task: string } {
  if (!args) return { task: "" }

  const urlPrPattern = /^(https?:\/\/[^\s]+)\s+(\d+)$/
  const urlPrMatch = urlPrPattern.exec(args)
  if (urlPrMatch) {
    return { repoUrl: urlPrMatch[1], task: `Review PR #${urlPrMatch[2]}` }
  }

  const urlOnlyPattern = /^(https?:\/\/[^\s]+)$/
  const urlOnlyMatch = urlOnlyPattern.exec(args)
  if (urlOnlyMatch) {
    return { repoUrl: urlOnlyMatch[1], task: "" }
  }

  const parts = args.split(/\s+/)
  const firstWord = parts[0]
  const aliasUrl = repos[firstWord]
  if (aliasUrl) {
    const rest = parts.slice(1).join(" ").trim()
    if (/^\d+$/.test(rest)) {
      return { repoUrl: aliasUrl, task: `Review PR #${rest}` }
    }
    if (!rest) {
      return { repoUrl: aliasUrl, task: "" }
    }
    return { repoUrl: aliasUrl, task: rest }
  }

  if (/^\d+$/.test(args.trim())) {
    return { task: `Review PR #${args.trim()}` }
  }

  return { task: args.trim() }
}

/**
 * Build a task description for reviewing all unreviewed PRs in a repo.
 */
export function buildReviewAllTask(repoUrl: string): string {
  const repo = extractRepoName(repoUrl)
  return [
    `Review all open pull requests in ${repo} that have no reviews yet.`,
    "",
    "Steps:",
    `1. Run \`gh pr list --repo ${repoUrl} --state open --json number,title,reviewDecision\` to find open PRs`,
    "2. Filter to PRs where reviewDecision is empty or REVIEW_REQUIRED",
    "3. For each unreviewed PR, review it following the review workflow in your system prompt",
    "4. If there are no unreviewed PRs, report that back",
  ].join("\n")
}

/**
 * Build an inline keyboard for repo selection.
 */
export function buildRepoKeyboard(
  repoKeys: string[],
  prefix: "repo" | "plan" | "think" | "review" = "repo",
): { text: string; callback_data: string }[][] {
  const dataPrefix =
    prefix === "think"
      ? "think-repo"
      : prefix === "plan"
        ? "plan-repo"
        : prefix === "review"
          ? "review-repo"
          : "repo"
  const rows: { text: string; callback_data: string }[][] = []
  for (let i = 0; i < repoKeys.length; i += 2) {
    const row = [{ text: repoKeys[i], callback_data: `${dataPrefix}:${repoKeys[i]}` }]
    if (i + 1 < repoKeys.length) {
      row.push({
        text: repoKeys[i + 1],
        callback_data: `${dataPrefix}:${repoKeys[i + 1]}`,
      })
    }
    rows.push(row)
  }
  return rows
}

/**
 * Build an inline keyboard for profile selection.
 */
export function buildProfileKeyboard(
  profiles: { id: string; name: string }[],
): { text: string; callback_data: string }[][] {
  const rows: { text: string; callback_data: string }[][] = []
  for (let i = 0; i < profiles.length; i += 2) {
    const row = [
      { text: profiles[i].name, callback_data: `profile:${profiles[i].id}` },
    ]
    if (i + 1 < profiles.length) {
      row.push({
        text: profiles[i + 1].name,
        callback_data: `profile:${profiles[i + 1].id}`,
      })
    }
    rows.push(row)
  }
  return rows
}

/**
 * Escape HTML special characters for Telegram messages.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * Extract the repo name from a URL.
 * e.g., "https://github.com/org/my-repo" -> "my-repo"
 */
export function extractRepoName(url: string): string {
  try {
    const parts = url.replace(/\.git$/, "").split("/")
    const last = parts[parts.length - 1]
    return last || "repo"
  } catch {
    return "repo"
  }
}

/**
 * Append image context to a task description.
 */
export function appendImageContext(task: string, imagePaths: string[]): string {
  if (imagePaths.length === 0) return task

  const imageRefs = imagePaths.map((p) => `- \`${p}\``).join("\n")
  return `${task}\n\n## Attached images\n\nThe user attached the following image(s). Read them with your file-reading tool to view their contents:\n${imageRefs}`
}
