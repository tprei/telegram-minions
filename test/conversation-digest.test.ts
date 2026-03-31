import { describe, it, expect, vi, beforeEach } from "vitest"
import { buildConversationDigest, buildChildSessionDigest } from "../src/conversation-digest.js"
import type { TopicMessage } from "../src/types.js"

vi.mock("../src/conversation-summarizer.js", () => ({
  summarizeConversation: vi.fn(),
  formatSummary: vi.fn((summary: { lines: string[] }) => summary.lines.join("\n")),
}))

import { summarizeConversation } from "../src/conversation-summarizer.js"

const mockSummarizeConversation = vi.mocked(summarizeConversation)

describe("buildConversationDigest", () => {
  it("returns null for empty conversation", () => {
    expect(buildConversationDigest([])).toBeNull()
  })

  it("returns null when there are no assistant messages", () => {
    const conversation: TopicMessage[] = [
      { role: "user", text: "fix the bug" },
    ]
    expect(buildConversationDigest(conversation)).toBeNull()
  })

  it("builds a digest with task and conversation", () => {
    const conversation: TopicMessage[] = [
      { role: "user", text: "add retry logic to webhook handler" },
      { role: "assistant", text: "I'll explore the webhook code and add retry logic." },
      { role: "user", text: "looks good, but use exponential backoff" },
      { role: "assistant", text: "Updated to use exponential backoff with jitter." },
    ]

    const digest = buildConversationDigest(conversation)!
    expect(digest).toContain("<details>")
    expect(digest).toContain("</details>")
    expect(digest).toContain("**Task:** add retry logic to webhook handler")
    expect(digest).toContain("**Agent**: I'll explore the webhook code")
    expect(digest).toContain("**User**: looks good")
    expect(digest).toContain("**Agent**: Updated to use exponential backoff")
  })

  it("strips code blocks from messages", () => {
    const conversation: TopicMessage[] = [
      { role: "user", text: "fix it" },
      { role: "assistant", text: "Here's the fix:\n```ts\nconsole.log('hi')\n```\nDone." },
    ]

    const digest = buildConversationDigest(conversation)!
    expect(digest).not.toContain("console.log")
    expect(digest).toContain("[code block]")
  })

  it("truncates long messages", () => {
    const longText = "a".repeat(1000)
    const conversation: TopicMessage[] = [
      { role: "user", text: longText },
      { role: "assistant", text: "done" },
    ]

    const digest = buildConversationDigest(conversation)!
    expect(digest).toContain("...")
    expect(digest.length).toBeLessThan(4000)
  })

  it("respects the total character budget", () => {
    const messages: TopicMessage[] = [
      { role: "user", text: "task" },
    ]
    for (let i = 0; i < 50; i++) {
      messages.push({ role: "assistant", text: "x".repeat(200) })
    }

    const digest = buildConversationDigest(messages)!
    expect(digest.length).toBeLessThan(4000)
  })
})

describe("buildChildSessionDigest", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns null for empty child conversation", async () => {
    const result = await buildChildSessionDigest({ childConversation: [] })
    expect(result).toBeNull()
    expect(mockSummarizeConversation).not.toHaveBeenCalled()
  })

  it("builds digest with both parent and child summaries", async () => {
    const parentSummary = { lines: ["User - requested auth refactor", "Agent - proposed plan with 3 steps"] }
    const childSummary = { lines: ["Agent - implemented JWT validation", "Agent - opened PR #55"] }

    mockSummarizeConversation
      .mockResolvedValueOnce(parentSummary)
      .mockResolvedValueOnce(childSummary)

    const parentConversation: TopicMessage[] = [
      { role: "user", text: "refactor auth to use JWT" },
      { role: "assistant", text: "I'll plan the JWT migration in 3 steps." },
    ]
    const childConversation: TopicMessage[] = [
      { role: "user", text: "Implement JWT token validation middleware" },
      { role: "assistant", text: "Done, opened PR #55." },
    ]

    const digest = await buildChildSessionDigest({
      childConversation,
      parentConversation,
    })

    expect(digest).toContain("<details>")
    expect(digest).toContain("</details>")
    expect(digest).toContain("**Planning context:**")
    expect(digest).toContain("User - requested auth refactor")
    expect(digest).toContain("**Child scope:** Implement JWT token validation middleware")
    expect(digest).toContain("**Execution:**")
    expect(digest).toContain("Agent - opened PR #55")
  })

  it("builds digest with only child summary when no parent provided", async () => {
    const childSummary = { lines: ["Agent - fixed the bug", "Agent - opened PR #10"] }
    mockSummarizeConversation.mockResolvedValueOnce(childSummary)

    const childConversation: TopicMessage[] = [
      { role: "user", text: "Fix the login bug" },
      { role: "assistant", text: "Fixed and opened PR." },
    ]

    const digest = await buildChildSessionDigest({ childConversation })

    expect(digest).not.toContain("**Planning context:**")
    expect(digest).toContain("**Child scope:** Fix the login bug")
    expect(digest).toContain("**Execution:**")
    expect(digest).toContain("Agent - fixed the bug")
  })

  it("falls back to buildConversationDigest when both summaries fail", async () => {
    mockSummarizeConversation.mockResolvedValue(null)

    const childConversation: TopicMessage[] = [
      { role: "user", text: "do the thing" },
      { role: "assistant", text: "done" },
    ]

    const digest = await buildChildSessionDigest({ childConversation })

    expect(digest).toContain("**Task:** do the thing")
    expect(digest).toContain("**Agent**: done")
  })

  it("builds digest without parent section when parent summarization fails", async () => {
    const childSummary = { lines: ["Agent - completed the task"] }
    mockSummarizeConversation
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(childSummary)

    const childConversation: TopicMessage[] = [
      { role: "user", text: "Add tests for auth module" },
      { role: "assistant", text: "Added 5 test cases." },
    ]

    const digest = await buildChildSessionDigest({
      childConversation,
      parentConversation: [
        { role: "user", text: "plan auth work" },
        { role: "assistant", text: "here's my plan" },
      ],
    })

    expect(digest).not.toContain("**Planning context:**")
    expect(digest).toContain("**Execution:**")
    expect(digest).toContain("Agent - completed the task")
  })

  it("passes profile to summarizeConversation", async () => {
    mockSummarizeConversation.mockResolvedValue({ lines: ["Agent - done"] })

    const profile = {
      id: "test",
      name: "Test",
      baseUrl: "https://test.api",
      authToken: "tok",
      haikuModel: "test-haiku",
    }

    await buildChildSessionDigest({
      childConversation: [
        { role: "user", text: "task" },
        { role: "assistant", text: "done" },
      ],
      profile,
    })

    expect(mockSummarizeConversation).toHaveBeenCalledWith(
      expect.any(Array),
      profile,
    )
  })

  it("extracts child instructions from first user message", async () => {
    mockSummarizeConversation.mockResolvedValue({ lines: ["Agent - done"] })

    const childConversation: TopicMessage[] = [
      { role: "user", text: "Implement the caching layer for API responses" },
      { role: "assistant", text: "Implemented caching." },
    ]

    const digest = await buildChildSessionDigest({ childConversation })
    expect(digest).toContain("**Child scope:** Implement the caching layer for API responses")
  })

  it("strips tool noise from child instructions", async () => {
    mockSummarizeConversation.mockResolvedValue({ lines: ["Agent - done"] })

    const childConversation: TopicMessage[] = [
      { role: "user", text: "Fix this:\n```ts\nconst x = 1\n```\nMake it better" },
      { role: "assistant", text: "Fixed." },
    ]

    const digest = await buildChildSessionDigest({ childConversation })
    expect(digest).toContain("[code block]")
    expect(digest).not.toContain("const x = 1")
  })

  it("handles child conversation starting with assistant message", async () => {
    mockSummarizeConversation.mockResolvedValue({ lines: ["Agent - did work"] })

    const childConversation: TopicMessage[] = [
      { role: "assistant", text: "Starting work on the task." },
      { role: "assistant", text: "Done." },
    ]

    const digest = await buildChildSessionDigest({ childConversation })
    expect(digest).not.toContain("**Child scope:**")
    expect(digest).toContain("**Execution:**")
  })

  it("truncates long child instructions", async () => {
    mockSummarizeConversation.mockResolvedValue({ lines: ["Agent - done"] })

    const childConversation: TopicMessage[] = [
      { role: "user", text: "a".repeat(1000) },
      { role: "assistant", text: "done" },
    ]

    const digest = await buildChildSessionDigest({ childConversation })
    expect(digest).toContain("...")
    expect(digest!.indexOf("**Child scope:**")).toBeGreaterThan(-1)
  })

  it("skips parent summarization when parent conversation is empty", async () => {
    const childSummary = { lines: ["Agent - completed work"] }
    mockSummarizeConversation.mockResolvedValueOnce(childSummary)

    await buildChildSessionDigest({
      childConversation: [
        { role: "user", text: "task" },
        { role: "assistant", text: "done" },
      ],
      parentConversation: [],
    })

    expect(mockSummarizeConversation).toHaveBeenCalledTimes(1)
  })

  it("runs parent and child summarization in parallel", async () => {
    const callOrder: string[] = []
    mockSummarizeConversation.mockImplementation(async (conversation) => {
      const label = conversation.length === 2 ? "parent" : "child"
      callOrder.push(`start-${label}`)
      await new Promise((r) => setTimeout(r, 10))
      callOrder.push(`end-${label}`)
      return { lines: [`${label} - done`] }
    })

    await buildChildSessionDigest({
      childConversation: [
        { role: "user", text: "child task" },
        { role: "assistant", text: "child work" },
        { role: "assistant", text: "child done" },
      ],
      parentConversation: [
        { role: "user", text: "plan" },
        { role: "assistant", text: "here's the plan" },
      ],
    })

    expect(callOrder[0]).toBe("start-parent")
    expect(callOrder[1]).toBe("start-child")
  })
})
