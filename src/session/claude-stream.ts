import type { GooseStreamEvent } from "../domain/goose-types.js"
interface ClaudeStreamEvent {
  type: string
  subtype?: string
  event?: {
    type: string
    index?: number
    content_block?: { type: string; text?: string; id?: string; name?: string }
    delta?: { type: string; text?: string; partial_json?: string }
  }
  message?: {
    role: string
    content: Array<{
      type: string
      text?: string
      id?: string
      name?: string
      input?: Record<string, unknown>
      content?: unknown
    }>
  }
  result?: string
  is_error?: boolean
  total_cost_usd?: number
  num_turns?: number
  usage?: { output_tokens?: number; input_tokens?: number }
  session_id?: string
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

      const toolBlocks = msg.content.filter((b) => b.type === "tool_use")
      if (toolBlocks.length === 0) return null

      // Return one event per tool_use block so parallel calls are all visible
      const events: GooseStreamEvent[] = toolBlocks.map((block) => ({
        type: "message" as const,
        message: {
          role: "assistant" as const,
          created: Math.floor(Date.now() / 1000),
          content: [
            {
              type: "toolRequest" as const,
              id: block.id ?? "",
              toolCall: { name: block.name ?? "unknown", arguments: block.input ?? {} },
            },
          ],
        },
      }))

      return events[0]
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

    const toolBlocks = msg.content.filter((b) => b.type === "tool_use")
    return toolBlocks.map((block) => ({
      type: "message" as const,
      message: {
        role: "assistant" as const,
        created: Math.floor(Date.now() / 1000),
        content: [
          {
            type: "toolRequest" as const,
            id: block.id ?? "",
            toolCall: { name: block.name ?? "unknown", arguments: block.input ?? {} },
          },
        ],
      },
    }))
  }

  if (raw.type === "user") {
    const msg = raw.message
    if (!msg || msg.role !== "user") return []

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
            toolResult: block.content ?? block.input ?? null,
          },
        ],
      },
    }))
  }

  const single = translateClaudeEvent(raw)
  return single ? [single] : []
}
