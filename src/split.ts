import { spawn } from "node:child_process"
import type { TopicMessage } from "./types.js"

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

const MAX_RETRIES = 3
const INITIAL_DELAY_MS = 2000
const MAX_ASSISTANT_CHARS = 4000

/**
 * Log current resource usage for debugging
 */
function logResourceUsage(label: string): void {
  const mem = process.memoryUsage()
  process.stderr.write(
    `split: ${label} | ` +
    `heapUsed=${Math.round(mem.heapUsed / 1024 / 1024)}MB ` +
    `heapTotal=${Math.round(mem.heapTotal / 1024 / 1024)}MB ` +
    `rss=${Math.round(mem.rss / 1024 / 1024)}MB\n`,
  )
}

/**
 * Run claude CLI with async spawn, returning stdout or throwing on error
 */
function runClaudeExtraction(task: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "--print",
      "--output-format", "text",
      "--model", "haiku",
      "--no-session-persistence",
      "--append-system-prompt", SPLIT_EXTRACTION_PROMPT,
    ]

    logResourceUsage("spawning claude CLI")

    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (data) => {
      stdout += data.toString()
    })

    child.stderr.on("data", (data) => {
      stderr += data.toString()
    })

    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.on("error", (err) => {
      clearTimeout(timeout)
      reject(err)
    })

    child.on("close", (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve(stdout.trim())
      } else {
        const err = new Error(`claude CLI exited with code ${code}: ${stderr.trim()}`)
        ;(err as NodeJS.ErrnoException).code = code?.toString()
        reject(err)
      }
    })

    // Write the task to stdin
    child.stdin.write(task)
    child.stdin.end()
  })
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Extract parallelizable work items from a planning conversation.
 * Uses async spawn with retry logic to handle transient system resource issues.
 */
export async function extractSplitItems(
  conversation: TopicMessage[],
  directive?: string,
): Promise<ExtractResult> {
  const lines: string[] = ["## Conversation\n"]

  // Log what we're analyzing
  process.stderr.write(`split: analyzing conversation (${conversation.length} messages)\n`)
  if (directive) {
    process.stderr.write(`split: directive: "${directive.slice(0, 100)}${directive.length > 100 ? "..." : ""}"\n`)
  }

  logResourceUsage("starting extraction")

  for (const msg of conversation) {
    const label = msg.role === "user" ? "**User**" : "**Agent**"
    lines.push(`${label}:`)
    if (msg.role === "assistant" && msg.text.length > MAX_ASSISTANT_CHARS) {
      lines.push(`[earlier output truncated]\n…${msg.text.slice(-MAX_ASSISTANT_CHARS)}`)
    } else {
      lines.push(msg.text)
    }
    lines.push("")
  }

  if (directive) {
    lines.push(`## Directive\n\n${directive}`)
  }

  const task = lines.join("\n")

  let lastError: Error | undefined

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      process.stderr.write(`split: attempt ${attempt}/${MAX_RETRIES}\n`)

      const output = await runClaudeExtraction(task, 60_000)

      // Log raw output for debugging
      process.stderr.write(`split: raw output (${output.length} chars)\n`)
      const previewLen = 500
      process.stderr.write(`split: ${output.slice(0, previewLen)}${output.length > previewLen ? "..." : ""}\n`)

      const items = parseSplitItems(output)
      process.stderr.write(`split: extracted ${items.length} valid items\n`)

      return { items }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      const isSpawnError =
        (err as NodeJS.ErrnoException).code === "ETIMEDOUT" ||
        (err as NodeJS.ErrnoException).code === "ENOENT" ||
        (err as NodeJS.ErrnoException).code === "EAGAIN" ||
        err instanceof Error && err.message.includes("spawn")

      if (isSpawnError && attempt < MAX_RETRIES) {
        const delay = INITIAL_DELAY_MS * Math.pow(2, attempt - 1)
        process.stderr.write(
          `split: spawn error on attempt ${attempt}: ${err}. Retrying in ${delay}ms...\n`,
        )
        logResourceUsage(`before retry ${attempt + 1}`)
        await sleep(delay)
      } else {
        process.stderr.write(`split: extraction failed: ${err}\n`)
        return {
          items: [],
          error: "system",
          errorMessage: lastError.message,
        }
      }
    }
  }

  // Should not reach here, but satisfy TypeScript
  return {
    items: [],
    error: "system",
    errorMessage: lastError?.message ?? "Unknown error",
  }
}

export function parseSplitItems(output: string): SplitItem[] {
  let text = output.trim()

  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }

  const arrayMatch = text.match(/\[[\s\S]*\]/)
  if (!arrayMatch) {
    process.stderr.write(`split: no JSON array found in output\n`)
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(arrayMatch[0])
  } catch (e) {
    process.stderr.write(`split: JSON parse error: ${e}\n`)
    return []
  }
  if (!Array.isArray(parsed)) {
    process.stderr.write(`split: parsed value is not an array (got ${typeof parsed})\n`)
    return []
  }

  // Log filtering decisions
  let filtered = 0
  const valid = parsed.filter((item: unknown): item is SplitItem => {
    if (typeof item !== "object" || item === null) {
      process.stderr.write(`split: filtered non-object item\n`)
      filtered++
      return false
    }
    const obj = item as Record<string, unknown>
    if (typeof obj.title !== "string" || !obj.title.length) {
      process.stderr.write(`split: filtered item with missing/empty title\n`)
      filtered++
      return false
    }
    if (typeof obj.description !== "string" || !obj.description.length) {
      process.stderr.write(`split: filtered item "${obj.title}" with missing/empty description\n`)
      filtered++
      return false
    }
    return true
  })

  if (filtered > 0) {
    process.stderr.write(`split: filtered ${filtered} invalid items from ${parsed.length} candidates\n`)
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

  return lines.join("\n")
}
