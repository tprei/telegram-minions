import type { TopicMessage } from "./types.js"

const MAX_DIGEST_CHARS = 3000
const MAX_MSG_CHARS = 500

export function buildConversationDigest(conversation: TopicMessage[]): string | null {
  if (conversation.length === 0) return null

  const task = conversation[0]?.text ?? ""
  const assistantMessages = conversation.filter((m) => m.role === "assistant")
  if (assistantMessages.length === 0) return null

  const lines: string[] = [
    "<details>",
    "<summary>Session conversation log</summary>",
    "",
    `**Task:** ${truncate(task, MAX_MSG_CHARS)}`,
    "",
  ]

  let budget = MAX_DIGEST_CHARS - lines.join("\n").length - 20

  for (const msg of conversation.slice(1)) {
    if (budget <= 0) break
    const label = msg.role === "user" ? "**User**" : "**Agent**"
    const text = stripToolNoise(msg.text)
    if (!text) continue
    const entry = `${label}: ${truncate(text, MAX_MSG_CHARS)}\n`
    budget -= entry.length
    lines.push(entry)
  }

  lines.push("</details>")
  return lines.join("\n")
}

function stripToolNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "[code block]")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 3) + "..."
}
