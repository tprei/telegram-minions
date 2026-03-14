import type { EnvContext } from "./context.js"
import type { StopHookInput } from "./types.js"

const MAX_INSTRUCTION = 300
const MAX_RESPONSE = 800

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max).trimEnd() + "…" : s
}

export function formatNotification(
  input: StopHookInput,
  ctx: EnvContext,
  lastInstruction: string | null,
): string {
  const line2 = [
    `🌿 <code>${esc(ctx.branch)}</code>`,
    ...(ctx.tmuxWindow ? [`🪟 ${esc(ctx.tmuxWindow)}`] : []),
    `🖥 ${esc(ctx.hostname)}`,
  ].join("  ·  ")

  const parts = [
    `📦 <b>${esc(ctx.project)}</b>  ·  📂 <code>${esc(input.cwd)}</code>`,
    line2,
  ]

  if (lastInstruction) {
    parts.push("", `❓ <i>${esc(truncate(lastInstruction, MAX_INSTRUCTION))}</i>`)
  }

  parts.push("", `💬 ${esc(truncate(input.last_assistant_message, MAX_RESPONSE))}`)

  return parts.join("\n")
}
