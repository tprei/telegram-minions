export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max).trimEnd() + "…" : s
}

const TOOL_ICONS: Record<string, string> = {
  read_file: "📖", Read: "📖",
  write_file: "✏️", Write: "✏️",
  edit_file: "✏️", Edit: "✏️",
  shell: "💻", Bash: "💻",
  list_directory: "📂", Glob: "📂",
  search: "🔍", Grep: "🔍",
  WebSearch: "🌐", WebFetch: "🌐",
  browser_take_screenshot: "📸", mcp__playwright__browser_take_screenshot: "📸",
}

export function formatToolLine(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const MAX_SUMMARY = 60
  const icon = TOOL_ICONS[toolName]
    ?? Object.entries(TOOL_ICONS).find(([k]) => toolName.endsWith(k))?.[1]
    ?? "🔧"
  let summary = ""

  if (toolName === "write_file" || toolName === "edit_file" || toolName === "Edit" || toolName === "Write") {
    summary = typeof args["path"] === "string"
      ? args["path"]
      : typeof args["file_path"] === "string"
      ? args["file_path"]
      : ""
  } else if (toolName === "shell" || toolName === "Bash") {
    const cmd = args["command"] ?? args["cmd"] ?? args["script"]
    summary = typeof cmd === "string" ? truncate(cmd, MAX_SUMMARY) : ""
  } else if (toolName === "read_file" || toolName === "Read") {
    summary = typeof args["path"] === "string"
      ? args["path"]
      : typeof args["file_path"] === "string"
      ? args["file_path"]
      : ""
  } else if (toolName === "list_directory" || toolName === "Glob") {
    const path = args["path"] ?? args["pattern"]
    summary = typeof path === "string" ? truncate(path, MAX_SUMMARY) : ""
  } else if (toolName === "search" || toolName === "Grep") {
    const pattern = args["pattern"] ?? args["query"]
    summary = typeof pattern === "string" ? truncate(pattern, MAX_SUMMARY) : ""
  } else if (toolName === "WebSearch") {
    const query = args["query"] ?? args["search_query"]
    summary = typeof query === "string" ? truncate(query, MAX_SUMMARY) : ""
  } else if (toolName === "WebFetch") {
    const url = args["url"]
    summary = typeof url === "string" ? truncate(url, MAX_SUMMARY) : ""
  } else if (toolName.includes("browser_")) {
    const url = args["url"] ?? args["selector"] ?? args["text"] ?? args["ref"]
    summary = typeof url === "string" ? truncate(url, MAX_SUMMARY) : ""
  }

  return summary
    ? `${icon} <code>${esc(summary)}</code>`
    : `${icon} ${esc(toolName)}`
}

export function formatActivityLog(
  lines: string[],
  toolCount: number,
): string {
  const header = `🔧 <b>Activity</b> · ${toolCount} tool${toolCount === 1 ? "" : "s"}`
  return [header, "", ...lines].join("\n")
}

export function formatToolActivity(
  toolName: string,
  args: Record<string, unknown>,
  toolCount: number,
): string {
  const line = formatToolLine(toolName, args)
  const countPart = toolCount > 1 ? ` (${toolCount} tools)` : ""
  return `${line}${countPart}`
}

export function formatSessionStart(
  repo: string,
  slug: string,
  task: string,
): string {
  const MAX_TASK = 200
  return [
    `⚡ <b>Session started</b>  ·  📦 <b>${esc(repo)}</b>  ·  🏷 <code>${esc(slug)}</code>`,
    ``,
    `<blockquote>${esc(truncate(task, MAX_TASK))}</blockquote>`,
  ].join("\n")
}

export function formatSessionComplete(
  slug: string,
  durationMs: number,
  totalTokens: number | null | undefined,
  sessionToolCount?: number,
): string {
  const secs = Math.round(durationMs / 1000)
  const dur = secs >= 60
    ? `${Math.floor(secs / 60)}m ${secs % 60}s`
    : `${secs}s`

  const tokenPart = totalTokens != null ? `  ·  🪙 ${totalTokens.toLocaleString()} tokens` : ""
  const toolPart = sessionToolCount && sessionToolCount > 0 ? `  ·  🔧 ${sessionToolCount} tool${sessionToolCount === 1 ? "" : "s"}` : ""
  return `✅ <b>Complete</b>  ·  🏷 <code>${esc(slug)}</code>  ·  ⏱ ${dur}${tokenPart}${toolPart}`
}

export function formatSessionError(slug: string, error: string): string {
  return [
    `❌ <b>Error</b>  ·  🏷 <code>${esc(slug)}</code>`,
    ``,
    `<code>${esc(truncate(error, 300))}</code>`,
  ].join("\n")
}

export function formatSessionInterrupted(slug: string): string {
  return `⚠️ <b>Session interrupted</b>  ·  🏷 <code>${esc(slug)}</code>\nRestart not yet supported. Create a new task.`
}

const MAX_TEXT_PER_CHUNK = 3900

/**
 * Split text into chunks at paragraph boundaries, respecting max length.
 * Each chunk will be at most MAX_TEXT_PER_CHUNK characters.
 */
function splitTextIntoChunks(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }

    // Try to split at paragraph boundary first (double newline)
    let splitAt = remaining.lastIndexOf("\n\n", maxLen)
    if (splitAt < maxLen / 2) {
      // Fall back to single newline
      splitAt = remaining.lastIndexOf("\n", maxLen)
    }
    if (splitAt < maxLen / 2) {
      // Fall back to sentence boundary
      const sentenceEnd = remaining.lastIndexOf(". ", maxLen)
      const sentenceEnd2 = remaining.lastIndexOf("! ", maxLen)
      const sentenceEnd3 = remaining.lastIndexOf("? ", maxLen)
      splitAt = Math.max(sentenceEnd, sentenceEnd2, sentenceEnd3)
    }
    if (splitAt < maxLen / 2) {
      // Last resort: split at word boundary
      splitAt = remaining.lastIndexOf(" ", maxLen)
    }
    if (splitAt < 1) {
      // Absolute last resort: hard split
      splitAt = maxLen
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd())
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}

export function formatAssistantText(slug: string, text: string, toolLines?: string[], toolCount?: number): string {
  const toolPart = toolCount && toolCount > 0 ? `  ·  🔧 ${toolCount} tool${toolCount === 1 ? "" : "s"}` : ""
  const lines: string[] = [
    `🤖 <b>Reply</b>  ·  🏷 <code>${esc(slug)}</code>${toolPart}`,
  ]

  if (toolLines && toolLines.length > 0) {
    lines.push(``)
    lines.push(...toolLines)
  }

  lines.push(``)
  lines.push(`<blockquote>${esc(text)}</blockquote>`)

  return lines.join("\n")
}

/**
 * Format assistant text into multiple chunks with numbered headers.
 * Returns array of formatted HTML messages, each ≤4000 chars for Telegram.
 * Only first message includes tool activity.
 */
export function formatAssistantTextChunks(
  slug: string,
  text: string,
  toolLines?: string[],
  toolCount?: number,
): string[] {
  const toolPart = toolCount && toolCount > 0 ? `  ·  🔧 ${toolCount} tool${toolCount === 1 ? "" : "s"}` : ""

  // Build header template (first message gets tools)
  const headerWithTools = `🤖 <b>Reply</b>  ·  🏷 <code>${esc(slug)}</code>${toolPart}`
  const headerPlain = `🤖 <b>Reply</b>  ·  🏷 <code>${esc(slug)}</code>`

  // Build tool lines section (only for first message)
  const toolSection: string[] = []
  if (toolLines && toolLines.length > 0) {
    toolSection.push(``)
    toolSection.push(...toolLines)
  }
  const toolSectionStr = toolSection.join("\n")

  // Calculate available space for text in first chunk
  // Format: header + toolSection + "\n\n<blockquote>TEXT</blockquote>"
  const firstChunkOverhead = headerWithTools.length + toolSectionStr.length + 2 + 25 // 25 for blockquote tags + newline
  const firstChunkTextMax = MAX_TEXT_PER_CHUNK - firstChunkOverhead

  // Calculate overhead for subsequent chunks
  // Format: header + " (N/M)" + "\n\n<blockquote>TEXT</blockquote>"
  const chunkOverhead = headerPlain.length + 7 + 25 // 7 for " (N/M)", 25 for blockquote tags
  const chunkTextMax = MAX_TEXT_PER_CHUNK - chunkOverhead

  // Split text into chunks
  const textChunks = splitTextIntoChunks(text, Math.max(firstChunkTextMax, chunkTextMax))

  // If single chunk, use simple format
  if (textChunks.length === 1) {
    return [formatAssistantText(slug, text, toolLines, toolCount)]
  }

  // Build multiple formatted chunks
  const formattedChunks: string[] = []
  const total = textChunks.length

  for (let i = 0; i < total; i++) {
    const isFirst = i === 0
    const header = isFirst ? headerWithTools : headerPlain
    const chunkHeader = `${header} (${i + 1}/${total})`
    const tools = isFirst ? toolSectionStr : ""
    const chunkText = textChunks[i]

    formattedChunks.push(
      `${chunkHeader}${tools}\n\n<blockquote>${esc(chunkText)}</blockquote>`,
    )
  }

  return formattedChunks
}

export function formatThinkStart(
  repo: string,
  slug: string,
  task: string,
): string {
  const MAX_TASK = 200
  return [
    `🧠 <b>Deep research started</b>  ·  📦 <b>${esc(repo)}</b>  ·  🏷 <code>${esc(slug)}</code>`,
    ``,
    `<blockquote>${esc(truncate(task, MAX_TASK))}</blockquote>`,
    ``,
    `Use <code>/reply</code> (or <code>/r</code>) to ask follow-up questions.`,
  ].join("\n")
}

export function formatThinkIteration(slug: string, iteration: number): string {
  return `🧠 <b>Thinking deeper</b>  ·  🏷 <code>${esc(slug)}</code>  ·  iteration ${iteration}`
}

export function formatThinkComplete(slug: string): string {
  return `🧠 <b>Research complete</b>  ·  🏷 <code>${esc(slug)}</code>\n\nUse <code>/reply</code> (or <code>/r</code>) to ask follow-up questions, or send <code>/execute</code> to act on the findings.`
}

export function formatPlanStart(
  repo: string,
  slug: string,
  task: string,
): string {
  const MAX_TASK = 200
  return [
    `📋 <b>Planning started</b>  ·  📦 <b>${esc(repo)}</b>  ·  🏷 <code>${esc(slug)}</code>`,
    ``,
    `<blockquote>${esc(truncate(task, MAX_TASK))}</blockquote>`,
    ``,
    `Use <code>/reply</code> (or <code>/r</code>) to give feedback. Send <code>/execute</code> when the plan is ready.`,
  ].join("\n")
}

export function formatPlanIteration(slug: string, iteration: number): string {
  return `📋 <b>Refining plan</b>  ·  🏷 <code>${esc(slug)}</code>  ·  iteration ${iteration}`
}

export function formatPlanExecuting(slug: string, execSlug: string): string {
  return [
    `🚀 <b>Executing plan</b>  ·  🏷 <code>${esc(slug)}</code>`,
    ``,
    `Implementation started in thread <code>${esc(execSlug)}</code>`,
  ].join("\n")
}

export function formatPlanComplete(slug: string): string {
  return `📋 <b>Plan complete</b>  ·  🏷 <code>${esc(slug)}</code>\n\nUse <code>/reply</code> (or <code>/r</code>) for feedback, or send <code>/execute</code> to begin implementation.`
}

export function formatTaskComplete(
  slug: string,
  durationMs: number,
  totalTokens: number | null | undefined,
): string {
  const secs = Math.round(durationMs / 1000)
  const dur = secs >= 60
    ? `${Math.floor(secs / 60)}m ${secs % 60}s`
    : `${secs}s`
  const tokenPart = totalTokens != null ? `  ·  🪙 ${totalTokens.toLocaleString()} tokens` : ""
  return [
    `✅ <b>Complete</b>  ·  🏷 <code>${esc(slug)}</code>  ·  ⏱ ${dur}${tokenPart}`,
    ``,
    `Use <code>/reply</code> (or <code>/r</code>) to give feedback.`,
  ].join("\n")
}

export function formatReviewStart(
  repo: string,
  slug: string,
  task: string,
): string {
  const MAX_TASK = 200
  return [
    `👀 <b>Review started</b>  ·  📦 <b>${esc(repo)}</b>  ·  🏷 <code>${esc(slug)}</code>`,
    ``,
    `<blockquote>${esc(truncate(task, MAX_TASK))}</blockquote>`,
    ``,
    `Use <code>/reply</code> (or <code>/r</code>) to ask the reviewer to look deeper.`,
  ].join("\n")
}

export function formatReviewIteration(slug: string, iteration: number): string {
  return `👀 <b>Re-reviewing</b>  ·  🏷 <code>${esc(slug)}</code>  ·  iteration ${iteration}`
}

export function formatReviewComplete(slug: string): string {
  return `👀 <b>Review complete</b>  ·  🏷 <code>${esc(slug)}</code>\n\nUse <code>/reply</code> (or <code>/r</code>) to ask follow-up questions.`
}

export function formatFollowUpIteration(slug: string, iteration: number): string {
  return `🔄 <b>Follow-up</b>  ·  🏷 <code>${esc(slug)}</code>  ·  iteration ${iteration}`
}

export function formatStatus(
  taskSessions: { meta: { topicName: string; repo: string; startedAt: number; mode: string }; task: string; handle: { isActive(): boolean; getState(): string } }[],
  topicSessions: { slug: string; repo: string; mode?: string; conversation: { role: string; text: string }[]; activeSessionId?: string }[],
  maxConcurrent: number,
): string {
  const lines: string[] = [`📊 <b>Status</b>  ·  ${taskSessions.length}/${maxConcurrent} slots in use`, ""]

  if (taskSessions.length === 0 && topicSessions.length === 0) {
    lines.push("No active sessions.")
    return lines.join("\n")
  }

  for (const { meta, task, handle } of taskSessions) {
    const state = handle.getState()
    const icon = handle.isActive() ? "🟢" : "🔴"
    const elapsed = formatElapsed(Date.now() - meta.startedAt)
    const mode = meta.mode === "think" ? "🧠 think" : meta.mode === "plan" ? "📋 plan" : meta.mode === "review" ? "👀 review" : meta.mode === "ci-fix" ? "🔧 ci-fix" : "⚡ task"
    lines.push(`${icon} <b>${esc(meta.topicName)}</b>  ·  📦 ${esc(meta.repo)}  ·  ${mode}  ·  ${state}  ·  ⏱ ${elapsed}`)
    lines.push(`   <blockquote>${esc(truncate(task, 120))}</blockquote>`)
    lines.push("")
  }

  const standbyTopics = topicSessions.filter((p) => !p.activeSessionId)
  for (const topic of standbyTopics) {
    const originalTask = topic.conversation[0]?.text ?? ""
    const topicMode = topic.mode === "think" ? "🧠 think" : topic.mode === "review" ? "👀 review" : "📋 plan"
    lines.push(`🟡 <b>${esc(topic.slug)}</b>  ·  📦 ${esc(topic.repo)}  ·  ${topicMode}  ·  awaiting feedback`)
    lines.push(`   <blockquote>${esc(truncate(originalTask, 120))}</blockquote>`)
    lines.push("")
  }

  return lines.join("\n")
}

export function formatHelp(): string {
  return [
    `<b>Available commands</b>`,
    ``,
    `<code>/task [repo] description</code> (or <code>/w</code>) — start a one-shot coding task`,
    `<code>/plan [repo] description</code> — start a multi-turn planning session`,
    `<code>/think [repo] question</code> — start a deep research session`,
    `<code>/review [repo] PR#</code> — review a pull request (or all unreviewed PRs)`,
    `<code>/status</code> — show active sessions`,
    `<code>/stats</code> — show aggregate usage statistics`,
    `<code>/usage</code> — show Claude ACP quota and recent activity`,
    `<code>/config</code> — manage provider profiles`,
    `<code>/clean</code> — remove idle sessions, orphaned workspaces, and cached repos`,
    `<code>/help</code> — show this message`,
    ``,
    `<b>Inside a thread</b>`,
    ``,
    `<code>/reply text</code> (or <code>/r text</code>) — give feedback to the agent`,
    `<code>/execute [directive]</code> — finalize plan and start implementation (plan/think mode)`,
    `<code>/split [directive]</code> — split plan into parallel sub-tasks (plan/think mode)`,
    `<code>/stack [directive]</code> — create stacked PRs (sequential chain, plan/think mode)`,
    `<code>/dag [directive]</code> — create a dependency DAG of tasks (plan/think mode)`,
    `<code>/land</code> — merge completed stack/DAG PRs to main in order`,
    `<code>/retry [node-id]</code> — retry failed DAG nodes`,
    `<code>/stop</code> — stop the running agent but keep the thread and data`,
    `<code>/close</code> — stop the session, wipe data, and delete the topic`,
  ].join("\n")
}

export function formatQualityReport(
  results: { gate: string; passed: boolean; output: string }[],
): string {
  if (results.length === 0) return ""

  const allPassed = results.every((r) => r.passed)
  const icon = allPassed ? "✅" : "⚠️"
  const lines: string[] = [`${icon} <b>Quality gates</b>`]

  for (const r of results) {
    const status = r.passed ? "✅" : "❌"
    lines.push(`${status} ${esc(r.gate)}`)
    if (!r.passed) {
      const trimmed = r.output.slice(-500).trim()
      if (trimmed) {
        lines.push(`<pre>${esc(trimmed)}</pre>`)
      }
    }
  }

  return lines.join("\n")
}

export function formatQualityReportForContext(
  results: { gate: string; passed: boolean; output: string }[],
): string {
  const lines: string[] = ["## Quality gate results\n"]
  for (const r of results) {
    const status = r.passed ? "PASSED" : "FAILED"
    lines.push(`### ${r.gate}: ${status}`)
    if (!r.passed && r.output) {
      const trimmed = r.output.slice(-1500).trim()
      lines.push("```")
      lines.push(trimmed)
      lines.push("```")
    }
    lines.push("")
  }
  lines.push("Fix the failing quality gates before proceeding.")
  return lines.join("\n")
}

export function formatBudgetWarning(slug: string, tokens: number, budget: number): string {
  return `💰 <b>Token budget exceeded</b>  ·  🏷 <code>${esc(slug)}</code>  ·  ${tokens.toLocaleString()} / ${budget.toLocaleString()} tokens\nSession terminated to limit context usage.`
}

export function formatStats(
  stats: {
    totalSessions: number
    completedSessions: number
    erroredSessions: number
    totalTokens: number
    totalDurationMs: number
    avgDurationMs: number
  },
): string {
  const dur = formatElapsed(stats.totalDurationMs)
  const avgDur = stats.completedSessions > 0 ? formatElapsed(stats.avgDurationMs) : "n/a"
  return [
    `📊 <b>Aggregate stats</b>`,
    ``,
    `Sessions: ${stats.totalSessions} total · ${stats.completedSessions} completed · ${stats.erroredSessions} errored`,
    `Tokens: ${stats.totalTokens.toLocaleString()}`,
    `Time: ${dur} total · ${avgDur} avg`,
  ].join("\n")
}

export function formatCIWatching(slug: string, prUrl: string): string {
  const prNum = prUrl.match(/\/pull\/(\d+)/)?.[1] ?? prUrl
  return `👀 <b>Watching CI</b>  ·  🏷 <code>${esc(slug)}</code>  ·  PR #${esc(prNum)}`
}

export function formatCIFailed(slug: string, failedChecks: string[], attempt: number, maxAttempts: number): string {
  const checkList = failedChecks.map((c) => `  ❌ ${esc(c)}`).join("\n")
  return [
    `❌ <b>CI failed</b>  ·  🏷 <code>${esc(slug)}</code>  ·  attempt ${attempt}/${maxAttempts}`,
    ``,
    checkList,
  ].join("\n")
}

export function formatCIFixing(slug: string, attempt: number, maxAttempts: number): string {
  return `🔧 <b>Fixing CI</b>  ·  🏷 <code>${esc(slug)}</code>  ·  attempt ${attempt}/${maxAttempts}`
}

export function formatCIPassed(slug: string, prUrl: string): string {
  const prNum = prUrl.match(/\/pull\/(\d+)/)?.[1] ?? prUrl
  return `✅ <b>CI passed</b>  ·  🏷 <code>${esc(slug)}</code>  ·  PR #${esc(prNum)}`
}

export function formatCIGaveUp(slug: string, maxAttempts: number): string {
  return `🛑 <b>CI still failing</b>  ·  🏷 <code>${esc(slug)}</code>  ·  gave up after ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}`
}

export function formatCIConflicts(slug: string, prUrl: string): string {
  const prNum = prUrl.match(/\/pull\/(\d+)/)?.[1] ?? prUrl
  return `⚠️ <b>Merge conflicts</b>  ·  🏷 <code>${esc(slug)}</code>  ·  PR #${esc(prNum)}\n\nCI cannot run until conflicts are resolved.`
}

export function formatCIResolvingConflicts(slug: string, prUrl: string, attempt: number, maxAttempts: number): string {
  const prNum = prUrl.match(/\/pull\/(\d+)/)?.[1] ?? prUrl
  return `🔧 <b>Resolving conflicts</b>  ·  🏷 <code>${esc(slug)}</code>  ·  PR #${esc(prNum)}  ·  attempt ${attempt}/${maxAttempts}`
}

export function formatCINoChecks(slug: string, prUrl: string): string {
  const prNum = prUrl.match(/\/pull\/(\d+)/)?.[1] ?? prUrl
  return `⏳ <b>No CI checks found</b>  ·  🏷 <code>${esc(slug)}</code>  ·  PR #${esc(prNum)}\n\nTimed out waiting for checks to appear.`
}

import type { ClaudeUsageResponse, UsageTier } from "./claude-usage.js"
import type { AggregateStats, SessionRecord, ModeBreakdown } from "./stats.js"

function formatElapsed(ms: number): string {
  const secs = Math.round(ms / 1000)
  return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`
}

const MODE_ICONS: Record<string, string> = {
  task: "⚡",
  plan: "📋",
  think: "🧠",
  "ci-fix": "🔧",
}

function progressBar(pct: number): string {
  const filled = Math.round(pct / 10)
  return "█".repeat(filled) + "░".repeat(10 - filled)
}

function formatResetIn(resetsAt: string | null): string {
  if (!resetsAt) return ""
  const ms = new Date(resetsAt).getTime() - Date.now()
  if (ms <= 0) return "now"
  const hours = Math.floor(ms / 3600000)
  const mins = Math.floor((ms % 3600000) / 60000)
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const rem = hours % 24
    return `${days}d ${rem}h`
  }
  return `${hours}h ${mins}m`
}

function formatTierLine(label: string, tier: UsageTier): string {
  const pct = Math.round(tier.utilization)
  const bar = progressBar(pct)
  const reset = tier.resets_at ? ` · resets in ${formatResetIn(tier.resets_at)}` : ""
  return `  ${label}: ${bar} ${pct}%${reset}`
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

export function formatUsage(
  acpUsage: ClaudeUsageResponse | null,
  agg: AggregateStats,
  breakdown: Record<string, ModeBreakdown>,
  recent: SessionRecord[],
): string {
  const lines: string[] = [`📊 <b>Usage</b>`]

  if (acpUsage) {
    lines.push("")
    lines.push(`<b>🔑 Claude ACP</b>`)
    lines.push(formatTierLine("5h", acpUsage.five_hour))
    lines.push(formatTierLine("7d", acpUsage.seven_day))
    lines.push(formatTierLine("7d opus", acpUsage.seven_day_opus))
    lines.push(formatTierLine("7d sonnet", acpUsage.seven_day_sonnet))
    if (acpUsage.extra_usage?.is_enabled) {
      const used = acpUsage.extra_usage.used_credits ?? 0
      const limit = acpUsage.extra_usage.monthly_limit
      const limitStr = limit != null ? ` / $${limit}` : ""
      lines.push(`  extra: $${used.toFixed(2)}${limitStr}`)
    }
  }

  lines.push("")
  lines.push(`<b>📈 Last 7 days</b> · ${agg.totalSessions} sessions · ${formatTokenCount(agg.totalTokens)} tokens`)
  const modes = Object.entries(breakdown).sort((a, b) => b[1].tokens - a[1].tokens)
  for (const [mode, data] of modes) {
    const icon = MODE_ICONS[mode] ?? "•"
    lines.push(`  ${icon} ${mode}: ${data.count} session${data.count === 1 ? "" : "s"} · ${formatTokenCount(data.tokens)} tokens`)
  }

  if (recent.length > 0) {
    lines.push("")
    lines.push(`<b>📋 Recent sessions</b>`)
    for (const r of recent) {
      const icon = MODE_ICONS[r.mode] ?? "•"
      const dur = formatElapsed(r.durationMs)
      lines.push(`  <code>${esc(r.slug)}</code> · ${esc(r.repo)} · ${icon} ${r.mode} · ${formatTokenCount(r.totalTokens)} tokens · ${dur}`)
    }
  }

  return lines.join("\n")
}

export function formatProfileList(profiles: { id: string; name: string; baseUrl?: string }[], defaultId?: string): string {
  const lines: string[] = [`⚙️ <b>Provider profiles</b>`, ""]
  for (const p of profiles) {
    const url = p.baseUrl ? ` · ${esc(p.baseUrl)}` : ""
    const marker = p.id === defaultId ? " ⭐" : ""
    lines.push(`• <code>${esc(p.id)}</code> — ${esc(p.name)}${url}${marker}`)
  }
  lines.push("")
  lines.push(`<code>/config default &lt;id&gt;</code> — set default profile`)
  lines.push(`<code>/config default clear</code> — clear default`)
  lines.push(`<code>/config add &lt;id&gt; &lt;name&gt;</code> — add new profile`)
  lines.push(`<code>/config set &lt;id&gt; &lt;field&gt; &lt;value&gt;</code> — update field`)
  lines.push(`<code>/config remove &lt;id&gt;</code> — remove profile`)
  return lines.join("\n")
}

export function formatSplitAnalyzing(slug: string): string {
  return `🔀 <b>Analyzing conversation</b>  ·  🏷 <code>${esc(slug)}</code>\nExtracting parallelizable work items…`
}

export function formatSplitStart(
  slug: string,
  children: { repo: string; slug: string; title: string }[],
): string {
  const lines: string[] = [
    `🔀 <b>Split into ${children.length} sub-tasks</b>  ·  🏷 <code>${esc(slug)}</code>`,
    "",
  ]
  for (let i = 0; i < children.length; i++) {
    lines.push(`${i + 1}. ⚡ <b>${esc(children[i].repo)} · ${esc(children[i].slug)}</b> — ${esc(children[i].title)}`)
  }
  lines.push("")
  lines.push("Each sub-minion has its own worktree and branch. Progress updates will appear here.")
  return lines.join("\n")
}

export function formatSplitChildComplete(slug: string, state: string, label: string, prUrl?: string): string {
  const emoji = state === "errored" ? "❌" : "✅"
  const prSuffix = prUrl ? ` — <a href="${esc(prUrl)}">PR</a>` : ""
  return `${emoji} <b>${esc(slug)}</b> ${esc(state)}: ${esc(label)}${prSuffix}`
}

export function formatSplitAllDone(succeeded: number, total: number): string {
  return `📊 <b>Split complete</b>: ${succeeded}/${total} succeeded`
}

export function formatStackAnalyzing(slug: string): string {
  return `📚 <b>Analyzing conversation</b>  ·  🏷 <code>${esc(slug)}</code>\nExtracting sequential work items for stacked PRs…`
}

export function formatDagAnalyzing(slug: string): string {
  return `🔗 <b>Analyzing conversation</b>  ·  🏷 <code>${esc(slug)}</code>\nExtracting work items with dependencies…`
}

export function formatDagStart(
  slug: string,
  children: { slug: string; title: string; dependsOn: string[] }[],
  isStack: boolean,
): string {
  const mode = isStack ? "Stack" : "DAG"
  const icon = isStack ? "📚" : "🔗"
  const lines: string[] = [
    `${icon} <b>${mode}: ${children.length} tasks</b>  ·  🏷 <code>${esc(slug)}</code>`,
    "",
  ]
  for (let i = 0; i < children.length; i++) {
    const deps = children[i].dependsOn.length > 0
      ? ` ← ${children[i].dependsOn.join(", ")}`
      : ""
    const status = children[i].dependsOn.length === 0 ? "⚡" : "⏳"
    lines.push(`${i + 1}. ${status} <b>${esc(children[i].slug)}</b> — ${esc(children[i].title)}${deps}`)
  }
  lines.push("")
  if (isStack) {
    lines.push("Tasks run sequentially. Each task branches from the previous one's PR branch.")
  } else {
    lines.push("Tasks run in dependency order. Independent tasks run in parallel.")
  }
  return lines.join("\n")
}

export function formatDagNodeStarting(nodeTitle: string, nodeId: string, slug: string): string {
  return `⚡ <b>Starting</b>: ${esc(nodeTitle)} (<code>${esc(nodeId)}</code>)  ·  🏷 <code>${esc(slug)}</code>`
}

export function formatDagNodeComplete(
  slug: string,
  state: string,
  nodeTitle: string,
  prUrl?: string,
  progress?: { done: number; total: number; running: number },
): string {
  const emoji = (state === "errored" || state === "failed") ? "❌" : "✅"
  const prSuffix = prUrl ? ` — <a href="${esc(prUrl)}">PR</a>` : ""
  const progressSuffix = progress
    ? `\n📊 ${progress.done}/${progress.total} complete` +
      (progress.running > 0 ? `, ${progress.running} running` : "")
    : ""
  return `${emoji} <b>${esc(slug)}</b> ${esc(state)}: ${esc(nodeTitle)}${prSuffix}${progressSuffix}`
}

export function formatDagNodeSkipped(nodeTitle: string, reason: string): string {
  return `⏭️ <b>Skipped</b>: ${esc(nodeTitle)} — ${esc(reason)}`
}

export function formatDagAllDone(succeeded: number, total: number, failed: number): string {
  const failedSuffix = failed > 0 ? `, ${failed} failed` : ""
  return `📊 <b>DAG complete</b>: ${succeeded}/${total} succeeded${failedSuffix}`
}

export function formatLandStart(slug: string, count: number): string {
  return `🛬 <b>Landing stack</b>  ·  🏷 <code>${esc(slug)}</code>\nMerging ${count} PRs bottom-up…`
}

export function formatLandProgress(title: string, prUrl: string, index: number, total: number): string {
  return `🛬 <b>${index + 1}/${total}</b> Merged: ${esc(title)} — <a href="${esc(prUrl)}">PR</a>`
}

export function formatLandComplete(succeeded: number, total: number): string {
  return `🛬 <b>Landing complete</b>: ${succeeded}/${total} PRs merged to main`
}

export function formatLandError(title: string, error: string): string {
  return `❌ <b>Landing failed</b> at: ${esc(title)}\n<code>${esc(error)}</code>`
}

export function formatLandRestacking(title: string, branch: string): string {
  return `🔄 Restacking <b>${esc(title)}</b> (<code>${esc(branch)}</code>)…`
}

export function formatDagCIWaiting(slug: string, nodeTitle: string, prUrl: string): string {
  return `🔄 <b>${esc(slug)}</b> waiting for CI: ${esc(nodeTitle)} — <a href="${esc(prUrl)}">PR</a>`
}

export function formatDagCIFailed(slug: string, nodeTitle: string, prUrl: string, policy: string): string {
  const action = policy === "block"
    ? `\nDependents blocked. Send <code>/force ${esc(slug)}</code> to advance anyway, or <code>/retry</code> after fixing.`
    : `\nProceeding with dependents (policy: ${esc(policy)}).`
  return `⚠️ <b>${esc(slug)}</b> CI failed: ${esc(nodeTitle)} — <a href="${esc(prUrl)}">PR</a>${action}`
}

export function formatDagForceAdvance(nodeTitle: string, nodeId: string): string {
  return `⚡ Force-advancing <b>${esc(nodeTitle)}</b> (<code>${esc(nodeId)}</code>) past CI failure`
}

export function formatConfigHelp(): string {
  return [
    `⚙️ <b>Config commands</b>`,
    ``,
    `<code>/config</code> — list profiles`,
    `<code>/config default &lt;id&gt;</code> — set default profile`,
    `<code>/config default clear</code> — clear default`,
    `<code>/config add &lt;id&gt; &lt;name&gt;</code> — add new profile`,
    `<code>/config set &lt;id&gt; &lt;field&gt; &lt;value&gt;</code> — update field`,
    `<code>/config remove &lt;id&gt;</code> — remove profile`,
    ``,
    `<b>Fields</b>: name, baseUrl, authToken, opusModel, sonnetModel, haikuModel`,
  ].join("\n")
}

export function formatPinnedStatus(
  slug: string,
  repo: string,
  status: "working" | "completed" | "errored",
  prUrl?: string,
  extra?: { label?: string; state?: string },
): string {
  const statusIcon = status === "completed" ? "✅" : status === "errored" ? "❌" : "⚡"
  const statusText = status === "completed" ? "Complete" : status === "errored" ? "Error" : "Working"

  const lines: string[] = [
    `${statusIcon} <b>${esc(statusText)}</b>  ·  🏷 <code>${esc(slug)}</code>  ·  📦 ${esc(repo)}`,
  ]

  if (prUrl) {
    const prNum = prUrl.match(/\/pull\/(\d+)/)?.[1] ?? prUrl
    lines.push(``)
    lines.push(`<b>PR:</b> <a href="${esc(prUrl)}">#${esc(prNum)}</a>`)
  } else if (extra?.label && extra?.state) {
    lines.push(``)
    lines.push(`${esc(extra.state)}: ${esc(extra.label)}`)
  }

  return lines.join("\n")
}

export function formatPinnedSplitStatus(
  parentSlug: string,
  repo: string,
  children: { slug: string; label: string; prUrl?: string; status: "running" | "done" | "failed" }[],
): string {
  const lines: string[] = [
    `🔀 <b>Split</b>  ·  🏷 <code>${esc(parentSlug)}</code>  ·  📦 ${esc(repo)}`,
    ``,
  ]

  const done = children.filter((c) => c.status === "done").length
  const failed = children.filter((c) => c.status === "failed").length
  const running = children.filter((c) => c.status === "running").length

  lines.push(`<b>Progress:</b> ${done}/${children.length} done${failed > 0 ? ` · ${failed} failed` : ""}${running > 0 ? ` · ${running} running` : ""}`)
  lines.push(``)

  for (const child of children) {
    const icon = child.status === "done" ? "✅" : child.status === "failed" ? "❌" : "⚡"
    const prPart = child.prUrl ? ` — <a href="${esc(child.prUrl)}">PR</a>` : ""
    lines.push(`${icon} <code>${esc(child.slug)}</code>${prPart}`)
  }

  return lines.join("\n")
}

export function formatPinnedDagStatus(
  parentSlug: string,
  repo: string,
  nodes: { id: string; title: string; prUrl?: string; status: "pending" | "ready" | "running" | "done" | "failed" | "skipped" }[],
  isStack: boolean,
): string {
  const icon = isStack ? "📚" : "🔗"
  const label = isStack ? "Stack" : "DAG"

  const lines: string[] = [
    `${icon} <b>${label}</b>  ·  🏷 <code>${esc(parentSlug)}</code>  ·  📦 ${esc(repo)}`,
    ``,
  ]

  const done = nodes.filter((n) => n.status === "done").length
  const failed = nodes.filter((n) => n.status === "failed").length
  const running = nodes.filter((n) => n.status === "running").length
  const pending = nodes.filter((n) => n.status === "pending" || n.status === "ready").length

  lines.push(`<b>Progress:</b> ${done}/${nodes.length} done${failed > 0 ? ` · ${failed} failed` : ""}${running > 0 ? ` · ${running} running` : ""}${pending > 0 ? ` · ${pending} pending` : ""}`)
  lines.push(``)

  for (const node of nodes) {
    const nodeIcon = node.status === "done" ? "✅" : node.status === "failed" ? "❌" : node.status === "running" ? "⚡" : node.status === "skipped" ? "⏭️" : "⏳"
    const prPart = node.prUrl ? ` — <a href="${esc(node.prUrl)}">PR</a>` : ""
    const title = esc(node.title)
    const styledTitle = node.status === "done" || node.status === "skipped"
      ? `<s>${title}</s>`
      : node.status === "running" || node.status === "failed"
        ? `<b>${title}</b>`
        : title
    lines.push(`${nodeIcon} <code>${esc(node.id)}</code>: ${styledTitle}${prPart}`)
  }

  return lines.join("\n")
}
