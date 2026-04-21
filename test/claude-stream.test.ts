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

  it("drops tool_use blocks that are missing a name", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-1", input: { command: "ls" } },
        ],
      },
    })
    expect(result).toBeNull()
  })

  it("drops tool_use blocks with an empty-string name", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-1", name: "", input: { command: "ls" } },
        ],
      },
    })
    expect(result).toBeNull()
  })

  it("keeps named tool_use blocks and drops unnamed ones alongside them", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-1", input: { command: "ls" } },
          { type: "tool_use", id: "tool-2", name: "Bash", input: { command: "pwd" } },
        ],
      },
    })

    expect(result).not.toBeNull()
    if (result!.type === "message") {
      expect(result!.message.content).toHaveLength(1)
      const block = result!.message.content[0]
      expect(block.type).toBe("toolRequest")
      if (block.type === "toolRequest" && !("error" in block.toolCall)) {
        expect(block.toolCall.name).toBe("Bash")
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

  it("drops unnamed tool_use blocks while keeping named ones", () => {
    const events = translateClaudeEvents({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", input: { command: "ls" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "pwd" } },
          { type: "tool_use", id: "t3", name: "", input: { command: "noop" } },
        ],
      },
    })

    expect(events).toHaveLength(1)
    if (events[0].type === "message") {
      const block = events[0].message.content[0]
      if (block.type === "toolRequest" && !("error" in block.toolCall)) {
        expect(block.toolCall.name).toBe("Bash")
      }
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

  it("reads tool_use_id from Anthropic-shape tool_result blocks", () => {
    const events = translateClaudeEvents({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_abc", content: "paired output" },
        ],
      },
    })

    expect(events).toHaveLength(1)
    const ids = events
      .flatMap((e) => (e.type === "message" ? e.message.content : []))
      .filter((b) => b.type === "toolResponse")
      .map((b) => (b as { id: string }).id)
    expect(ids).toEqual(["toolu_abc"])
  })
})

describe("translateClaudeEvent — thinking coverage", () => {
  it("emits multiple thinking blocks in original order", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "first thought", signature: "sig-a" },
          { type: "thinking", thinking: "second thought", signature: "sig-b" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
    })

    expect(result).not.toBeNull()
    if (result && result.type === "message") {
      expect(result.message.content).toHaveLength(3)
      expect(result.message.content[0]).toEqual({
        type: "thinking",
        thinking: "first thought",
        signature: "sig-a",
      })
      expect(result.message.content[1]).toEqual({
        type: "thinking",
        thinking: "second thought",
        signature: "sig-b",
      })
      expect(result.message.content[2].type).toBe("toolRequest")
    }
  })

  it("returns a thinking-only message when the turn has no tool_use", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "just thinking", signature: "s" },
        ],
      },
    })

    expect(result).not.toBeNull()
    if (result && result.type === "message") {
      expect(result.message.content).toHaveLength(1)
      expect(result.message.content[0].type).toBe("thinking")
      expect(result.message.stopReason ?? null).toBeNull()
    }
  })

  it("defaults missing thinking/signature fields to empty strings", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking" }],
      },
    })

    if (result && result.type === "message") {
      const block = result.message.content[0]
      expect(block.type).toBe("thinking")
      if (block.type === "thinking") {
        expect(block.thinking).toBe("")
        expect(block.signature).toBe("")
      }
    }
  })

  it("ignores text blocks when bundling thinking and tool_use", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "some prose" },
          { type: "thinking", thinking: "hmm", signature: "s" },
          { type: "tool_use", id: "t1", name: "Bash", input: {} },
        ],
      },
    })

    if (result && result.type === "message") {
      expect(result.message.content).toHaveLength(2)
      expect(result.message.content[0].type).toBe("thinking")
      expect(result.message.content[1].type).toBe("toolRequest")
    }
  })
})

describe("translateClaudeEvent — multi-tool coverage", () => {
  it("applies parent_tool_use_id to every tool in a bundled multi-tool turn", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      parent_tool_use_id: "parent-99",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", id: "t3", name: "Grep", input: { pattern: "x" } },
        ],
      },
    })

    if (result && result.type === "message") {
      const parents = result.message.content
        .filter((b) => b.type === "toolRequest")
        .map((b) => (b as { parentToolUseId: string | null }).parentToolUseId)
      expect(parents).toEqual(["parent-99", "parent-99", "parent-99"])
    }
  })

  it("preserves distinct tool name and arguments for each block", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
          { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/a.ts", old: "x", new: "y" } },
        ],
      },
    })

    if (result && result.type === "message") {
      const calls = result.message.content
        .filter((b) => b.type === "toolRequest")
        .map((b) => (b as { toolCall: { name: string; arguments: Record<string, unknown> } }).toolCall)
      expect(calls[0]).toEqual({ name: "Read", arguments: { file_path: "/a.ts" } })
      expect(calls[1]).toEqual({ name: "Edit", arguments: { file_path: "/a.ts", old: "x", new: "y" } })
    }
  })

  it("defaults missing tool_use fields (id, name, input) to safe values", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use" }],
      },
    })

    if (result && result.type === "message") {
      const block = result.message.content[0]
      if (block.type === "toolRequest") {
        expect(block.id).toBe("")
        if ("name" in block.toolCall) {
          expect(block.toolCall.name).toBe("unknown")
          expect(block.toolCall.arguments).toEqual({})
        }
      }
    }
  })

  it("normalizes explicit null parent_tool_use_id to null on toolRequests", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      },
    })

    if (result && result.type === "message") {
      const block = result.message.content[0]
      if (block.type === "toolRequest") {
        expect(block.parentToolUseId).toBeNull()
      }
    }
  })
})

describe("translateClaudeEvents — thinking + multi-tool coverage", () => {
  it("emits each thinking block as its own event in order", () => {
    const events = translateClaudeEvents({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "A", signature: "s-a" },
          { type: "thinking", thinking: "B", signature: "s-b" },
        ],
      },
    })

    expect(events).toHaveLength(2)
    const thoughts = events
      .flatMap((e) => (e.type === "message" ? e.message.content : []))
      .filter((b) => b.type === "thinking")
      .map((b) => (b as { thinking: string }).thinking)
    expect(thoughts).toEqual(["A", "B"])
  })

  it("orders thinking events before tool events and only stamps stop_reason on the last tool", () => {
    const events = translateClaudeEvents({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan", signature: "s" },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", id: "t3", name: "Grep", input: { pattern: "x" } },
        ],
        stop_reason: "tool_use",
      },
    })

    expect(events).toHaveLength(4)
    if (events[0].type === "message") {
      expect(events[0].message.content[0].type).toBe("thinking")
      expect(events[0].message.stopReason ?? null).toBeNull()
    }
    const toolStops = events.slice(1).map((e) => (e.type === "message" ? e.message.stopReason ?? null : null))
    expect(toolStops).toEqual([null, null, "tool_use"])
  })

  it("applies parent_tool_use_id to every split tool event in a multi-tool turn", () => {
    const events = translateClaudeEvents({
      type: "assistant",
      parent_tool_use_id: "parent-abc",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "tool_use", id: "t2", name: "Bash", input: {} },
          { type: "tool_use", id: "t3", name: "Grep", input: {} },
        ],
      },
    })

    const parents = events
      .flatMap((e) => (e.type === "message" ? e.message.content : []))
      .filter((b) => b.type === "toolRequest")
      .map((b) => (b as { parentToolUseId: string | null }).parentToolUseId)
    expect(parents).toEqual(["parent-abc", "parent-abc", "parent-abc"])
  })

  it("returns thinking-only events (no stop_reason-only fallback) when thinking present without tools", () => {
    const events = translateClaudeEvents({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "solo", signature: "s" }],
        stop_reason: "end_turn",
      },
    })

    expect(events).toHaveLength(1)
    if (events[0].type === "message") {
      expect(events[0].message.content[0].type).toBe("thinking")
    }
  })

  it("ignores text blocks in assistant messages even when tools are present", () => {
    const events = translateClaudeEvents({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "prose" },
          { type: "tool_use", id: "t1", name: "Bash", input: {} },
        ],
      },
    })

    expect(events).toHaveLength(1)
    if (events[0].type === "message") {
      expect(events[0].message.content).toHaveLength(1)
      expect(events[0].message.content[0].type).toBe("toolRequest")
    }
  })

  it("applies parent_tool_use_id to every tool_result in a multi-result user event", () => {
    const events = translateClaudeEvents({
      type: "user",
      parent_tool_use_id: "parent-user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", id: "t1", content: "one" },
          { type: "tool_result", id: "t2", content: "two" },
          { type: "tool_result", id: "t3", content: "three" },
        ],
      },
    })

    expect(events).toHaveLength(3)
    const parents = events
      .flatMap((e) => (e.type === "message" ? e.message.content : []))
      .filter((b) => b.type === "toolResponse")
      .map((b) => (b as { parentToolUseId: string | null }).parentToolUseId)
    expect(parents).toEqual(["parent-user", "parent-user", "parent-user"])
  })

  it("filters mixed user content down to tool_result blocks only", () => {
    const events = translateClaudeEvents({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "here's the result" },
          { type: "tool_result", id: "t1", content: "payload" },
        ],
      },
    })

    expect(events).toHaveLength(1)
    if (events[0].type === "message") {
      expect(events[0].message.content).toHaveLength(1)
      expect(events[0].message.content[0].type).toBe("toolResponse")
    }
  })
})

describe("translateClaudeEvents — NDJSON integration", () => {
  it("produces a full conversational turn sequence from a realistic claude stream", () => {
    const ndjson: unknown[] = [
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "planning the work", signature: "sig-1" },
            { type: "tool_use", id: "call-1", name: "Read", input: { file_path: "/a.ts" } },
            { type: "tool_use", id: "call-2", name: "Grep", input: { pattern: "foo" } },
          ],
          stop_reason: "tool_use",
        },
      },
      {
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            { type: "tool_result", id: "call-1", content: "file contents" },
            { type: "tool_result", id: "call-2", content: "grep results" },
          ],
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "all done" }],
          stop_reason: "end_turn",
        },
      },
      {
        type: "result",
        is_error: false,
        total_cost_usd: 0.0042,
        num_turns: 3,
        usage: { input_tokens: 1200, output_tokens: 340 },
      },
    ]

    const all = ndjson.flatMap((raw) => translateClaudeEvents(raw as Parameters<typeof translateClaudeEvents>[0]))

    // 1 thinking + 2 tool_use (split) + 2 tool_result + 1 stop-reason-only + 1 complete = 7
    expect(all).toHaveLength(7)

    const blockTypes = all.map((e) => {
      if (e.type === "message") return e.message.content[0]?.type ?? "empty"
      return e.type
    })
    expect(blockTypes).toEqual([
      "thinking",
      "toolRequest",
      "toolRequest",
      "toolResponse",
      "toolResponse",
      "empty",
      "complete",
    ])

    const lastTool = all[2]
    if (lastTool.type === "message") {
      expect(lastTool.message.stopReason).toBe("tool_use")
    }

    const stopOnly = all[5]
    if (stopOnly.type === "message") {
      expect(stopOnly.message.stopReason).toBe("end_turn")
      expect(stopOnly.message.content).toEqual([])
    }

    const done = all[6]
    expect(done).toEqual({
      type: "complete",
      total_tokens: 1540,
      total_cost_usd: 0.0042,
      num_turns: 3,
    })
  })

  it("passes parent_tool_use_id through nested sub-agent tool calls", () => {
    const parentId = "parent-agent-1"
    const ndjson: unknown[] = [
      {
        type: "assistant",
        parent_tool_use_id: parentId,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "child-1", name: "Bash", input: { command: "ls" } }],
        },
      },
      {
        type: "user",
        parent_tool_use_id: parentId,
        message: {
          role: "user",
          content: [{ type: "tool_result", id: "child-1", content: "dir listing" }],
        },
      },
    ]

    const events = ndjson.flatMap((raw) => translateClaudeEvents(raw as Parameters<typeof translateClaudeEvents>[0]))
    const parents = events
      .flatMap((e) => (e.type === "message" ? e.message.content : []))
      .filter((b) => b.type === "toolRequest" || b.type === "toolResponse")
      .map((b) => (b as { parentToolUseId: string | null }).parentToolUseId)
    expect(parents).toEqual([parentId, parentId])
  })
})
