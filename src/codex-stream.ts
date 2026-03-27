import type { GooseStreamEvent } from "./types.js"

// Codex exec NDJSON event types (from codex-rs/exec)
// {"type":"item.started","item":{...}}
// {"type":"item.completed","item":{...}}
// {"type":"error","error":{...}}
// {"type":"done","usage":{...}}  (optional final event with usage)

interface CodexContentPart {
  type: string
  text?: string
  [key: string]: unknown
}

interface CodexItem {
  type: string
  id?: string
  role?: string
  content?: CodexContentPart[]
  name?: string
  arguments?: string
  call_id?: string
  output?: string
  usage?: { input_tokens?: number; output_tokens?: number }
  [key: string]: unknown
}

interface CodexEvent {
  type: string
  item?: CodexItem
  error?: { message?: string; type?: string; code?: string }
  usage?: { input_tokens?: number; output_tokens?: number }
}

function parseArguments(argsJson: string | undefined): Record<string, unknown> {
  if (!argsJson) return {}
  try {
    return JSON.parse(argsJson) as Record<string, unknown>
  } catch {
    return { raw: argsJson }
  }
}

export function translateCodexEvent(raw: CodexEvent): GooseStreamEvent | null {
  switch (raw.type) {
    case "item.completed": {
      const item = raw.item
      if (!item) return null

      if (item.type === "message" && item.role === "assistant") {
        const textParts = (item.content ?? []).filter(
          (c) => c.type === "output_text" && c.text,
        )
        if (textParts.length === 0) return null

        const text = textParts.map((c) => c.text!).join("\n")
        return {
          type: "message",
          message: {
            role: "assistant",
            created: Math.floor(Date.now() / 1000),
            content: [{ type: "text", text }],
          },
        }
      }

      if (item.type === "function_call") {
        return {
          type: "message",
          message: {
            role: "assistant",
            created: Math.floor(Date.now() / 1000),
            content: [
              {
                type: "toolRequest",
                id: item.call_id ?? item.id ?? "",
                toolCall: {
                  name: item.name ?? "unknown",
                  arguments: parseArguments(item.arguments),
                },
              },
            ],
          },
        }
      }

      if (item.type === "function_call_output") {
        return {
          type: "message",
          message: {
            role: "user",
            created: Math.floor(Date.now() / 1000),
            content: [
              {
                type: "toolResponse",
                id: item.call_id ?? item.id ?? "",
                toolResult: item.output ?? null,
              },
            ],
          },
        }
      }

      return null
    }

    case "error": {
      const msg = raw.error?.message ?? "Unknown Codex error"
      return { type: "error", error: msg }
    }

    case "done": {
      const totalTokens = raw.usage
        ? (raw.usage.input_tokens ?? 0) + (raw.usage.output_tokens ?? 0)
        : null
      return { type: "complete", total_tokens: totalTokens }
    }

    default:
      return null
  }
}

export function translateCodexEvents(raw: CodexEvent): GooseStreamEvent[] {
  const single = translateCodexEvent(raw)
  return single ? [single] : []
}

export function codexUsageFromEvents(events: CodexEvent[]): number | null {
  let input = 0
  let output = 0
  let found = false

  for (const evt of events) {
    if (evt.type === "done" && evt.usage) {
      input += evt.usage.input_tokens ?? 0
      output += evt.usage.output_tokens ?? 0
      found = true
    }
    if (evt.type === "item.completed" && evt.item?.usage) {
      input += evt.item.usage.input_tokens ?? 0
      output += evt.item.usage.output_tokens ?? 0
      found = true
    }
  }

  return found ? input + output : null
}
