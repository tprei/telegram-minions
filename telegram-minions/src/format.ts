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
): string {
  const secs = Math.round(durationMs / 1000)
  const dur = secs >= 60
    ? `${Math.floor(secs / 60)}m ${secs % 60}s`
    : `${secs}s`

  const tokenPart = totalTokens != null ? `  ·  🪙 ${totalTokens.toLocaleString()} tokens` : ""
  return `✅ <b>Complete</b>  ·  🏷 <code>${esc(slug)}</code>  ·  ⏱ ${dur}${tokenPart}`
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

export function formatAssistantText(slug: string, text: string): string {
  const MAX_TEXT = 3800
  return [
    `🤖 <b>Reply</b>  ·  🏷 <code>${esc(slug)}</code>`,
    ``,
    `<blockquote>${esc(truncate(text, MAX_TEXT))}</blockquote>`,
  ].join("\n")
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
    `Reply in this thread to give feedback. Send <code>/execute</code> when the plan is ready.`,
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
  return `📋 <b>Plan complete</b>  ·  🏷 <code>${esc(slug)}</code>\n\nReply with feedback or send <code>/execute</code> to begin implementation.`
}
