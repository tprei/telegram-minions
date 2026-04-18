import { describe, it, expect } from "vitest"
import {
  isTextContent,
  isToolRequestContent,
  isToolResponseContent,
  type GooseContentType,
  type GooseTextContent,
  type GooseToolRequestContent,
  type GooseToolResponseContent,
} from "../src/domain/goose-types.js"

describe("isTextContent", () => {
  it("returns true for text content blocks", () => {
    const block: GooseTextContent = { type: "text", text: "hello" }
    expect(isTextContent(block)).toBe(true)
  })

  it("returns false for toolRequest blocks", () => {
    const block: GooseToolRequestContent = {
      type: "toolRequest",
      id: "req-1",
      toolCall: { name: "Read", arguments: { path: "/tmp" } },
    }
    expect(isTextContent(block)).toBe(false)
  })

  it("returns false for toolResponse blocks", () => {
    const block: GooseToolResponseContent = {
      type: "toolResponse",
      id: "resp-1",
      toolResult: "file contents",
    }
    expect(isTextContent(block)).toBe(false)
  })

  it("returns false for thinking blocks", () => {
    const block: GooseContentType = { type: "thinking", thinking: "hmm", signature: "sig" }
    expect(isTextContent(block)).toBe(false)
  })

  it("returns false for unknown content types", () => {
    const block: GooseContentType = { type: "custom", data: 123 }
    expect(isTextContent(block)).toBe(false)
  })
})

describe("isToolRequestContent", () => {
  it("returns true for toolRequest blocks with arguments", () => {
    const block: GooseToolRequestContent = {
      type: "toolRequest",
      id: "req-1",
      toolCall: { name: "Edit", arguments: { file: "test.ts" } },
    }
    expect(isToolRequestContent(block)).toBe(true)
  })

  it("returns true for toolRequest blocks with error", () => {
    const block: GooseToolRequestContent = {
      type: "toolRequest",
      id: "req-2",
      toolCall: { error: "tool not found" },
    }
    expect(isToolRequestContent(block)).toBe(true)
  })

  it("returns false for text blocks", () => {
    const block: GooseTextContent = { type: "text", text: "hello" }
    expect(isToolRequestContent(block)).toBe(false)
  })

  it("returns false for toolResponse blocks", () => {
    const block: GooseToolResponseContent = {
      type: "toolResponse",
      id: "resp-1",
      toolResult: null,
    }
    expect(isToolRequestContent(block)).toBe(false)
  })

  it("returns false for notification blocks", () => {
    const block: GooseContentType = {
      type: "notification",
      extensionId: "ext-1",
      message: "progress",
    }
    expect(isToolRequestContent(block)).toBe(false)
  })
})

describe("isToolResponseContent", () => {
  it("returns true for toolResponse blocks", () => {
    const block: GooseToolResponseContent = {
      type: "toolResponse",
      id: "resp-1",
      toolResult: { status: "ok", data: [1, 2, 3] },
    }
    expect(isToolResponseContent(block)).toBe(true)
  })

  it("returns true for toolResponse blocks with null result", () => {
    const block: GooseToolResponseContent = {
      type: "toolResponse",
      id: "resp-2",
      toolResult: null,
    }
    expect(isToolResponseContent(block)).toBe(true)
  })

  it("returns false for text blocks", () => {
    const block: GooseTextContent = { type: "text", text: "output" }
    expect(isToolResponseContent(block)).toBe(false)
  })

  it("returns false for toolRequest blocks", () => {
    const block: GooseToolRequestContent = {
      type: "toolRequest",
      id: "req-1",
      toolCall: { name: "Bash", arguments: { command: "ls" } },
    }
    expect(isToolResponseContent(block)).toBe(false)
  })

  it("returns false for systemNotification blocks", () => {
    const block: GooseContentType = {
      type: "systemNotification",
      notificationType: "creditsExhausted",
      msg: "out of credits",
    }
    expect(isToolResponseContent(block)).toBe(false)
  })
})

describe("type narrowing", () => {
  it("narrows GooseContentType to GooseTextContent", () => {
    const blocks: GooseContentType[] = [
      { type: "text", text: "hello" },
      { type: "toolRequest", id: "r1", toolCall: { name: "Read", arguments: {} } },
      { type: "text", text: "world" },
      { type: "toolResponse", id: "r1", toolResult: "data" },
    ]

    const textBlocks = blocks.filter(isTextContent)
    expect(textBlocks).toHaveLength(2)
    expect(textBlocks[0].text).toBe("hello")
    expect(textBlocks[1].text).toBe("world")
  })

  it("narrows to tool request content", () => {
    const blocks: GooseContentType[] = [
      { type: "text", text: "analyzing" },
      { type: "toolRequest", id: "r1", toolCall: { name: "Read", arguments: { path: "/tmp" } } },
      { type: "toolResponse", id: "r1", toolResult: "contents" },
    ]

    const requests = blocks.filter(isToolRequestContent)
    expect(requests).toHaveLength(1)
    expect(requests[0].id).toBe("r1")
  })

  it("narrows to tool response content", () => {
    const blocks: GooseContentType[] = [
      { type: "toolRequest", id: "r1", toolCall: { name: "Bash", arguments: { command: "echo hi" } } },
      { type: "toolResponse", id: "r1", toolResult: "hi\n" },
      { type: "toolResponse", id: "r2", toolResult: null },
    ]

    const responses = blocks.filter(isToolResponseContent)
    expect(responses).toHaveLength(2)
    expect(responses[0].id).toBe("r1")
    expect(responses[1].toolResult).toBeNull()
  })
})
