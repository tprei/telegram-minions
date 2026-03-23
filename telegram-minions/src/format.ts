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
}

export function formatToolLine(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const MAX_SUMMARY = 60
  const icon = TOOL_ICONS[toolName] ?? "🔧"
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

export function formatAssistantText(slug: string, text: string, toolLines?: string[], toolCount?: number): string {
  const MAX_TEXT = 3800
  const toolPart = toolCount && toolCount > 0 ? `  ·  🔧 ${toolCount} tool${toolCount === 1 ? "" : "s"}` : ""
  const lines: string[] = [
    `🤖 <b>Reply</b>  ·  🏷 <code>${esc(slug)}</code>${toolPart}`,
  ]

  if (toolLines && toolLines.length > 0) {
    lines.push(``)
    lines.push(...toolLines)
  }

  lines.push(``)
  lines.push(`<blockquote>${esc(truncate(text, MAX_TEXT))}</blockquote>`)

  return lines.join("\n")
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
    const mode = meta.mode === "think" ? "🧠 think" : meta.mode === "plan" ? "📋 plan" : "⚡ task"
    lines.push(`${icon} <b>${esc(meta.topicName)}</b>  ·  📦 ${esc(meta.repo)}  ·  ${mode}  ·  ${state}  ·  ⏱ ${elapsed}`)
    lines.push(`   <blockquote>${esc(truncate(task, 120))}</blockquote>`)
    lines.push("")
  }

  const standbyTopics = topicSessions.filter((p) => !p.activeSessionId)
  for (const topic of standbyTopics) {
    const originalTask = topic.conversation[0]?.text ?? ""
    const topicMode = topic.mode === "think" ? "🧠 think" : "📋 plan"
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
    `<code>/task [repo] description</code> — start a one-shot coding task`,
    `<code>/plan [repo] description</code> — start a multi-turn planning session`,
    `<code>/think [repo] question</code> — start a deep research session`,
    `<code>/status</code> — show active sessions`,
    `<code>/stats</code> — show aggregate usage statistics`,
    `<code>/help</code> — show this message`,
    ``,
    `<b>Inside a thread</b>`,
    ``,
    `<code>/reply text</code> (or <code>/r text</code>) — give feedback to the agent`,
    `<code>/execute</code> — finalize plan and start implementation (plan/think mode)`,
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

function formatElapsed(ms: number): string {
  const secs = Math.round(ms / 1000)
  return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`
}
