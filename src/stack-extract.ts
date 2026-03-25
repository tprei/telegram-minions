import { spawn } from "node:child_process"
import type { TopicMessage } from "./types.js"
import type { StackItem, StackExtractResult } from "./stack-orchestrator.js"

const STACK_EXTRACTION_PROMPT = [
  "You are a task stacker. Given a planning/research conversation, extract work items that may have dependencies on each other.",
  "",
  "Items should be stacked (depend on each other) when:",
  "1. One change builds on top of another (e.g., refactor → new feature → tests)",
  "2. API changes need to happen before frontend can use them",
  "3. Infrastructure changes need to land before application code",
  "4. There's a clear logical sequence where order matters",
  "",
  "Items can be parallel (no dependencies) when:",
  "1. They address different logical concerns (UI vs backend vs tests)",
  "2. They don't share code paths that would cause conflicts",
  "3. Either could be merged first without breaking the other",
  "",
  "For each item, specify which other items it depends on using their IDs.",
  "",
  "Output ONLY a JSON array with no surrounding text or markdown fencing:",
  '[{ "id": "unique-id", "title": "short label", "description": "full task description", "dependencies": ["id-of-prerequisite"] }]',
  "",
  "Use descriptive IDs like: refactor-core, add-api, update-frontend, add-tests",
  "",
  "If items have no dependencies (all parallel), use empty array: []",
  "",
  "If you cannot identify discrete work items, output an empty array: []",
].join("\n")

const MAX_RETRIES = 3
const INITIAL_DELAY_MS = 2000
const MAX_ASSISTANT_CHARS = 4000

function logResourceUsage(label: string): void {
  const mem = process.memoryUsage()
  process.stderr.write(
    `stack: ${label} | ` +
      `heapUsed=${Math.round(mem.heapUsed / 1024 / 1024)}MB ` +
      `heapTotal=${Math.round(mem.heapTotal / 1024 / 1024)}MB ` +
      `rss=${Math.round(mem.rss / 1024 / 1024)}MB\n`,
  )
}

function runClaudeExtraction(task: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "--print",
      "--output-format",
      "text",
      "--model",
      "haiku",
      "--no-session-persistence",
      "--append-system-prompt",
      STACK_EXTRACTION_PROMPT,
    ]

    logResourceUsage("spawning claude CLI for stack extraction")

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

    child.stdin.write(task)
    child.stdin.end()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Extract stackable work items from a planning conversation.
 * Uses AI to identify both items and their dependencies.
 */
export async function extractStackItems(
  conversation: TopicMessage[],
  directive?: string,
): Promise<StackExtractResult> {
  const lines: string[] = ["## Conversation\n"]

  process.stderr.write(`stack: analyzing conversation (${conversation.length} messages)\n`)
  if (directive) {
    process.stderr.write(
      `stack: directive: "${directive.slice(0, 100)}${directive.length > 100 ? "..." : ""}"\n`,
    )
  }

  logResourceUsage("starting stack extraction")

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
      process.stderr.write(`stack: attempt ${attempt}/${MAX_RETRIES}\n`)

      const output = await runClaudeExtraction(task, 60_000)

      process.stderr.write(`stack: raw output (${output.length} chars)\n`)
      const previewLen = 500
      process.stderr.write(
        `stack: ${output.slice(0, previewLen)}${output.length > previewLen ? "..." : ""}\n`,
      )

      const items = parseStackItems(output)
      process.stderr.write(`stack: extracted ${items.length} valid items\n`)

      return { items }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      const isSpawnError =
        (err as NodeJS.ErrnoException).code === "ETIMEDOUT" ||
        (err as NodeJS.ErrnoException).code === "ENOENT" ||
        (err as NodeJS.ErrnoException).code === "EAGAIN" ||
        (err instanceof Error && err.message.includes("spawn"))

      if (isSpawnError && attempt < MAX_RETRIES) {
        const delay = INITIAL_DELAY_MS * Math.pow(2, attempt - 1)
        process.stderr.write(
          `stack: spawn error on attempt ${attempt}: ${err}. Retrying in ${delay}ms...\n`,
        )
        logResourceUsage(`before retry ${attempt + 1}`)
        await sleep(delay)
      } else {
        process.stderr.write(`stack: extraction failed: ${err}\n`)
        return {
          items: [],
          error: "system",
          errorMessage: lastError.message,
        }
      }
    }
  }

  return {
    items: [],
    error: "system",
    errorMessage: lastError?.message ?? "Unknown error",
  }
}

export function parseStackItems(output: string): StackItem[] {
  let text = output.trim()

  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }

  const arrayMatch = text.match(/\[[\s\S]*\]/)
  if (!arrayMatch) {
    process.stderr.write(`stack: no JSON array found in output\n`)
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(arrayMatch[0])
  } catch (e) {
    process.stderr.write(`stack: JSON parse error: ${e}\n`)
    return []
  }

  if (!Array.isArray(parsed)) {
    process.stderr.write(`stack: parsed value is not an array (got ${typeof parsed})\n`)
    return []
  }

  // First pass: collect all valid items and their IDs
  let filtered = 0
  const validItems: StackItem[] = []
  const validIds = new Set<string>()

  for (const item of parsed) {
    if (typeof item !== "object" || item === null) {
      filtered++
      continue
    }

    const obj = item as Record<string, unknown>
    if (typeof obj.id !== "string" || !obj.id.length) {
      process.stderr.write(`stack: filtered item with missing/empty id\n`)
      filtered++
      continue
    }

    if (typeof obj.title !== "string" || !obj.title.length) {
      process.stderr.write(`stack: filtered item "${obj.id}" with missing/empty title\n`)
      filtered++
      continue
    }

    if (typeof obj.description !== "string" || !obj.description.length) {
      process.stderr.write(`stack: filtered item "${obj.id}" with missing/empty description\n`)
      filtered++
      continue
    }

    const deps = Array.isArray(obj.dependencies)
      ? (obj.dependencies as string[]).filter((d) => typeof d === "string")
      : []

    validItems.push({
      id: obj.id,
      title: obj.title,
      description: obj.description,
      dependencies: deps,
    })
    validIds.add(obj.id)
  }

  // Second pass: filter dependencies to only include valid IDs
  for (const item of validItems) {
    item.dependencies = item.dependencies.filter((dep) => {
      if (!validIds.has(dep)) {
        process.stderr.write(
          `stack: item "${item.id}" has invalid dependency "${dep}" - removing\n`,
        )
        return false
      }
      return true
    })
  }

  if (filtered > 0) {
    process.stderr.write(
      `stack: filtered ${filtered} invalid items from ${parsed.length} candidates\n`,
    )
  }

  return validItems
}

/**
 * Build a prompt for a stack child minion
 */
export function buildStackChildPrompt(
  parentConversation: TopicMessage[],
  item: StackItem,
  allItems: StackItem[],
): string {
  const MAX_CHARS = 4000
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
      if (msg.role === "assistant" && msg.text.length > MAX_CHARS) {
        lines.push(`[earlier output truncated]\n…${msg.text.slice(-MAX_CHARS)}`)
      } else {
        lines.push(msg.text)
      }
      lines.push("")
    }
  }

  lines.push("---")
  lines.push("")
  lines.push(`## Your assigned stack item: ${item.title}`)
  lines.push("")
  lines.push(item.description)
  lines.push("")

  if (item.dependencies.length > 0) {
    lines.push("## Dependencies")
    lines.push("")
    lines.push("This item depends on the following items being completed first:")
    for (const depId of item.dependencies) {
      const dep = allItems.find((i) => i.id === depId)
      if (dep) {
        lines.push(`- **${dep.title}**: ${dep.description.slice(0, 100)}...`)
      }
    }
    lines.push("")
    lines.push("The parent changes have been merged to main. Your branch is based on those changes.")
    lines.push("")
  }

  lines.push("## Stack context")
  lines.push("")
  lines.push("The following items are part of the same stack:")
  for (const other of allItems) {
    const status = other.id === item.id ? " (YOU)" : ""
    const deps =
      other.dependencies.length > 0 ? ` — depends on: ${other.dependencies.join(", ")}` : ""
    lines.push(`- ${other.title}${status}${deps}`)
  }

  return lines.join("\n")
}
