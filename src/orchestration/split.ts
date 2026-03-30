import fs from "node:fs"
import path from "node:path"
import type { TopicMessage } from "../types.js"
import { retryClaudeExtraction, buildConversationText } from "../claude-extract.js"
import { loggers } from "../logger.js"

const log = loggers.split

export interface SplitItem {
  title: string
  description: string
}

export interface ExtractResult {
  items: SplitItem[]
  error?: "system" | "parse"
  errorMessage?: string
}

const SPLIT_EXTRACTION_PROMPT = [
  "You are a task splitter. Given a planning/research conversation, extract discrete, independently implementable work items.",
  "",
  "Items are parallelizable if they:",
  "1. Address different logical concerns (e.g., UI vs backend vs tests vs docs vs config)",
  "2. Have clear scope boundaries even if some files overlap",
  "3. Can produce independent PRs that merge without constant conflicts",
  "",
  "Prefer splitting by **role/responsibility** rather than strict file isolation. Minor file overlap is acceptable if each agent owns a distinct aspect.",
  "",
  "AVOID splitting if items are tightly coupled or require extensive back-and-forth coordination.",
  "",
  "If the user provided a directive, use it to filter or refine the items.",
  "",
  "Output ONLY a JSON array with no surrounding text or markdown fencing:",
  '[{ "title": "short label (under 60 chars)", "description": "full task description with scope constraints and owned files/modules" }]',
  "",
  "If you cannot identify discrete parallelizable items, output an empty array: []",
].join("\n")

const EXTRACTION_TIMEOUT_MS = 60_000

/**
 * Resolve the Claude config directory for CLI authentication.
 * Priority:
 * 1. CLAUDE_CONFIG_DIR env var if already set
 * 2. /workspace/home/.claude if it exists (Fly.io deployment)
 * 3. $HOME/.claude as fallback
 */
export function getClaudeConfigDir(
  env: Record<string, string | undefined> = process.env,
  fsExists: (path: string) => boolean = (p) => fs.existsSync(p),
): string {
  if (env["CLAUDE_CONFIG_DIR"]) {
    return env["CLAUDE_CONFIG_DIR"]
  }
  if (fsExists("/workspace/home/.claude")) {
    return "/workspace/home/.claude"
  }
  const home = env["HOME"] ?? "/root"
  return path.join(home, ".claude")
}

/**
 * Extract parallelizable work items from a planning conversation.
 * Uses the shared retry helper from claude-extract.
 */
export async function extractSplitItems(
  conversation: TopicMessage[],
  directive?: string,
): Promise<ExtractResult> {
  const task = buildConversationText(conversation, directive)
  log.debug({ messageCount: conversation.length, directive: directive?.slice(0, 100) }, "analyzing conversation")

  const claudeConfigDir = getClaudeConfigDir()
  log.debug({ claudeConfigDir }, "using CLAUDE_CONFIG_DIR")

  const result = await retryClaudeExtraction(
    task,
    SPLIT_EXTRACTION_PROMPT,
    (output) => parseSplitItems(output),
    {
      timeoutMs: EXTRACTION_TIMEOUT_MS,
      envOverrides: { CLAUDE_CONFIG_DIR: claudeConfigDir },
      log,
    },
  )

  if (result.data) {
    log.debug({ itemCount: result.data.length }, "extracted valid items")
    return { items: result.data }
  }
  return { items: [], error: result.error, errorMessage: result.errorMessage }
}

export function parseSplitItems(output: string): SplitItem[] {
  let text = output.trim()

  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }

  const arrayMatch = text.match(/\[[\s\S]*\]/)
  if (!arrayMatch) {
    log.debug("no JSON array found in output")
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(arrayMatch[0])
  } catch (e) {
    log.debug({ err: String(e) }, "JSON parse error")
    return []
  }
  if (!Array.isArray(parsed)) {
    log.debug({ type: typeof parsed }, "parsed value is not an array")
    return []
  }

  let filtered = 0
  const valid = parsed.filter((item: unknown): item is SplitItem => {
    if (typeof item !== "object" || item === null) {
      log.debug("filtered non-object item")
      filtered++
      return false
    }
    const obj = item as Record<string, unknown>
    if (typeof obj.title !== "string" || !obj.title.length) {
      log.debug("filtered item with missing/empty title")
      filtered++
      return false
    }
    if (typeof obj.description !== "string" || !obj.description.length) {
      log.debug({ title: obj.title }, "filtered item with missing/empty description")
      filtered++
      return false
    }
    return true
  })

  if (filtered > 0) {
    log.debug({ filtered, total: parsed.length }, "filtered invalid items")
  }

  return valid
}

export function buildSplitChildPrompt(
  parentConversation: TopicMessage[],
  item: SplitItem,
  allItems: SplitItem[],
): string {
  const MAX_ASSISTANT_CHARS = 4000
  const originalRequest = parentConversation[0]?.text ?? ""

  const lines: string[] = [
    "## Original request",
    "",
    originalRequest,
    "",
  ]

  if (parentConversation.length > 1) {
    lines.push("## Planning thread")
    lines.push("")
    for (const msg of parentConversation.slice(1)) {
      const label = msg.role === "user" ? "**User**" : "**Agent**"
      lines.push(`${label}:`)
      if (msg.role === "assistant" && msg.text.length > MAX_ASSISTANT_CHARS) {
        lines.push(`[earlier output truncated]\n…${msg.text.slice(-MAX_ASSISTANT_CHARS)}`)
      } else {
        lines.push(msg.text)
      }
      lines.push("")
    }
  }

  lines.push("---")
  lines.push("")
  lines.push(`## Your assigned sub-task: ${item.title}`)
  lines.push("")
  lines.push(item.description)
  lines.push("")
  lines.push("## Scope constraints")
  lines.push("")
  lines.push("The following items from the same planning session are being handled by parallel minions.")
  lines.push("Avoid changes outside your scope to prevent merge conflicts.")
  lines.push("")
  for (const other of allItems) {
    if (other.title !== item.title) {
      lines.push(`- ${other.title}`)
    }
  }
  lines.push("")

  lines.push("## Deliverable")
  lines.push("")
  lines.push("When your work is complete:")
  lines.push("1. Write unit and integration tests for your changes")
  lines.push("2. Run unit and integration tests to verify they pass (do NOT run e2e or browser tests — these are expensive and not required)")
  lines.push("3. Commit all changes with a descriptive message")
  lines.push("4. Push your branch")
  lines.push("5. Open a pull request targeting `main`")

  return lines.join("\n")
}
