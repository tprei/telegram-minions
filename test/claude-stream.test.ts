import { describe, it, expect } from "vitest"
import { translateClaudeEvent, translateClaudeEvents } from "../src/session/claude-stream.js"

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

  it("returns null for assistant messages with no thinking, tool_use, or stop_reason", () => {
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

  it("bundles all tool_use blocks in a multi-tool turn into one message", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", id: "t3", name: "Grep", input: { pattern: "foo" } },
        ],
        stop_reason: "tool_use",
      },
    })

    expect(result).not.toBeNull()
    if (result!.type === "message") {
      expect(result!.message.content).toHaveLength(3)
      const ids = result!.message.content
        .filter((b) => b.type === "toolRequest")
        .map((b) => (b as { id: string }).id)
      expect(ids).toEqual(["t1", "t2", "t3"])
      expect(result!.message.stopReason).toBe("tool_use")
    }
  })

  it("emits thinking blocks in the assistant message", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm let me think", signature: "sig-1" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
    })

    expect(result).not.toBeNull()
    if (result!.type === "message") {
      expect(result!.message.content).toHaveLength(2)
      const thinking = result!.message.content[0]
      expect(thinking.type).toBe("thinking")
      if (thinking.type === "thinking") {
        expect(thinking.thinking).toBe("hmm let me think")
        expect(thinking.signature).toBe("sig-1")
      }
    }
  })

  it("carries parent_tool_use_id into toolRequest blocks", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      parent_tool_use_id: "parent-abc",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
    })

    expect(result).not.toBeNull()
    if (result!.type === "message") {
      const block = result!.message.content[0]
      if (block.type === "toolRequest") {
        expect(block.parentToolUseId).toBe("parent-abc")
      }
    }
  })

  it("defaults parentToolUseId to null when not provided on the event", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
    })

    if (result && result.type === "message") {
      const block = result.message.content[0]
      if (block.type === "toolRequest") {
        expect(block.parentToolUseId).toBeNull()
      }
    }
  })

  it("surfaces stop_reason on the assistant message", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
        stop_reason: "end_turn",
      },
    })

    if (result && result.type === "message") {
      expect(result.message.stopReason).toBe("end_turn")
    }
  })

  it("emits a stop_reason-only assistant message even without content", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "max_tokens",
      },
    })

    expect(result).not.toBeNull()
    if (result && result.type === "message") {
      expect(result.message.content).toEqual([])
      expect(result.message.stopReason).toBe("max_tokens")
    }
  })

  it("translates a successful result event", () => {
    const result = translateClaudeEvent({
      type: "result",
      result: "done",
      is_error: false,
      usage: { input_tokens: 100, output_tokens: 50 },
    })

    expect(result).toEqual({ type: "complete", total_tokens: 150, total_cost_usd: null, num_turns: null })
  })

  it("translates a result with no usage to null total_tokens", () => {
    const result = translateClaudeEvent({
      type: "result",
      result: "done",
      is_error: false,
    })
    expect(result).toEqual({ type: "complete", total_tokens: null, total_cost_usd: null, num_turns: null })
  })

  it("parses total_cost_usd and num_turns from result event", () => {
    const result = translateClaudeEvent({
      type: "result",
      result: "done",
      is_error: false,
      total_cost_usd: 5.57,
      num_turns: 82,
    })
    expect(result).toEqual({ type: "complete", total_tokens: null, total_cost_usd: 5.57, num_turns: 82 })
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
    expect(events).toEqual([{ type: "complete", total_tokens: 30, total_cost_usd: null, num_turns: null }])
  })

  it("returns empty array for null-producing events", () => {
    const events = translateClaudeEvents({ type: "ping" })
    expect(events).toEqual([])
  })

  it("emits thinking blocks as separate events before tool calls", () => {
    const events = translateClaudeEvents({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning...", signature: "sig" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
    })

    expect(events).toHaveLength(2)
    const first = events[0]
    if (first.type === "message") {
      expect(first.message.content[0]).toEqual({
        type: "thinking",
        thinking: "reasoning...",
        signature: "sig",
      })
    }
    const second = events[1]
    if (second.type === "message") {
      expect(second.message.content[0].type).toBe("toolRequest")
    }
  })

  it("carries parent_tool_use_id into every toolRequest event", () => {
    const events = translateClaudeEvents({
      type: "assistant",
      parent_tool_use_id: "parent-xyz",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
        ],
      },
    })

    expect(events).toHaveLength(2)
    for (const event of events) {
      if (event.type === "message") {
        const block = event.message.content[0]
        if (block.type === "toolRequest") {
          expect(block.parentToolUseId).toBe("parent-xyz")
        }
      }
    }
  })

  it("carries parent_tool_use_id into tool_result (user) events", () => {
    const events = translateClaudeEvents({
      type: "user",
      parent_tool_use_id: "parent-xyz",
      message: {
        role: "user",
        content: [
          { type: "tool_result", id: "t1", content: "output" },
        ],
      },
    })

    expect(events).toHaveLength(1)
    const event = events[0]
    if (event.type === "message") {
      const block = event.message.content[0]
      if (block.type === "toolResponse") {
        expect(block.parentToolUseId).toBe("parent-xyz")
        expect(block.id).toBe("t1")
      }
    }
  })

  it("defaults parentToolUseId to null on toolResponse when not provided", () => {
    const events = translateClaudeEvents({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", id: "t1", content: "output" }],
      },
    })

    const event = events[0]
    if (event.type === "message") {
      const block = event.message.content[0]
      if (block.type === "toolResponse") {
        expect(block.parentToolUseId).toBeNull()
      }
    }
  })

  it("surfaces stop_reason on the last tool event of a multi-tool turn", () => {
    const events = translateClaudeEvents({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
        ],
        stop_reason: "tool_use",
      },
    })

    expect(events).toHaveLength(2)
    if (events[0].type === "message") {
      expect(events[0].message.stopReason ?? null).toBeNull()
    }
    if (events[1].type === "message") {
      expect(events[1].message.stopReason).toBe("tool_use")
    }
  })

  it("emits a stop_reason-only event for text-only assistant turns", () => {
    const events = translateClaudeEvents({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
      },
    })

    expect(events).toHaveLength(1)
    const event = events[0]
    if (event.type === "message") {
      expect(event.message.stopReason).toBe("end_turn")
      expect(event.message.content).toEqual([])
    }
  })

  it("returns empty array when a user message has no tool_result blocks", () => {
    const events = translateClaudeEvents({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    })
    expect(events).toEqual([])
  })

  it("emits one toolResponse event per tool_result block", () => {
    const events = translateClaudeEvents({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", id: "t1", content: "first" },
          { type: "tool_result", id: "t2", content: "second" },
        ],
      },
    })

    expect(events).toHaveLength(2)
    const ids = events
      .flatMap((e) => (e.type === "message" ? e.message.content : []))
      .filter((b) => b.type === "toolResponse")
      .map((b) => (b as { id: string }).id)
    expect(ids).toEqual(["t1", "t2"])
  })
})
