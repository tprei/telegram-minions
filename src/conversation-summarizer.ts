import type { TopicMessage } from "./types.js"
import type { ProviderProfile } from "./config/config-types.js"
import { retryClaudeExtraction, buildConversationText } from "./claude-extract.js"
import { loggers } from "./logger.js"

const log = loggers.conversationSummarizer

export interface ConversationSummary {
  lines: string[]
}

const SUMMARIZATION_PROMPT = [
  "You are a conversation summarizer. Given a conversation between a User and an Agent, produce a concise summary as a series of single-line entries.",
  "",
  "Rules:",
  "- Each line should be a short sentence (under 120 chars) capturing one key point",
  "- Use the format: `Role - action or statement`",
  "- Roles are 'Agent' or 'User'",
  "- Focus on decisions, requests, disagreements, and outcomes — skip filler",
  "- Collapse multiple related messages into one line when possible",
  "- Preserve the chronological order",
  "- Maximum 15 lines total",
  "- Do NOT use markdown formatting, bullet points, or numbering",
  "",
  "Example output:",
  "User - asked to add retry logic to the webhook handler",
  "Agent - proposed exponential backoff with 3 retries",
  "User - requested jitter to avoid thundering herd",
  "Agent - implemented backoff with jitter and opened PR #42",
  "",
  "Output ONLY the summary lines, one per line. No preamble, no closing remarks.",
].join("\n")

const SUMMARIZATION_TIMEOUT_MS = 60_000

/**
 * Parse the raw summarizer output into a ConversationSummary.
 * Each non-empty line becomes an entry.
 */
export function parseSummaryOutput(output: string): ConversationSummary {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 15)

  if (lines.length === 0) {
    throw new Error("Empty summary output")
  }

  return { lines }
}

/**
 * Summarize a conversation into concise single-liners using Claude Haiku.
 * Returns a ConversationSummary on success, or null if summarization fails.
 */
export async function summarizeConversation(
  conversation: TopicMessage[],
  profile?: ProviderProfile,
): Promise<ConversationSummary | null> {
  if (conversation.length === 0) {
    return null
  }

  const task = buildConversationText(conversation)

  const result = await retryClaudeExtraction<ConversationSummary>(
    task,
    SUMMARIZATION_PROMPT,
    parseSummaryOutput,
    { timeoutMs: SUMMARIZATION_TIMEOUT_MS, profile, log },
  )

  if (result.error) {
    log.warn(
      { error: result.error, errorMessage: result.errorMessage },
      "conversation summarization failed, returning null",
    )
    return null
  }

  return result.data ?? null
}

/**
 * Format a ConversationSummary into a readable string for use in digests.
 */
export function formatSummary(summary: ConversationSummary): string {
  return summary.lines.join("\n")
}
