import type { TopicMessage } from "./types.js"
import type { ProviderProfile } from "./config/config-types.js"
import { summarizeConversation, formatSummary } from "./conversation-summarizer.js"

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

export interface ChildDigestOptions {
  childConversation: TopicMessage[]
  parentConversation?: TopicMessage[]
  profile?: ProviderProfile
}

/**
 * Build an enhanced digest for a child session (DAG/split child).
 * Uses the Haiku summarizer to create concise summaries of both
 * the parent planning loop and the child's execution.
 * Falls back to the basic buildConversationDigest on failure.
 */
export async function buildChildSessionDigest(
  options: ChildDigestOptions,
): Promise<string | null> {
  const { childConversation, parentConversation, profile } = options

  if (childConversation.length === 0) return null

  const childInstructions = extractChildInstructions(childConversation)

  const [parentSummary, childSummary] = await Promise.all([
    parentConversation && parentConversation.length > 0
      ? summarizeConversation(parentConversation, profile)
      : Promise.resolve(null),
    summarizeConversation(childConversation, profile),
  ])

  if (!parentSummary && !childSummary) {
    return buildConversationDigest(childConversation)
  }

  const lines: string[] = [
    "<details>",
    "<summary>Session conversation log</summary>",
    "",
  ]

  if (parentSummary) {
    lines.push("**Planning context:**")
    lines.push(formatSummary(parentSummary))
    lines.push("")
  }

  if (childInstructions) {
    lines.push(`**Child scope:** ${truncate(childInstructions, MAX_MSG_CHARS)}`)
    lines.push("")
  }

  if (childSummary) {
    lines.push("**Execution:**")
    lines.push(formatSummary(childSummary))
    lines.push("")
  }

  lines.push("</details>")
  return lines.join("\n")
}

/**
 * Extract the initial instructions/scope given to a child session.
 * This is typically the first user message in the child conversation.
 */
function extractChildInstructions(conversation: TopicMessage[]): string | null {
  const first = conversation[0]
  if (!first || first.role !== "user") return null
  return stripToolNoise(first.text) || null
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
