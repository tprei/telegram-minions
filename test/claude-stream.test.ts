import { describe, it, expect } from "vitest"
import { translateClaudeEvent, translateClaudeEvents } from "../src/claude-stream.js"

describe("translateClaudeEvent", () => {
  it("translates a text delta stream event", () => {
    const result = translateClaudeEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hello" },
      },
    })

    expect(result).not.toBeNull()
    expect(result!.type).toBe("message")
    if (result!.type === "message") {
      expect(result!.message.role).toBe("assistant")
      expect(result!.message.content).toHaveLength(1)
      expect(result!.message.content[0]).toEqual({ type: "text", text: "hello" })
    }
  })

  it("returns null for stream events without text delta", () => {
    expect(translateClaudeEvent({
      type: "stream_event",
      event: { type: "content_block_start" },
    })).toBeNull()
  })

  it("returns null for stream events without event", () => {
    expect(translateClaudeEvent({ type: "stream_event" })).toBeNull()
  })

  it("translates an assistant message with tool_use blocks", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } },
        ],
      },
    })

    expect(result).not.toBeNull()
    expect(result!.type).toBe("message")
    if (result!.type === "message") {
      const block = result!.message.content[0]
      expect(block.type).toBe("toolRequest")
      if (block.type === "toolRequest") {
        expect(block.toolCall).toEqual({ name: "Bash", arguments: { command: "ls" } })
      }
    }
  })

  it("returns null for assistant messages with no tool_use blocks", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    })
    expect(result).toBeNull()
  })

  it("returns null for non-assistant messages", () => {
    expect(translateClaudeEvent({
      type: "assistant",
      message: { role: "user", content: [] },
    })).toBeNull()
  })

  it("translates a successful result event", () => {
    const result = translateClaudeEvent({
      type: "result",
      result: "done",
      is_error: false,
      usage: { input_tokens: 100, output_tokens: 50 },
    })

    expect(result).toEqual({ type: "complete", total_tokens: 150 })
  })

  it("translates a result with no usage to null total_tokens", () => {
    const result = translateClaudeEvent({
      type: "result",
      result: "done",
      is_error: false,
    })
    expect(result).toEqual({ type: "complete", total_tokens: null })
  })

  it("translates an error result", () => {
    const result = translateClaudeEvent({
      type: "result",
      result: "something went wrong",
      is_error: true,
    })
    expect(result).toEqual({ type: "error", error: "something went wrong" })
  })

  it("translates an error result with no result text", () => {
    const result = translateClaudeEvent({
      type: "result",
      is_error: true,
    })
    expect(result).toEqual({ type: "error", error: "Unknown error" })
  })

  it("returns null for unknown event types", () => {
    expect(translateClaudeEvent({ type: "ping" })).toBeNull()
  })
})

describe("translateClaudeEvents", () => {
  it("translates multiple tool_use blocks from an assistant message", () => {
    const events = translateClaudeEvents({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } },
        ],
      },
    })

    expect(events).toHaveLength(2)
    expect(events[0].type).toBe("message")
    expect(events[1].type).toBe("message")
  })

  it("returns empty array for non-assistant messages", () => {
    expect(translateClaudeEvents({
      type: "assistant",
      message: { role: "user", content: [] },
    })).toEqual([])
  })

  it("wraps single event from translateClaudeEvent into array", () => {
    const events = translateClaudeEvents({
      type: "result",
      is_error: false,
      usage: { input_tokens: 10, output_tokens: 20 },
    })
    expect(events).toEqual([{ type: "complete", total_tokens: 30 }])
  })

  it("returns empty array for null-producing events", () => {
    const events = translateClaudeEvents({ type: "ping" })
    expect(events).toEqual([])
  })
})
