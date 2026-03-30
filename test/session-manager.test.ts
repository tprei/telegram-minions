import { describe, it, expect } from "vitest"
import {
  buildContextPrompt,
  buildExecutionPrompt,
  extractRepoName,
  escapeHtml,
} from "../src/command-parser.js"
import {
  buildContextPrompt as sessionBuildContextPrompt,
  buildExecutionPrompt as sessionBuildExecutionPrompt,
  dirSizeBytes,
  cleanBuildArtifacts,

  resolveDefaultBranch,
  prepareWorkspace,
  removeWorkspace,
  prepareFanInBranch,
  mergeUpstreamBranches,
  downloadPhotos,
} from "../src/session/session-manager.js"
import type { TopicSession } from "../src/types.js"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

// Note: session-manager re-exports some functions from command-parser for convenience
// We test them through command-parser tests, but verify the session-specific functions here

describe("buildContextPrompt", () => {
  it("builds context for task mode (follow-up)", () => {
    const session: TopicSession = {
      threadId: 1,
      repo: "test-repo",
      repoUrl: "https://github.com/org/test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [
        { role: "user", text: "Fix the bug" },
        { role: "assistant", text: "I've fixed the bug by doing X, Y, Z." },
        { role: "user", text: "Can you also add tests?" },
      ],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    const prompt = sessionBuildContextPrompt(session)

    expect(prompt).toContain("## Follow-up context")
    expect(prompt).toContain("**User**:")
    expect(prompt).toContain("**Agent**:")
    expect(prompt).toContain("Fix the bug")
    expect(prompt).toContain("I've fixed the bug")
    expect(prompt).toContain("Can you also add tests?")
    expect(prompt).toContain("The workspace still has your previous changes")
  })

  it("builds context for plan mode", () => {
    const session: TopicSession = {
      threadId: 1,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [{ role: "user", text: "Plan how to add auth" }],
      pendingFeedback: [],
      mode: "plan",
      lastActivityAt: Date.now(),
    }

    const prompt = sessionBuildContextPrompt(session)

    expect(prompt).toContain("## Planning context")
    expect(prompt).toContain("Refine the plan based on the latest feedback")
  })

  it("builds context for think mode", () => {
    const session: TopicSession = {
      threadId: 1,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [{ role: "user", text: "Research the best auth approach" }],
      pendingFeedback: [],
      mode: "think",
      lastActivityAt: Date.now(),
    }

    const prompt = sessionBuildContextPrompt(session)

    expect(prompt).toContain("## Research context")
    expect(prompt).toContain("Dig deeper based on the latest question")
  })

  it("builds context for review mode", () => {
    const session: TopicSession = {
      threadId: 1,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [{ role: "user", text: "Review PR #123" }],
      pendingFeedback: [],
      mode: "review",
      lastActivityAt: Date.now(),
    }

    const prompt = sessionBuildContextPrompt(session)

    expect(prompt).toContain("## Review context")
    expect(prompt).toContain("Address the user's follow-up about the review")
  })

  it("truncates long assistant responses", () => {
    const longResponse = "A".repeat(5000)
    const session: TopicSession = {
      threadId: 1,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [
        { role: "user", text: "Do something" },
        { role: "assistant", text: longResponse },
      ],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    const prompt = sessionBuildContextPrompt(session)

    expect(prompt).toContain("[earlier output truncated]")
    expect(prompt.length).toBeLessThan(longResponse.length + 500)
  })
})

describe("buildExecutionPrompt", () => {
  it("builds execution prompt from plan session", () => {
    const session: TopicSession = {
      threadId: 1,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [
        { role: "user", text: "Plan how to add auth" },
        { role: "assistant", text: "Here's the plan:\n1. Add JWT\n2. Add middleware" },
        { role: "user", text: "Looks good, proceed" },
      ],
      pendingFeedback: [],
      mode: "plan",
      lastActivityAt: Date.now(),
    }

    const prompt = sessionBuildExecutionPrompt(session)

    expect(prompt).toContain("## Task")
    expect(prompt).toContain("Plan how to add auth")
    expect(prompt).toContain("## Planning thread")
    expect(prompt).toContain("Here's the plan")
    expect(prompt).toContain("Implement the plan above")
  })

  it("includes directive when provided", () => {
    const session: TopicSession = {
      threadId: 1,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [{ role: "user", text: "Plan how to add auth" }],
      pendingFeedback: [],
      mode: "plan",
      lastActivityAt: Date.now(),
    }

    const prompt = sessionBuildExecutionPrompt(session, "Focus on the auth flow only")

    expect(prompt).toContain("Focus on the auth flow only")
  })

  it("builds execution prompt from think session", () => {
    const session: TopicSession = {
      threadId: 1,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [
        { role: "user", text: "Research auth options" },
        { role: "assistant", text: "JWT is the best option" },
      ],
      pendingFeedback: [],
      mode: "think",
      lastActivityAt: Date.now(),
    }

    const prompt = sessionBuildExecutionPrompt(session)

    expect(prompt).toContain("## Research thread")
  })

  it("builds execution prompt from review session", () => {
    const session: TopicSession = {
      threadId: 1,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [
        { role: "user", text: "Review PR #123" },
        { role: "assistant", text: "I've reviewed it" },
      ],
      pendingFeedback: [],
      mode: "review",
      lastActivityAt: Date.now(),
    }

    const prompt = sessionBuildExecutionPrompt(session)

    expect(prompt).toContain("## Review thread")
  })

  it("handles single-message conversation", () => {
    const session: TopicSession = {
      threadId: 1,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [{ role: "user", text: "Add authentication" }],
      pendingFeedback: [],
      mode: "plan",
      lastActivityAt: Date.now(),
    }

    const prompt = sessionBuildExecutionPrompt(session)

    expect(prompt).toContain("## Task")
    expect(prompt).toContain("Add authentication")
    expect(prompt).not.toContain("## Planning thread")
  })
})

describe("dirSizeBytes", () => {
  it("returns 0 for non-existent directory", () => {
    const size = dirSizeBytes("/nonexistent/path/that/does/not/exist")
    expect(size).toBe(0)
  })

  it("returns positive number for existing directory", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-dirsize-"))
    try {
      fs.writeFileSync(path.join(tmpDir, "test.txt"), "hello world")
      const size = dirSizeBytes(tmpDir)
      expect(size).toBeGreaterThan(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe("cleanBuildArtifacts", () => {
  it("removes node_modules if present", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-clean-"))
    try {
      const nodeModules = path.join(tmpDir, "node_modules")
      fs.mkdirSync(nodeModules)
      fs.writeFileSync(path.join(nodeModules, "test.js"), "test")

      expect(fs.existsSync(nodeModules)).toBe(true)
      cleanBuildArtifacts(tmpDir)
      expect(fs.existsSync(nodeModules)).toBe(false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("removes .next if present", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-clean-"))
    try {
      const nextDir = path.join(tmpDir, ".next")
      fs.mkdirSync(nextDir)
      fs.writeFileSync(path.join(nextDir, "build.json"), "{}")

      expect(fs.existsSync(nextDir)).toBe(true)
      cleanBuildArtifacts(tmpDir)
      expect(fs.existsSync(nextDir)).toBe(false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("does not fail on missing artifacts", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-clean-"))
    try {
      // Should not throw
      expect(() => cleanBuildArtifacts(tmpDir)).not.toThrow()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe("prepareFanInBranch", () => {
  it("returns first branch when only one upstream", () => {
    const result = prepareFanInBranch(
      "test-slug",
      "https://github.com/org/repo",
      ["branch-1"],
      "/workspace",
    )
    expect(result).toBe("branch-1")
  })

  it("returns null when no upstream branches", () => {
    const result = prepareFanInBranch(
      "test-slug",
      "https://github.com/org/repo",
      [],
      "/workspace",
    )
    expect(result).toBeNull()
  })
})

describe("mergeUpstreamBranches", () => {
  it("returns true when no additional branches", () => {
    const result = mergeUpstreamBranches("/workspace/test", [])
    expect(result).toBe(true)
  })
})
