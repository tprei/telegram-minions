import { describe, it, expect } from "vitest"
import { translateCodexEvent, translateCodexEvents, codexUsageFromEvents } from "../src/codex-stream.js"

describe("translateCodexEvent", () => {
  it("translates an assistant message item.completed event", () => {
    const result = translateCodexEvent({
      type: "item.completed",
      item: {
        type: "message",
        role: "assistant",
        id: "msg_1",
        content: [{ type: "output_text", text: "Hello from Codex!" }],
      },
    })

    expect(result).not.toBeNull()
    expect(result!.type).toBe("message")
    if (result!.type === "message") {
      expect(result!.message.role).toBe("assistant")
      expect(result!.message.content).toHaveLength(1)
      expect(result!.message.content[0]).toEqual({ type: "text", text: "Hello from Codex!" })
    }
  })

  it("joins multiple output_text parts with newline", () => {
    const result = translateCodexEvent({
      type: "item.completed",
      item: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Part one" },
          { type: "output_text", text: "Part two" },
        ],
      },
    })

    expect(result).not.toBeNull()
    if (result!.type === "message") {
      expect(result!.message.content[0]).toEqual({
        type: "text",
        text: "Part one\nPart two",
      })
    }
  })

  it("returns null for assistant message with no output_text content", () => {
    expect(translateCodexEvent({
      type: "item.completed",
      item: {
        type: "message",
        role: "assistant",
        content: [],
      },
    })).toBeNull()
  })

  it("returns null for non-assistant message items", () => {
    expect(translateCodexEvent({
      type: "item.completed",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "output_text", text: "user text" }],
      },
    })).toBeNull()
  })

  it("returns null for message with empty text content", () => {
    expect(translateCodexEvent({
      type: "item.completed",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "" }],
      },
    })).toBeNull()
  })

  it("translates a function_call item.completed event", () => {
    const result = translateCodexEvent({
      type: "item.completed",
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_abc",
        name: "bash",
        arguments: '{"command":"ls -la"}',
      },
    })

    expect(result).not.toBeNull()
    expect(result!.type).toBe("message")
    if (result!.type === "message") {
      expect(result!.message.role).toBe("assistant")
      const block = result!.message.content[0]
      expect(block.type).toBe("toolRequest")
      if (block.type === "toolRequest") {
        expect(block.id).toBe("call_abc")
        expect(block.toolCall).toEqual({
          name: "bash",
          arguments: { command: "ls -la" },
        })
      }
    }
  })

  it("uses item.id as fallback when call_id is missing", () => {
    const result = translateCodexEvent({
      type: "item.completed",
      item: {
        type: "function_call",
        id: "fc_2",
        name: "bash",
        arguments: "{}",
      },
    })

    if (result!.type === "message") {
      const block = result!.message.content[0]
      if (block.type === "toolRequest") {
        expect(block.id).toBe("fc_2")
      }
    }
  })

  it("handles malformed JSON arguments gracefully", () => {
    const result = translateCodexEvent({
      type: "item.completed",
      item: {
        type: "function_call",
        call_id: "call_3",
        name: "bash",
        arguments: "not valid json",
      },
    })

    if (result!.type === "message") {
      const block = result!.message.content[0]
      if (block.type === "toolRequest") {
        expect(block.toolCall.arguments).toEqual({ raw: "not valid json" })
      }
    }
  })

  it("handles missing arguments", () => {
    const result = translateCodexEvent({
      type: "item.completed",
      item: {
        type: "function_call",
        call_id: "call_4",
        name: "bash",
      },
    })

    if (result!.type === "message") {
      const block = result!.message.content[0]
      if (block.type === "toolRequest") {
        expect(block.toolCall.arguments).toEqual({})
      }
    }
  })

  it("translates a function_call_output item.completed event", () => {
    const result = translateCodexEvent({
      type: "item.completed",
      item: {
        type: "function_call_output",
        id: "fco_1",
        call_id: "call_abc",
        output: "file1.txt\nfile2.txt",
      },
    })

    expect(result).not.toBeNull()
    expect(result!.type).toBe("message")
    if (result!.type === "message") {
      expect(result!.message.role).toBe("user")
      const block = result!.message.content[0]
      expect(block.type).toBe("toolResponse")
      if (block.type === "toolResponse") {
        expect(block.id).toBe("call_abc")
        expect(block.toolResult).toBe("file1.txt\nfile2.txt")
      }
    }
  })

  it("translates function_call_output with missing output as null", () => {
    const result = translateCodexEvent({
      type: "item.completed",
      item: {
        type: "function_call_output",
        call_id: "call_5",
      },
    })

    if (result!.type === "message") {
      const block = result!.message.content[0]
      if (block.type === "toolResponse") {
        expect(block.toolResult).toBeNull()
      }
    }
  })

  it("translates an error event", () => {
    const result = translateCodexEvent({
      type: "error",
      error: { message: "Rate limit exceeded", type: "rate_limit_error" },
    })

    expect(result).toEqual({ type: "error", error: "Rate limit exceeded" })
  })

  it("translates an error event with no message", () => {
    const result = translateCodexEvent({
      type: "error",
      error: { type: "server_error" },
    })

    expect(result).toEqual({ type: "error", error: "Unknown Codex error" })
  })

  it("translates an error event with no error object", () => {
    const result = translateCodexEvent({ type: "error" })

    expect(result).toEqual({ type: "error", error: "Unknown Codex error" })
  })

  it("translates a done event with usage", () => {
    const result = translateCodexEvent({
      type: "done",
      usage: { input_tokens: 200, output_tokens: 100 },
    })

    expect(result).toEqual({ type: "complete", total_tokens: 300 })
  })

  it("translates a done event with no usage", () => {
    const result = translateCodexEvent({ type: "done" })

    expect(result).toEqual({ type: "complete", total_tokens: null })
  })

  it("returns null for item.started events", () => {
    expect(translateCodexEvent({
      type: "item.started",
      item: { type: "message", role: "assistant" },
    })).toBeNull()
  })

  it("returns null for item.completed with no item", () => {
    expect(translateCodexEvent({ type: "item.completed" })).toBeNull()
  })

  it("returns null for unknown item types", () => {
    expect(translateCodexEvent({
      type: "item.completed",
      item: { type: "custom_type" },
    })).toBeNull()
  })

  it("returns null for unknown event types", () => {
    expect(translateCodexEvent({ type: "session.created" })).toBeNull()
  })
})

describe("translateCodexEvents", () => {
  it("wraps a single translated event into an array", () => {
    const events = translateCodexEvents({
      type: "error",
      error: { message: "fail" },
    })

    expect(events).toEqual([{ type: "error", error: "fail" }])
  })

  it("returns empty array for null-producing events", () => {
    expect(translateCodexEvents({ type: "item.started" })).toEqual([])
  })

  it("returns empty array for unknown event types", () => {
    expect(translateCodexEvents({ type: "pong" })).toEqual([])
  })

  it("translates a done event through the array path", () => {
    const events = translateCodexEvents({
      type: "done",
      usage: { input_tokens: 50, output_tokens: 25 },
    })

    expect(events).toEqual([{ type: "complete", total_tokens: 75 }])
  })
})

describe("codexUsageFromEvents", () => {
  it("sums usage from done event", () => {
    const usage = codexUsageFromEvents([
      { type: "item.started", item: { type: "message", role: "assistant" } },
      { type: "done", usage: { input_tokens: 100, output_tokens: 50 } },
    ])

    expect(usage).toBe(150)
  })

  it("sums usage from item.completed events", () => {
    const usage = codexUsageFromEvents([
      {
        type: "item.completed",
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi" }],
          usage: { input_tokens: 50, output_tokens: 25 },
        },
      },
      {
        type: "item.completed",
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "there" }],
          usage: { input_tokens: 30, output_tokens: 15 },
        },
      },
    ])

    expect(usage).toBe(120)
  })

  it("returns null when no usage info present", () => {
    expect(codexUsageFromEvents([
      { type: "item.started", item: { type: "message" } },
    ])).toBeNull()
  })

  it("returns null for empty array", () => {
    expect(codexUsageFromEvents([])).toBeNull()
  })

  it("handles partial usage fields gracefully", () => {
    const usage = codexUsageFromEvents([
      { type: "done", usage: { output_tokens: 10 } },
    ])

    expect(usage).toBe(10)
  })
})
