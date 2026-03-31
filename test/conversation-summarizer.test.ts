import { describe, it, expect, vi, beforeEach } from "vitest"
import type { TopicMessage } from "../src/types.js"

vi.mock("../src/claude-extract.js", () => ({
  retryClaudeExtraction: vi.fn(),
  buildConversationText: vi.fn((conversation: TopicMessage[]) =>
    conversation.map((m) => `${m.role}: ${m.text}`).join("\n"),
  ),
}))

import { retryClaudeExtraction } from "../src/claude-extract.js"
import {
  parseSummaryOutput,
  summarizeConversation,
  formatSummary,
} from "../src/conversation-summarizer.js"

const mockRetryClaudeExtraction = vi.mocked(retryClaudeExtraction)

describe("parseSummaryOutput", () => {
  it("parses multi-line output into summary lines", () => {
    const output = [
      "User - asked to add retry logic",
      "Agent - implemented exponential backoff",
      "User - approved the approach",
    ].join("\n")

    const summary = parseSummaryOutput(output)
    expect(summary.lines).toEqual([
      "User - asked to add retry logic",
      "Agent - implemented exponential backoff",
      "User - approved the approach",
    ])
  })

  it("filters out empty lines", () => {
    const output = "User - asked something\n\n\nAgent - did it\n"
    const summary = parseSummaryOutput(output)
    expect(summary.lines).toEqual([
      "User - asked something",
      "Agent - did it",
    ])
  })

  it("trims whitespace from lines", () => {
    const output = "  User - asked something  \n  Agent - did it  "
    const summary = parseSummaryOutput(output)
    expect(summary.lines).toEqual([
      "User - asked something",
      "Agent - did it",
    ])
  })

  it("caps at 15 lines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Agent - step ${i + 1}`)
    const summary = parseSummaryOutput(lines.join("\n"))
    expect(summary.lines).toHaveLength(15)
  })

  it("throws on empty output", () => {
    expect(() => parseSummaryOutput("")).toThrow("Empty summary output")
  })

  it("throws on whitespace-only output", () => {
    expect(() => parseSummaryOutput("   \n  \n  ")).toThrow("Empty summary output")
  })
})

describe("summarizeConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns null for empty conversation", async () => {
    const result = await summarizeConversation([])
    expect(result).toBeNull()
    expect(mockRetryClaudeExtraction).not.toHaveBeenCalled()
  })

  it("calls retryClaudeExtraction and returns summary on success", async () => {
    const summary = { lines: ["User - asked to fix bug", "Agent - fixed the bug"] }
    mockRetryClaudeExtraction.mockResolvedValue({ data: summary })

    const conversation: TopicMessage[] = [
      { role: "user", text: "fix the bug" },
      { role: "assistant", text: "I fixed the bug" },
    ]

    const result = await summarizeConversation(conversation)
    expect(result).toEqual(summary)
    expect(mockRetryClaudeExtraction).toHaveBeenCalledTimes(1)

    const [task, systemPrompt, parser, options] = mockRetryClaudeExtraction.mock.calls[0]
    expect(task).toContain("fix the bug")
    expect(systemPrompt).toContain("conversation summarizer")
    expect(typeof parser).toBe("function")
    expect(options.timeoutMs).toBe(60_000)
  })

  it("returns null when extraction fails", async () => {
    mockRetryClaudeExtraction.mockResolvedValue({
      error: "system",
      errorMessage: "CLI timed out",
    })

    const conversation: TopicMessage[] = [
      { role: "user", text: "do something" },
      { role: "assistant", text: "ok" },
    ]

    const result = await summarizeConversation(conversation)
    expect(result).toBeNull()
  })

  it("passes profile to extraction options", async () => {
    mockRetryClaudeExtraction.mockResolvedValue({ data: { lines: ["Agent - done"] } })

    const profile = {
      id: "custom",
      name: "Custom",
      baseUrl: "https://custom.api",
      authToken: "tok",
      haikuModel: "custom-haiku",
    }

    await summarizeConversation(
      [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }],
      profile,
    )

    const options = mockRetryClaudeExtraction.mock.calls[0][3]
    expect(options.profile).toBe(profile)
  })

  it("returns null when extraction returns no data", async () => {
    mockRetryClaudeExtraction.mockResolvedValue({})

    const result = await summarizeConversation([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ])
    expect(result).toBeNull()
  })
})

describe("formatSummary", () => {
  it("joins lines with newlines", () => {
    const summary = {
      lines: [
        "User - asked to add retry logic",
        "Agent - implemented backoff",
      ],
    }
    expect(formatSummary(summary)).toBe(
      "User - asked to add retry logic\nAgent - implemented backoff",
    )
  })

  it("handles single line", () => {
    expect(formatSummary({ lines: ["Agent - done"] })).toBe("Agent - done")
  })
})
