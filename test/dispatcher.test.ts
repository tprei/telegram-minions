import { describe, it, expect } from "vitest"

import {
  parseTaskArgs,
  buildRepoKeyboard,
  escapeHtml,
  extractRepoName,
  appendImageContext,
  buildContextPrompt,
  buildExecutionPrompt,
} from "../src/dispatcher.js"
import type { TopicSession } from "../src/types.js"

const testRepos = {
  scripts: "https://github.com/tprei/scripts",
  pinoquio: "https://github.com/retirers/pinoquio-na-web",
}

describe("parseTaskArgs", () => {
  it("parses URL + task", () => {
    const result = parseTaskArgs({}, "https://github.com/org/repo fix the bug")
    expect(result).toEqual({
      repoUrl: "https://github.com/org/repo",
      task: "fix the bug",
    })
  })

  it("parses repo alias + task", () => {
    const result = parseTaskArgs(testRepos, "scripts add a new feature")
    expect(result).toEqual({
      repoUrl: "https://github.com/tprei/scripts",
      task: "add a new feature",
    })
  })

  it("returns task only when no URL or alias", () => {
    const result = parseTaskArgs({}, "just do the thing")
    expect(result).toEqual({ task: "just do the thing" })
  })

  it("returns empty task for empty input", () => {
    const result = parseTaskArgs({}, "")
    expect(result).toEqual({ task: "" })
  })

  it("trims whitespace from task", () => {
    const result = parseTaskArgs({}, "  some task  ")
    expect(result).toEqual({ task: "some task" })
  })

  it("handles URL without trailing task (no space after URL)", () => {
    const result = parseTaskArgs({}, "https://github.com/org/repo")
    expect(result).toEqual({ task: "https://github.com/org/repo" })
  })

  it("handles alias without trailing task", () => {
    const result = parseTaskArgs(testRepos, "scripts")
    expect(result).toEqual({ task: "scripts" })
  })

  it("preserves multiline task text with URL", () => {
    const result = parseTaskArgs({}, "https://github.com/org/repo line1\nline2\nline3")
    expect(result.task).toBe("line1\nline2\nline3")
  })

  it("does not match unknown aliases", () => {
    const result = parseTaskArgs(testRepos, "unknown-alias do stuff")
    expect(result).toEqual({ task: "unknown-alias do stuff" })
    expect(result.repoUrl).toBeUndefined()
  })
})

describe("buildRepoKeyboard", () => {
  it("creates rows of 2 buttons", () => {
    const keyboard = buildRepoKeyboard(["a", "b", "c"])
    expect(keyboard).toHaveLength(2)
    expect(keyboard[0]).toHaveLength(2)
    expect(keyboard[1]).toHaveLength(1)
  })

  it("uses repo: prefix by default", () => {
    const keyboard = buildRepoKeyboard(["scripts"])
    expect(keyboard[0][0]).toEqual({ text: "scripts", callback_data: "repo:scripts" })
  })

  it("uses plan-repo: prefix when specified", () => {
    const keyboard = buildRepoKeyboard(["scripts"], "plan")
    expect(keyboard[0][0]).toEqual({ text: "scripts", callback_data: "plan-repo:scripts" })
  })

  it("handles even number of repos", () => {
    const keyboard = buildRepoKeyboard(["a", "b", "c", "d"])
    expect(keyboard).toHaveLength(2)
    expect(keyboard[0]).toHaveLength(2)
    expect(keyboard[1]).toHaveLength(2)
  })

  it("handles single repo", () => {
    const keyboard = buildRepoKeyboard(["only-one"])
    expect(keyboard).toHaveLength(1)
    expect(keyboard[0]).toHaveLength(1)
  })

  it("handles empty repo list", () => {
    const keyboard = buildRepoKeyboard([])
    expect(keyboard).toHaveLength(0)
  })
})

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b")
  })

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;")
  })

  it("handles all special characters together", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d")
  })

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("")
  })
})

describe("extractRepoName", () => {
  it("extracts repo name from HTTPS URL", () => {
    expect(extractRepoName("https://github.com/org/my-repo")).toBe("my-repo")
  })

  it("strips .git suffix", () => {
    expect(extractRepoName("https://github.com/org/my-repo.git")).toBe("my-repo")
  })

  it("handles SSH-style URLs", () => {
    expect(extractRepoName("git@github.com:org/my-repo.git")).toBe("my-repo")
  })

  it("returns empty string for empty input", () => {
    expect(extractRepoName("")).toBe("")
  })
})

describe("appendImageContext", () => {
  it("returns task unchanged when no images", () => {
    expect(appendImageContext("fix the bug", [])).toBe("fix the bug")
  })

  it("appends image references for single image", () => {
    const result = appendImageContext("fix the bug", ["/tmp/img1.jpg"])
    expect(result).toContain("fix the bug")
    expect(result).toContain("## Attached images")
    expect(result).toContain("`/tmp/img1.jpg`")
  })

  it("appends multiple image references", () => {
    const result = appendImageContext("fix the bug", ["/tmp/img1.jpg", "/tmp/img2.jpg"])
    expect(result).toContain("`/tmp/img1.jpg`")
    expect(result).toContain("`/tmp/img2.jpg`")
  })
})

describe("buildContextPrompt", () => {
  function makeTopicSession(overrides: Partial<TopicSession> = {}): TopicSession {
    return {
      threadId: 42,
      repo: "test-repo",
      cwd: "/tmp/test",
      slug: "bold-arc",
      conversation: [
        { role: "user", text: "fix the bug" },
        { role: "assistant", text: "I fixed it" },
        { role: "user", text: "actually, change X too" },
      ],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      ...overrides,
    }
  }

  it("includes all conversation messages", () => {
    const prompt = buildContextPrompt(makeTopicSession())
    expect(prompt).toContain("fix the bug")
    expect(prompt).toContain("I fixed it")
    expect(prompt).toContain("actually, change X too")
  })

  it("uses follow-up header and guidance for task mode", () => {
    const prompt = buildContextPrompt(makeTopicSession({ mode: "task" }))
    expect(prompt).toContain("Follow-up context")
    expect(prompt).toContain("previous changes")
    expect(prompt).toContain("Address the user's latest feedback")
  })

  it("uses planning header and guidance for plan mode", () => {
    const prompt = buildContextPrompt(makeTopicSession({ mode: "plan" }))
    expect(prompt).toContain("Planning context")
    expect(prompt).toContain("Refine the plan")
  })

  it("truncates long assistant messages to 4000 chars", () => {
    const longText = "x".repeat(5000)
    const prompt = buildContextPrompt(makeTopicSession({
      conversation: [
        { role: "user", text: "task" },
        { role: "assistant", text: longText },
      ],
    }))
    expect(prompt).toContain("[earlier output truncated]")
    expect(prompt.length).toBeLessThan(longText.length)
  })

  it("does not truncate short assistant messages", () => {
    const shortText = "This is a short response"
    const prompt = buildContextPrompt(makeTopicSession({
      conversation: [
        { role: "user", text: "task" },
        { role: "assistant", text: shortText },
      ],
    }))
    expect(prompt).not.toContain("[earlier output truncated]")
    expect(prompt).toContain(shortText)
  })

  it("labels messages with User and Agent", () => {
    const prompt = buildContextPrompt(makeTopicSession())
    expect(prompt).toContain("**User**:")
    expect(prompt).toContain("**Agent**:")
  })

  it("ends with separator", () => {
    const prompt = buildContextPrompt(makeTopicSession())
    expect(prompt).toContain("---")
  })
})

describe("buildExecutionPrompt", () => {
  function makeTopicSession(overrides: Partial<TopicSession> = {}): TopicSession {
    return {
      threadId: 42,
      repo: "test-repo",
      cwd: "/tmp/test",
      slug: "bold-arc",
      conversation: [
        { role: "user", text: "implement feature X" },
        { role: "assistant", text: "Plan v1: do A then B" },
        { role: "user", text: "also do C" },
        { role: "assistant", text: "Plan v2: do A, B, then C" },
      ],
      pendingFeedback: [],
      mode: "plan",
      lastActivityAt: Date.now(),
      ...overrides,
    }
  }

  it("includes original user request as the task", () => {
    const prompt = buildExecutionPrompt(makeTopicSession())
    expect(prompt).toContain("implement feature X")
  })

  it("includes full conversation history", () => {
    const prompt = buildExecutionPrompt(makeTopicSession())
    expect(prompt).toContain("Plan v1: do A then B")
    expect(prompt).toContain("also do C")
    expect(prompt).toContain("Plan v2: do A, B, then C")
  })

  it("labels messages with User and Agent", () => {
    const prompt = buildExecutionPrompt(makeTopicSession())
    expect(prompt).toContain("**User**:")
    expect(prompt).toContain("**Agent**:")
  })

  it("includes section headers", () => {
    const prompt = buildExecutionPrompt(makeTopicSession())
    expect(prompt).toContain("## Task")
    expect(prompt).toContain("## Planning thread")
  })

  it("uses Research thread header for think mode", () => {
    const prompt = buildExecutionPrompt(makeTopicSession({ mode: "think" }))
    expect(prompt).toContain("## Research thread")
  })

  it("includes instruction to follow the plan", () => {
    const prompt = buildExecutionPrompt(makeTopicSession())
    expect(prompt).toContain("Follow the plan closely")
  })

  it("handles empty conversation", () => {
    const prompt = buildExecutionPrompt(makeTopicSession({
      conversation: [],
    }))
    expect(prompt).toContain("## Task")
    expect(prompt).not.toContain("## Planning thread")
  })

  it("handles conversation with no assistant messages", () => {
    const prompt = buildExecutionPrompt(makeTopicSession({
      conversation: [{ role: "user", text: "do the thing" }],
    }))
    expect(prompt).toContain("do the thing")
  })

  it("handles single assistant message", () => {
    const prompt = buildExecutionPrompt(makeTopicSession({
      conversation: [
        { role: "user", text: "build it" },
        { role: "assistant", text: "The plan is: step 1, step 2" },
      ],
    }))
    expect(prompt).toContain("build it")
    expect(prompt).toContain("The plan is: step 1, step 2")
  })

  it("truncates long assistant messages", () => {
    const longText = "x".repeat(5000)
    const prompt = buildExecutionPrompt(makeTopicSession({
      conversation: [
        { role: "user", text: "task" },
        { role: "assistant", text: longText },
      ],
    }))
    expect(prompt).toContain("[earlier output truncated]")
    expect(prompt).not.toContain("x".repeat(5000))
  })

  it("uses directive instead of default instruction when provided", () => {
    const prompt = buildExecutionPrompt(makeTopicSession(), "Only implement step 1 for now")
    expect(prompt).toContain("Only implement step 1 for now")
    expect(prompt).not.toContain("Follow the plan closely")
  })

  it("uses default instruction when no directive is provided", () => {
    const prompt = buildExecutionPrompt(makeTopicSession())
    expect(prompt).toContain("Follow the plan closely")
  })
})
