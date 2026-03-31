import type { TopicMessage } from "../types.js"
import type { DagInput } from "./dag.js"
import type { ProviderProfile } from "../config/config-types.js"
import { retryClaudeExtraction, buildConversationText, ParseError } from "../claude-extract.js"
import { loggers } from "../logger.js"

const log = loggers.dagExtract

export interface DagExtractResult {
  items: DagInput[]
  error?: "system" | "parse"
  errorMessage?: string
}

const DAG_EXTRACTION_PROMPT = [
  "You are a task dependency analyzer. Given a planning/research conversation, extract discrete work items AND their dependencies.",
  "",
  "For each item, determine which other items it depends on. An item depends on another if:",
  "1. It needs code/APIs/schemas that the other item creates",
  "2. It modifies files that the other item must set up first",
  "3. It tests or integrates work that the other item produces",
  "",
  "Rules:",
  "- Default to INDEPENDENT (no dependencies) unless there's a clear data/API/schema dependency",
  "- Minimize edges — don't add A→C if A→B→C already exists (transitive reduction)",
  "- IDs must be short kebab-case identifiers (e.g., 'db-schema', 'auth-service', 'api-routes')",
  "- No cycles allowed",
  "- If the user provided a directive, use it to filter or refine the items",
  "",
  "Output ONLY a JSON array with no surrounding text or markdown fencing:",
  '[{ "id": "short-kebab-id", "title": "short label (under 60 chars)", "description": "full task description with scope constraints", "dependsOn": ["id-of-dependency"] }]',
  "",
  "If you cannot identify discrete items, output an empty array: []",
].join("\n")

const STACK_EXTRACTION_PROMPT = [
  "You are a task sequencer. Given a planning/research conversation, extract discrete work items that should be done IN ORDER (sequentially).",
  "",
  "Items should be ordered so that each step builds on the previous one. Think about:",
  "1. Foundation/infrastructure first (schemas, types, core abstractions)",
  "2. Implementation next (services, handlers, business logic)",
  "3. Integration and tests last (connecting components, E2E tests)",
  "",
  "Rules:",
  "- Each item should be a meaningful unit of work that produces a PR",
  "- Order matters — item N can assume items 0..N-1 are already merged",
  "- Keep items focused (200-400 lines of changes each is ideal)",
  "- If the user provided a directive, use it to filter or refine the items",
  "",
  "Output ONLY a JSON array IN ORDER with no surrounding text or markdown fencing:",
  '[{ "title": "short label (under 60 chars)", "description": "full task description with scope constraints and what to build on from previous steps" }]',
  "",
  "If you cannot identify discrete sequential items, output an empty array: []",
].join("\n")

const EXTRACTION_TIMEOUT_MS = 120_000

/**
 * Extract DAG items (with dependencies) from a planning conversation.
 */
export async function extractDagItems(
  conversation: TopicMessage[],
  directive?: string,
  profile?: ProviderProfile,
): Promise<DagExtractResult> {
  const task = buildConversationText(conversation, directive)
  log.debug({ messageCount: conversation.length }, "analyzing conversation for DAG items")

  const result = await retryClaudeExtraction(
    task,
    DAG_EXTRACTION_PROMPT,
    (output) => parseDagItems(output),
    { timeoutMs: EXTRACTION_TIMEOUT_MS, profile, log },
  )

  if (result.data) {
    log.debug({ itemCount: result.data.length }, "extracted valid items")
    return { items: result.data }
  }
  return { items: [], error: result.error, errorMessage: result.errorMessage }
}

/**
 * Extract linear stack items (ordered, no explicit dependencies) from a planning conversation.
 */
export async function extractStackItems(
  conversation: TopicMessage[],
  directive?: string,
  profile?: ProviderProfile,
): Promise<DagExtractResult> {
  const task = buildConversationText(conversation, directive)
  log.debug({ messageCount: conversation.length }, "analyzing conversation for stack items")

  const result = await retryClaudeExtraction(
    task,
    STACK_EXTRACTION_PROMPT,
    (output) => {
      const ordered = parseStackItems(output)
      return ordered.map((item, i): DagInput => ({
        id: `step-${i}`,
        title: item.title,
        description: item.description,
        dependsOn: i > 0 ? [`step-${i - 1}`] : [],
      }))
    },
    { timeoutMs: EXTRACTION_TIMEOUT_MS, profile, log },
  )

  if (result.data) {
    log.debug({ itemCount: result.data.length }, "extracted stack items")
    return { items: result.data }
  }
  return { items: [], error: result.error, errorMessage: result.errorMessage }
}

export function parseDagItems(output: string): DagInput[] {
  let text = output.trim()

  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }

  const arrayMatch = text.match(/\[[\s\S]*\]/)
  if (!arrayMatch) {
    throw new ParseError("no JSON array found in DAG output")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(arrayMatch[0])
  } catch (e) {
    throw new ParseError(`JSON parse error in DAG output: ${String(e)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new ParseError("parsed value is not an array in DAG output")
  }

  const valid = parsed.filter((item: unknown): item is DagInput => {
    if (typeof item !== "object" || item === null) return false
    const obj = item as Record<string, unknown>
    if (typeof obj.id !== "string" || !obj.id.length) return false
    if (typeof obj.title !== "string" || !obj.title.length) return false
    if (typeof obj.description !== "string" || !obj.description.length) return false
    if (!Array.isArray(obj.dependsOn)) {
      // Allow missing dependsOn — default to empty
      obj.dependsOn = []
    }
    const deps = obj.dependsOn as unknown[]
    if (!deps.every((d: unknown) => typeof d === "string")) return false
    return true
  })

  return valid
}

export function parseStackItems(output: string): { title: string; description: string }[] {
  let text = output.trim()

  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }

  const arrayMatch = text.match(/\[[\s\S]*\]/)
  if (!arrayMatch) {
    throw new ParseError("no JSON array found in stack output")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(arrayMatch[0])
  } catch (e) {
    throw new ParseError(`JSON parse error in stack output: ${String(e)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new ParseError("parsed value is not an array in stack output")
  }

  return parsed.filter((item: unknown): item is { title: string; description: string } => {
    if (typeof item !== "object" || item === null) return false
    const obj = item as Record<string, unknown>
    return typeof obj.title === "string" && obj.title.length > 0 &&
      typeof obj.description === "string" && obj.description.length > 0
  })
}

/**
 * Build the prompt for a DAG child session.
 * Includes context from parent conversation, the specific task, and dependency context.
 */
export function buildDagChildPrompt(
  parentConversation: TopicMessage[],
  node: DagInput,
  allNodes: DagInput[],
  upstreamBranches: string[],
  isStack: boolean,
  conflictFiles: string[] = [],
): string {
  const originalRequest = parentConversation[0]?.text ?? ""

  const lines: string[] = [
    "## Original request",
    "",
    originalRequest,
    "",
  ]

  if (parentConversation.length > 1) {
    const MAX_PLANNING_CHARS = 2000
    const planMessages = parentConversation.slice(1)
    const recentMessages = planMessages.slice(-4)
    lines.push("## Planning thread")
    lines.push("")
    if (planMessages.length > recentMessages.length) {
      lines.push(`[${planMessages.length - recentMessages.length} earlier messages omitted]`)
      lines.push("")
    }
    for (const msg of recentMessages) {
      const label = msg.role === "user" ? "**User**" : "**Agent**"
      lines.push(`${label}:`)
      if (msg.role === "assistant" && msg.text.length > MAX_PLANNING_CHARS) {
        lines.push(`[output truncated]\n…${msg.text.slice(-MAX_PLANNING_CHARS)}`)
      } else {
        lines.push(msg.text)
      }
      lines.push("")
    }
  }

  lines.push("---")
  lines.push("")
  lines.push(`## Your assigned sub-task: ${node.title}`)
  lines.push("")
  lines.push(node.description)
  lines.push("")

  if (conflictFiles.length > 0) {
    lines.push("## ⚠️ Merge conflicts to resolve first")
    lines.push("")
    lines.push("Your working tree has merge conflicts from combining upstream branches.")
    lines.push("**Before starting your task**, resolve all conflicts:")
    lines.push("")
    for (const f of conflictFiles) {
      lines.push(`- \`${f}\``)
    }
    lines.push("")
    lines.push("Steps:")
    lines.push("1. Open each conflicted file and resolve the `<<<<<<<` / `=======` / `>>>>>>>` markers")
    lines.push("2. Keep the intent of both sides — do not discard upstream work")
    lines.push("3. `git add` each resolved file")
    lines.push("4. `git commit --no-edit` to finalize the merge")
    lines.push("5. Then proceed with your assigned task below")
    lines.push("")
  }

  if (node.dependsOn.length > 0) {
    lines.push("## Upstream context")
    lines.push("")
    lines.push("The following tasks have already been completed and their changes are in your working tree:")
    lines.push("")
    for (const depId of node.dependsOn) {
      const dep = allNodes.find((n) => n.id === depId)
      if (dep) lines.push(`- ✅ ${dep.title}`)
    }
    lines.push("")
    lines.push("Build on top of their work. Do NOT redo anything they've already done.")
    lines.push("")
  }

  if (isStack && upstreamBranches.length > 0) {
    lines.push("## PR target")
    lines.push("")
    lines.push(`When creating your PR, target the branch \`${upstreamBranches[upstreamBranches.length - 1]}\` (not main).`)
    lines.push("This creates a stacked PR that reviewers can see as an incremental diff.")
    lines.push("")
  }

  // Scope constraints — what other nodes are handling
  const siblings = allNodes.filter((n) => n.id !== node.id && !node.dependsOn.includes(n.id))
  if (siblings.length > 0) {
    lines.push("## Scope constraints")
    lines.push("")
    lines.push("The following items are being handled by other minions.")
    lines.push("Avoid changes outside your scope to prevent merge conflicts.")
    lines.push("")
    for (const other of siblings) {
      lines.push(`- ${other.title}`)
    }
    lines.push("")
  }

  const targetBranch = isStack && upstreamBranches.length > 0
    ? upstreamBranches[upstreamBranches.length - 1]
    : "main"

  lines.push("## Deliverable")
  lines.push("")
  lines.push("When your work is complete:")
  lines.push("1. Write unit and integration tests for your changes")
  lines.push("2. Run unit and integration tests to verify they pass (do NOT run e2e or browser tests — these are expensive and not required)")
  lines.push("3. Commit all changes with a descriptive message")
  lines.push("4. Push your branch")
  lines.push(`5. Open a pull request targeting \`${targetBranch}\``)

  return lines.join("\n")
}
