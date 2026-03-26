import type { TopicMessage } from "./types.js"

const SUMMARY_MAX_CHARS = 500

export interface TruncationResult {
  conversation: TopicMessage[]
  truncated: boolean
  truncatedCount: number
}

export function truncateConversation(
  conversation: TopicMessage[],
  maxLength: number,
): TruncationResult {
  if (conversation.length <= maxLength) {
    return { conversation, truncated: false, truncatedCount: 0 }
  }

  if (maxLength < 2) {
    const kept = conversation.slice(0, 1)
    return { conversation: kept, truncated: true, truncatedCount: conversation.length - 1 }
  }

  const firstMessage = conversation[0]
  const keepCount = maxLength - 2
  const recentMessages = keepCount > 0 ? conversation.slice(-keepCount) : []
  const removedMessages = keepCount > 0 ? conversation.slice(1, -keepCount) : conversation.slice(1)

  const summaryText = buildSummary(removedMessages)
  const summaryMessage: TopicMessage = {
    role: "user",
    text: summaryText,
  }

  const result: TopicMessage[] = [firstMessage, summaryMessage, ...recentMessages]
  return { conversation: result, truncated: true, truncatedCount: removedMessages.length }
}

function buildSummary(messages: TopicMessage[]): string {
  if (messages.length === 0) {
    return "[Earlier conversation was truncated]"
  }

  const userCount = messages.filter((m) => m.role === "user").length
  const assistantCount = messages.filter((m) => m.role === "assistant").length

  const keyPoints = extractKeyPoints(messages, SUMMARY_MAX_CHARS - 100)

  let summary = `[Earlier conversation truncated — ${userCount} user and ${assistantCount} assistant messages omitted]`
  if (keyPoints) {
    summary += `\n\nKey points from truncated messages:\n${keyPoints}`
  }
  return summary
}

function extractKeyPoints(messages: TopicMessage[], maxChars: number): string | null {
  const userMessages = messages.filter((m) => m.role === "user" && m.text.trim())
  if (userMessages.length === 0) return null

  const points: string[] = []
  let budget = maxChars

  for (const msg of userMessages) {
    const text = msg.text.trim()
    const truncated = text.length > 150 ? text.slice(0, 147) + "..." : text
    const entry = `- ${truncated}\n`

    if (budget - entry.length < 0) break
    points.push(entry)
    budget -= entry.length
  }

  return points.length > 0 ? points.join("") : null
}
