import { describe, it, expect } from "vitest"
import { buildConversationDigest } from "../src/conversation-digest.js"
import type { TopicMessage } from "../src/types.js"

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
