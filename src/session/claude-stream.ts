import type { GooseStreamEvent, GooseContentType } from "../domain/goose-types.js"

interface ClaudeContentBlock {
  type: string
  text?: string
  thinking?: string
  signature?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  content?: unknown
}

interface ClaudeStreamEvent {
  type: string
  subtype?: string
  parent_tool_use_id?: string | null
  event?: {
    type: string
    index?: number
    content_block?: { type: string; text?: string; id?: string; name?: string }
    delta?: { type: string; text?: string; partial_json?: string }
  }
  message?: {
    role: string
    stop_reason?: string | null
    content: ClaudeContentBlock[]
  }
  result?: string
  is_error?: boolean
  total_cost_usd?: number
  num_turns?: number
  usage?: { output_tokens?: number; input_tokens?: number }
  session_id?: string
}

function buildAssistantContent(
  blocks: ClaudeContentBlock[],
  parentToolUseId: string | null | undefined,
): GooseContentType[] {
  const content: GooseContentType[] = []
  for (const block of blocks) {
    if (block.type === "thinking") {
      content.push({
        type: "thinking",
        thinking: block.thinking ?? "",
        signature: block.signature ?? "",
      })
    } else if (block.type === "tool_use") {
      content.push({
        type: "toolRequest",
        id: block.id ?? "",
        parentToolUseId: parentToolUseId ?? null,
        toolCall: { name: block.name ?? "unknown", arguments: block.input ?? {} },
      })
    }
  }
  return content
}

export function translateClaudeEvent(raw: ClaudeStreamEvent): GooseStreamEvent | null {
  switch (raw.type) {
    case "stream_event": {
      const evt = raw.event
      if (!evt) return null

      if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
        return {
          type: "message",
          message: {
            role: "assistant",
            created: Math.floor(Date.now() / 1000),
            content: [{ type: "text", text: evt.delta.text }],
          },
        }
      }

      return null
    }

    case "assistant": {
      const msg = raw.message
      if (!msg || msg.role !== "assistant") return null

      const content = buildAssistantContent(msg.content, raw.parent_tool_use_id)
      const stopReason = msg.stop_reason ?? null
      if (content.length === 0 && !stopReason) return null

      return {
        type: "message",
        message: {
          role: "assistant",
          created: Math.floor(Date.now() / 1000),
          stopReason,
          content,
        },
      }
    }

    case "result": {
      if (raw.is_error) {
        return { type: "error", error: raw.result ?? "Unknown error" }
      }

      const totalTokens = raw.usage
        ? (raw.usage.input_tokens ?? 0) + (raw.usage.output_tokens ?? 0)
        : null

      return {
        type: "complete",
        total_tokens: totalTokens,
        total_cost_usd: raw.total_cost_usd ?? null,
        num_turns: raw.num_turns ?? null,
      }
    }

    default:
      return null
  }
}

export function translateClaudeEvents(raw: ClaudeStreamEvent): GooseStreamEvent[] {
  if (raw.type === "assistant") {
    const msg = raw.message
    if (!msg || msg.role !== "assistant") return []

    const parentToolUseId = raw.parent_tool_use_id ?? null
    const stopReason = msg.stop_reason ?? null

    const thinkingBlocks = msg.content.filter((b) => b.type === "thinking")
    const toolBlocks = msg.content.filter((b) => b.type === "tool_use")

    const events: GooseStreamEvent[] = []

    for (const block of thinkingBlocks) {
      events.push({
        type: "message",
        message: {
          role: "assistant",
          created: Math.floor(Date.now() / 1000),
          content: [
            {
              type: "thinking",
              thinking: block.thinking ?? "",
              signature: block.signature ?? "",
            },
          ],
        },
      })
    }

    for (let i = 0; i < toolBlocks.length; i++) {
      const block = toolBlocks[i]
      const isLast = i === toolBlocks.length - 1
      events.push({
        type: "message",
        message: {
          role: "assistant",
          created: Math.floor(Date.now() / 1000),
          stopReason: isLast ? stopReason : null,
          content: [
            {
              type: "toolRequest",
              id: block.id ?? "",
              parentToolUseId,
              toolCall: { name: block.name ?? "unknown", arguments: block.input ?? {} },
            },
          ],
        },
      })
    }

    if (events.length === 0 && stopReason) {
      events.push({
        type: "message",
        message: {
          role: "assistant",
          created: Math.floor(Date.now() / 1000),
          stopReason,
          content: [],
        },
      })
    }

    return events
  }

  if (raw.type === "user") {
    const msg = raw.message
    if (!msg || msg.role !== "user") return []

    const parentToolUseId = raw.parent_tool_use_id ?? null
    const toolResultBlocks = msg.content.filter((b) => b.type === "tool_result")
    if (toolResultBlocks.length === 0) return []

    return toolResultBlocks.map((block) => ({
      type: "message" as const,
      message: {
        role: "user" as const,
        created: Math.floor(Date.now() / 1000),
        content: [
          {
            type: "toolResponse" as const,
            id: block.id ?? "",
            parentToolUseId,
            toolResult: block.content ?? block.input ?? null,
          },
        ],
      },
    }))
  }

  const single = translateClaudeEvent(raw)
  return single ? [single] : []
}
