import type { TopicMessage } from "../types.js"
import type { ProviderProfile } from "../config/config-types.js"
import type { JudgeOption, JudgeExtractResult } from "./judge-types.js"
import { retryClaudeExtraction, buildConversationText } from "../claude-extract.js"
import { loggers } from "../logger.js"

const log = loggers.judgeExtract

const JUDGE_OPTION_EXTRACTION_PROMPT = [
  "You are a design-decision analyzer. Given a conversation where a coding agent is considering multiple implementation approaches,",
  "extract the distinct design options being discussed.",
  "",
  "For each option, capture:",
  "1. A short kebab-case ID (e.g., 'use-redis-cache', 'inline-validation')",
  "2. A concise title (under 60 chars)",
  "3. A detailed description explaining the approach, its pros/cons if mentioned, and relevant context",
  "",
  "Rules:",
  "- Extract 2-6 options. If fewer than 2 distinct approaches exist, output an empty array.",
  "- Options must be genuinely different approaches, not minor variations of the same idea.",
  "- Include enough context in each description for an advocate to argue for or against it.",
  "- If the user provided a directive, use it to scope which decisions to extract.",
  "",
  "Output ONLY a JSON array with no surrounding text or markdown fencing:",
  '[{ "id": "short-kebab-id", "title": "short label (under 60 chars)", "description": "detailed description of the approach" }]',
  "",
  "If you cannot identify at least 2 distinct design options, output an empty array: []",
].join("\n")

const EXTRACTION_TIMEOUT_MS = 120_000

/**
 * Extract design options from a planning conversation for the judge arena.
 */
export async function extractJudgeOptions(
  conversation: TopicMessage[],
  directive?: string,
  profile?: ProviderProfile,
): Promise<JudgeExtractResult> {
  const task = buildConversationText(conversation, directive)
  log.debug({ messageCount: conversation.length }, "analyzing conversation for judge options")

  const result = await retryClaudeExtraction(
    task,
    JUDGE_OPTION_EXTRACTION_PROMPT,
    (output) => parseJudgeOptions(output),
    { timeoutMs: EXTRACTION_TIMEOUT_MS, profile, log },
  )

  if (result.data) {
    log.debug({ optionCount: result.data.length }, "extracted judge options")
    return { options: result.data }
  }
  return { options: [], error: result.error, errorMessage: result.errorMessage }
}

/**
 * Parse judge options from raw Claude CLI output.
 * Handles JSON in markdown fences, surrounding text, or raw JSON.
 */
export function parseJudgeOptions(output: string): JudgeOption[] {
  let text = output.trim()

  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }

  const arrayMatch = text.match(/\[[\s\S]*\]/)
  if (!arrayMatch) {
    log.debug("no JSON array found in judge options output")
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(arrayMatch[0])
  } catch (e) {
    log.debug({ err: String(e) }, "JSON parse error in judge options output")
    return []
  }
  if (!Array.isArray(parsed)) {
    log.debug("parsed value is not an array")
    return []
  }

  const valid = parsed.filter((item: unknown): item is JudgeOption => {
    if (typeof item !== "object" || item === null) return false
    const obj = item as Record<string, unknown>
    if (typeof obj.id !== "string" || !obj.id.length) return false
    if (typeof obj.title !== "string" || !obj.title.length) return false
    if (typeof obj.description !== "string" || !obj.description.length) return false
    return true
  })

  return valid
}
