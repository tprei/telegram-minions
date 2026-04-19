import type {
  ToolCallSummary,
  ToolKind,
  ToolResultFormat,
  ToolResultPayload,
  TranscriptTruncationBudget,
} from "./types.js"
import { TRANSCRIPT_TRUNCATION_BUDGET } from "./types.js"

/**
 * Channel-agnostic classification and sanitisation for tool calls and results.
 *
 * Upstream providers (Anthropic, Goose, the ACP bridge) emit tool calls with
 * slightly different naming and result shapes. This module collapses those
 * variants into a stable `ToolCallSummary` / `ToolResultPayload` so frontends
 * (PWA, future clients) can render transcripts without reimplementing the
 * provider quirks.
 */

const MAX_SUBTITLE = 120
const UNKNOWN_TOOL_NAME = "unknown"

export interface ClassifiedTool {
  kind: ToolKind
  title: string
  subtitle?: string
}

/**
 * Parsed MCP naming — `mcp__<server>__<tool>` becomes `{ server, tool }`.
 * Returns `null` when `name` is not an MCP-prefixed tool.
 */
export function parseMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null
  const rest = name.slice("mcp__".length)
  const sep = rest.indexOf("__")
  if (sep <= 0) return { server: rest || "unknown", tool: "" }
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) }
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = input[key]
    if (typeof v === "string" && v.length > 0) return v
  }
  return undefined
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…"
}

const FILE_PATH_KEYS = ["file_path", "path", "filePath", "target_file"] as const
const BASH_COMMAND_KEYS = ["command", "cmd", "script"] as const
const SEARCH_PATTERN_KEYS = ["pattern", "query", "search"] as const
const URL_KEYS = ["url", "href"] as const

type KindResolver = (args: Record<string, unknown>, name: string) => ClassifiedTool

const KIND_RESOLVERS: Record<string, KindResolver> = {
  // Claude Code / Anthropic names
  Read: (a) => ({ kind: "read", title: "Read file", subtitle: firstString(a, FILE_PATH_KEYS) }),
  Write: (a) => ({ kind: "write", title: "Write file", subtitle: firstString(a, FILE_PATH_KEYS) }),
  Edit: (a) => ({ kind: "edit", title: "Edit file", subtitle: firstString(a, FILE_PATH_KEYS) }),
  MultiEdit: (a) => ({ kind: "edit", title: "Edit file (multi)", subtitle: firstString(a, FILE_PATH_KEYS) }),
  NotebookEdit: (a) => ({
    kind: "notebook",
    title: "Edit notebook",
    subtitle: firstString(a, ["notebook_path", ...FILE_PATH_KEYS]),
  }),
  Bash: (a) => ({ kind: "bash", title: "Run command", subtitle: firstString(a, BASH_COMMAND_KEYS) }),
  BashOutput: () => ({ kind: "bash", title: "Read background output" }),
  KillShell: () => ({ kind: "bash", title: "Kill background shell" }),
  KillBash: () => ({ kind: "bash", title: "Kill background shell" }),
  Grep: (a) => ({ kind: "search", title: "Search", subtitle: firstString(a, SEARCH_PATTERN_KEYS) }),
  Glob: (a) => ({ kind: "glob", title: "List files", subtitle: firstString(a, ["pattern", "path"]) }),
  WebFetch: (a) => ({ kind: "web_fetch", title: "Fetch URL", subtitle: firstString(a, URL_KEYS) }),
  WebSearch: (a) => ({
    kind: "web_search",
    title: "Web search",
    subtitle: firstString(a, ["query", "search_query"]),
  }),
  Task: (a) => ({
    kind: "task",
    title: "Delegate to agent",
    subtitle: firstString(a, ["description", "prompt", "subagent_type"]),
  }),
  TodoWrite: () => ({ kind: "todo", title: "Update todo list" }),

  // Goose-style aliases
  read_file: (a) => ({ kind: "read", title: "Read file", subtitle: firstString(a, FILE_PATH_KEYS) }),
  write_file: (a) => ({ kind: "write", title: "Write file", subtitle: firstString(a, FILE_PATH_KEYS) }),
  edit_file: (a) => ({ kind: "edit", title: "Edit file", subtitle: firstString(a, FILE_PATH_KEYS) }),
  shell: (a) => ({ kind: "bash", title: "Run command", subtitle: firstString(a, BASH_COMMAND_KEYS) }),
  list_directory: (a) => ({ kind: "glob", title: "List directory", subtitle: firstString(a, ["path"]) }),
  search: (a) => ({ kind: "search", title: "Search", subtitle: firstString(a, SEARCH_PATTERN_KEYS) }),
}

function classifyBrowserTool(name: string, args: Record<string, unknown>): ClassifiedTool {
  const parsed = parseMcpName(name)
  const tool = parsed?.tool || name
  const action = tool.startsWith("browser_") ? tool.slice("browser_".length) : tool
  const subtitle = firstString(args, [
    "url",
    "selector",
    "text",
    "ref",
    "element",
    "path",
    "filename",
  ])
  const pretty = action.length > 0 ? action.replace(/_/g, " ") : "browser"
  const title = /take_screenshot|screenshot/i.test(action)
    ? "Browser screenshot"
    : `Browser · ${pretty}`
  return { kind: "browser", title, subtitle }
}

function classifyMcpTool(name: string, args: Record<string, unknown>): ClassifiedTool {
  const parsed = parseMcpName(name)
  if (parsed?.server === "playwright" || /browser_/.test(parsed?.tool ?? "")) {
    return classifyBrowserTool(name, args)
  }
  const server = parsed?.server ?? "mcp"
  const tool = parsed?.tool ?? name
  const subtitle = firstString(args, [
    ...URL_KEYS,
    "query",
    "repo",
    "owner",
    "issue_number",
    "pull_number",
    "project",
    "path",
    "target_id",
  ])
  const label = tool.length > 0 ? `${server} · ${tool.replace(/_/g, " ")}` : server
  return { kind: "mcp", title: label, subtitle }
}

function normaliseInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  return {}
}

/**
 * Classify a tool call. Returns the `kind` plus display labels tailored to the
 * tool's arguments. Unknown tools fall through to a generic `other` kind with
 * the raw name as the title.
 */
export function classifyTool(name: string, input: unknown): ClassifiedTool {
  const resolved: string = typeof name === "string" && name.length > 0 ? name : UNKNOWN_TOOL_NAME
  const args = normaliseInput(input)

  const direct = KIND_RESOLVERS[resolved]
  if (direct) {
    const out = direct(args, resolved)
    return {
      kind: out.kind,
      title: out.title,
      subtitle: out.subtitle ? truncate(out.subtitle, MAX_SUBTITLE) : undefined,
    }
  }

  if (resolved.startsWith("mcp__")) {
    const out = classifyMcpTool(resolved, args)
    return {
      kind: out.kind,
      title: out.title,
      subtitle: out.subtitle ? truncate(out.subtitle, MAX_SUBTITLE) : undefined,
    }
  }

  if (resolved.startsWith("browser_")) {
    const out = classifyBrowserTool(resolved, args)
    return {
      kind: out.kind,
      title: out.title,
      subtitle: out.subtitle ? truncate(out.subtitle, MAX_SUBTITLE) : undefined,
    }
  }

  // Generic fallback — keep the raw name so the UI can still surface it.
  return { kind: "other", title: resolved }
}

export interface BuildToolCallSummaryOptions {
  parentToolUseId?: string
}

/**
 * Produce a `ToolCallSummary` for a tool invocation. `input` is stored as-is so
 * the UI can show the full arguments when expanded.
 */
export function buildToolCallSummary(
  toolUseId: string,
  name: string,
  input: unknown,
  options: BuildToolCallSummaryOptions = {},
): ToolCallSummary {
  const args = normaliseInput(input)
  const classified = classifyTool(name, args)
  const summary: ToolCallSummary = {
    toolUseId,
    name: typeof name === "string" && name.length > 0 ? name : UNKNOWN_TOOL_NAME,
    kind: classified.kind,
    title: classified.title,
    input: args,
  }
  if (classified.subtitle) summary.subtitle = classified.subtitle
  if (options.parentToolUseId) summary.parentToolUseId = options.parentToolUseId
  return summary
}

interface ExtractedResult {
  text: string | undefined
  images: string[]
  isError: boolean
  meta: Record<string, unknown>
}

function appendImage(images: string[], item: Record<string, unknown>): void {
  const data = typeof item["data"] === "string" ? (item["data"] as string) : undefined
  if (data) {
    const mime =
      typeof item["mimeType"] === "string"
        ? (item["mimeType"] as string)
        : typeof (item["source"] as { media_type?: unknown } | undefined)?.media_type === "string"
          ? ((item["source"] as { media_type: string }).media_type)
          : "image/png"
    images.push(`data:${mime};base64,${data}`)
    return
  }
  const source = item["source"]
  if (source && typeof source === "object") {
    const src = source as { data?: unknown; media_type?: unknown; url?: unknown }
    if (typeof src.url === "string") {
      images.push(src.url)
      return
    }
    if (typeof src.data === "string") {
      const mime = typeof src.media_type === "string" ? src.media_type : "image/png"
      images.push(`data:${mime};base64,${src.data}`)
      return
    }
  }
  if (typeof item["path"] === "string") images.push(item["path"] as string)
  else if (typeof item["url"] === "string") images.push(item["url"] as string)
}

function extractTextFromContent(raw: unknown): ExtractedResult {
  const texts: string[] = []
  const images: string[] = []
  const meta: Record<string, unknown> = {}
  let isError = false

  const walk = (node: unknown): void => {
    if (node == null) return
    if (typeof node === "string") {
      if (node.length > 0) texts.push(node)
      return
    }
    if (typeof node === "number" || typeof node === "boolean") {
      texts.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (typeof node !== "object") return

    const obj = node as Record<string, unknown>
    const type = typeof obj["type"] === "string" ? (obj["type"] as string) : undefined

    if (type === "text" && typeof obj["text"] === "string") {
      texts.push(obj["text"] as string)
      return
    }
    if (type === "image") {
      appendImage(images, obj)
      return
    }
    if (type === "resource" || type === "resource_link") {
      const resource = (obj["resource"] as Record<string, unknown> | undefined) ?? obj
      if (typeof resource["text"] === "string") {
        texts.push(resource["text"] as string)
        return
      }
      if (typeof resource["uri"] === "string") {
        texts.push(resource["uri"] as string)
        return
      }
    }

    if (obj["is_error"] === true || obj["isError"] === true) isError = true
    if (Array.isArray(obj["content"])) {
      walk(obj["content"])
      return
    }
    if (typeof obj["text"] === "string") {
      texts.push(obj["text"] as string)
      return
    }
    if (typeof obj["output"] === "string") {
      texts.push(obj["output"] as string)
    }
    if (typeof obj["stdout"] === "string" && (obj["stdout"] as string).length > 0) {
      texts.push(obj["stdout"] as string)
    }
    if (typeof obj["stderr"] === "string" && (obj["stderr"] as string).length > 0) {
      texts.push(obj["stderr"] as string)
    }
    if (typeof obj["error"] === "string") {
      isError = true
      texts.push(obj["error"] as string)
    }
    if (typeof obj["exitCode"] === "number") meta["exitCode"] = obj["exitCode"]
    else if (typeof obj["exit_code"] === "number") meta["exitCode"] = obj["exit_code"]
    if (typeof obj["cwd"] === "string") meta["cwd"] = obj["cwd"]
    if (typeof obj["mode"] === "string") meta["mode"] = obj["mode"]
    if (typeof obj["url"] === "string" && !Array.isArray(obj["content"])) meta["url"] = obj["url"]
  }

  walk(raw)

  const text = texts.length > 0 ? texts.join("\n") : undefined
  return { text, images, isError, meta }
}

function detectFormat(kind: ToolKind, text: string | undefined): ToolResultFormat {
  if (!text) return "text"
  const trimmed = text.trimStart()
  if (/^(diff --git|---\s|\+\+\+\s|@@ )/m.test(trimmed)) return "diff"
  if (kind === "web_fetch" || kind === "web_search") return "markdown"
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed)
      return "json"
    } catch {
      // Not JSON — fall through.
    }
  }
  return "text"
}

function budgetFor(
  kind: ToolKind,
  budget: TranscriptTruncationBudget,
): number {
  switch (kind) {
    case "bash":
      return budget.bashBytes
    case "read":
    case "write":
    case "edit":
    case "notebook":
      return budget.fileBytes
    default:
      return budget.fileBytes
  }
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8")
}

function truncateToBytes(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s
  // Trim in chunks to avoid per-char Buffer.byteLength calls.
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (byteLength(s.slice(0, mid)) <= maxBytes) lo = mid
    else hi = mid - 1
  }
  return s.slice(0, lo)
}

export interface BuildToolResultOptions {
  /** Tool name from the matching `ToolCallEvent`, used to pick a byte budget. */
  toolName?: string
  /** Override the default truncation budget. */
  budget?: TranscriptTruncationBudget
  /** Force the result status (e.g. when the provider signals an error). */
  status?: "ok" | "error"
  /** Explicit error message (used when provider-level error markers are present). */
  error?: string
}

/**
 * Convert an upstream tool-result payload into a sanitised `ToolResultPayload`.
 * - Text is concatenated from provider-specific content blocks.
 * - Base64 images are split out into `images` as data URIs so the UI can render
 *   them without decoding the transcript stream.
 * - Large payloads are truncated to the per-kind budget; `truncated` and
 *   `originalBytes` let the UI surface a "view full" affordance.
 */
export function buildToolResultPayload(
  raw: unknown,
  options: BuildToolResultOptions = {},
): ToolResultPayload {
  const budget = options.budget ?? TRANSCRIPT_TRUNCATION_BUDGET
  const kind = options.toolName ? classifyTool(options.toolName, {}).kind : "other"
  const extracted = extractTextFromContent(raw)

  const originalBytes = extracted.text ? byteLength(extracted.text) : 0
  const maxBytes = budgetFor(kind, budget)
  const truncated = originalBytes > maxBytes

  let text = extracted.text
  if (text && truncated) text = truncateToBytes(text, maxBytes) + "\n…[truncated]"

  const payload: ToolResultPayload = {
    status: options.status ?? (extracted.isError ? "error" : "ok"),
  }

  if (text !== undefined) payload.text = text
  if (truncated) {
    payload.truncated = true
    payload.originalBytes = originalBytes
  }
  if (extracted.images.length > 0) payload.images = extracted.images
  if (Object.keys(extracted.meta).length > 0) payload.meta = extracted.meta

  const format = detectFormat(kind, text)
  if (format !== "text") payload.format = format

  if (payload.status === "error") {
    const explicit = options.error
    if (explicit && explicit.length > 0) payload.error = explicit
    else if (text && text.length > 0) payload.error = truncate(text, 500)
  }

  return payload
}
