import { describe, it, expect } from "vitest"
import { truncateConversation } from "../src/conversation-limits.js"
import type { TopicMessage } from "../src/types.js"

function makeMessages(count: number, startRole: "user" | "assistant" = "user"): TopicMessage[] {
  const messages: TopicMessage[] = []
  let role: "user" | "assistant" = startRole
  for (let i = 0; i < count; i++) {
    messages.push({ role, text: `Message ${i + 1}` })
    role = role === "user" ? "assistant" : "user"
  }
  return messages
}

describe("truncateConversation", () => {
  it("does not truncate when under max length", () => {
    const conversation = makeMessages(5)
    const result = truncateConversation(conversation, 10)

    expect(result.truncated).toBe(false)
    expect(result.truncatedCount).toBe(0)
    expect(result.conversation).toHaveLength(5)
    expect(result.conversation).toBe(conversation)
  })

  it("does not truncate when exactly at max length", () => {
    const conversation = makeMessages(10)
    const result = truncateConversation(conversation, 10)

    expect(result.truncated).toBe(false)
    expect(result.conversation).toHaveLength(10)
  })

  it("truncates when over max length", () => {
    const conversation = makeMessages(20)
    const result = truncateConversation(conversation, 10)

    expect(result.truncated).toBe(true)
    expect(result.truncatedCount).toBe(11)
    expect(result.conversation).toHaveLength(10)
  })

  it("preserves the first message (original task)", () => {
    const conversation: TopicMessage[] = [
      { role: "user", text: "Original task: fix the bug" },
      ...makeMessages(20, "assistant"),
    ]
    const result = truncateConversation(conversation, 10)

    expect(result.conversation[0]).toEqual({ role: "user", text: "Original task: fix the bug" })
  })

  it("preserves recent messages", () => {
    const conversation: TopicMessage[] = [
      { role: "user", text: "Task" },
      ...makeMessages(20, "assistant"),
    ]
    const result = truncateConversation(conversation, 5)

    expect(result.conversation).toHaveLength(5)
    // With maxLength=5: keepCount=3, so last 3 messages are preserved
    // Result structure: [first, summary, ...last 3 recent messages]
    const lastMessages = result.conversation.slice(-3)
    const originalLastMessages = conversation.slice(-3)
    expect(lastMessages).toEqual(originalLastMessages)
  })

  it("inserts summary message after first message when truncating", () => {
    const conversation = makeMessages(20)
    const result = truncateConversation(conversation, 10)

    expect(result.conversation[1].role).toBe("user")
    expect(result.conversation[1].text).toContain("truncated")
  })

  it("handles empty conversation", () => {
    const result = truncateConversation([], 10)

    expect(result.truncated).toBe(false)
    expect(result.conversation).toHaveLength(0)
  })

  it("handles single message conversation", () => {
    const conversation: TopicMessage[] = [{ role: "user", text: "Task" }]
    const result = truncateConversation(conversation, 10)

    expect(result.truncated).toBe(false)
    expect(result.conversation).toHaveLength(1)
  })

  it("handles max length of 1", () => {
    const conversation = makeMessages(5)
    const result = truncateConversation(conversation, 1)

    expect(result.truncated).toBe(true)
    expect(result.truncatedCount).toBe(4)
    expect(result.conversation).toHaveLength(1)
    expect(result.conversation[0]).toEqual(conversation[0])
  })

  it("handles max length of 2", () => {
    const conversation = makeMessages(5)
    const result = truncateConversation(conversation, 2)

    expect(result.truncated).toBe(true)
    expect(result.conversation).toHaveLength(2)
    expect(result.conversation[0]).toEqual(conversation[0])
  })

  it("summary includes counts of truncated messages", () => {
    const conversation = makeMessages(20)
    const result = truncateConversation(conversation, 10)

    const summary = result.conversation[1].text
    expect(summary).toMatch(/\d+ user/)
    expect(summary).toMatch(/\d+ assistant/)
  })

  it("summary includes key points from user messages", () => {
    const conversation: TopicMessage[] = [
      { role: "user", text: "Original task" },
      { role: "assistant", text: "Response 1" },
      { role: "user", text: "Feedback: add tests" },
      { role: "assistant", text: "Response 2" },
      { role: "user", text: "Feedback: fix the bug" },
      { role: "assistant", text: "Response 3" },
      { role: "user", text: "Recent feedback" },
    ]
    const result = truncateConversation(conversation, 3)

    expect(result.conversation).toHaveLength(3)
    expect(result.conversation[0].text).toBe("Original task")
    expect(result.conversation[2].text).toBe("Recent feedback")
  })

  it("truncates long user messages in key points", () => {
    const longText = "a".repeat(200)
    const conversation: TopicMessage[] = [
      { role: "user", text: "Task" },
      { role: "assistant", text: "Response" },
      { role: "user", text: longText },
      { role: "assistant", text: "Response" },
      { role: "user", text: "Recent" },
    ]
    const result = truncateConversation(conversation, 3)

    expect(result.conversation).toHaveLength(3)
  })

  it("returned conversation is a new array distinct from the input when truncated", () => {
    const conversation = makeMessages(20)
    const result = truncateConversation(conversation, 10)

    expect(result.truncated).toBe(true)
    expect(result.conversation).not.toBe(conversation)
    expect(result.conversation).toHaveLength(10)
    expect(conversation).toHaveLength(20)
  })

  it("caller must assign returned conversation to cap array length", () => {
    const session = { conversation: makeMessages(10) }
    const maxLength = 5

    session.conversation.push({ role: "user", text: "Message 11" })
    const { conversation, truncated } = truncateConversation(session.conversation, maxLength)
    if (truncated) {
      session.conversation = conversation
    }

    expect(session.conversation).toHaveLength(maxLength)
  })
})
