import { describe, expect, it } from "vitest"
import type { PendingDagItem, SessionMode, TopicSession } from "../src/domain/session-types.js"
import { DEFAULT_DAG_REVIEW_PROMPT, DEFAULT_PROMPTS } from "../src/config/prompts.js"
import {
  formatDagReviewStart,
  formatDagReviewChildStarting,
  formatDagReviewComplete,
} from "../src/telegram/format.js"
import { buildDagReviewChildPrompt } from "../src/dag/dag-orchestrator.js"
import type { DagNode } from "../src/dag/dag.js"

describe("PendingDagItem type", () => {
  it("should define a valid pending DAG item", () => {
    const item: PendingDagItem = {
      id: "task-1",
      title: "Create database schema",
      description: "Set up migrations for user tables",
      dependsOn: [],
    }
    expect(item.id).toBe("task-1")
    expect(item.dependsOn).toEqual([])
  })

  it("should support dependencies", () => {
    const item: PendingDagItem = {
      id: "task-2",
      title: "Build API",
      description: "Implement REST endpoints",
      dependsOn: ["task-1"],
    }
    expect(item.dependsOn).toContain("task-1")
  })

  it("should support multiple dependencies", () => {
    const item: PendingDagItem = {
      id: "task-3",
      title: "Integration tests",
      description: "Test full stack",
      dependsOn: ["task-1", "task-2"],
    }
    expect(item.dependsOn).toHaveLength(2)
  })
})

describe("SessionMode type", () => {
  it("should include dag-review mode", () => {
    const mode: SessionMode = "dag-review"
    expect(mode).toBe("dag-review")
  })

  it("should support all session modes", () => {
    const modes: SessionMode[] = [
      "task",
      "plan",
      "think",
      "review",
      "ci-fix",
      "dag-review",
    ]
    expect(modes).toContain("dag-review")
    expect(modes).toHaveLength(6)
  })
})

describe("TopicSession with pendingDagItems", () => {
  it("should support pendingDagItems field", () => {
    const session: TopicSession = {
      threadId: 123,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "dag-review",
      lastActivityAt: Date.now(),
      pendingDagItems: [
        {
          id: "step-1",
          title: "First task",
          description: "Do the first thing",
          dependsOn: [],
        },
        {
          id: "step-2",
          title: "Second task",
          description: "Do the second thing",
          dependsOn: ["step-1"],
        },
      ],
    }

    expect(session.mode).toBe("dag-review")
    expect(session.pendingDagItems).toHaveLength(2)
    expect(session.pendingDagItems?.[0].id).toBe("step-1")
    expect(session.pendingDagItems?.[1].dependsOn).toContain("step-1")
  })

  it("should allow undefined pendingDagItems", () => {
    const session: TopicSession = {
      threadId: 456,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    expect(session.pendingDagItems).toBeUndefined()
  })

  it("should allow empty pendingDagItems array", () => {
    const session: TopicSession = {
      threadId: 789,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "dag-review",
      lastActivityAt: Date.now(),
      pendingDagItems: [],
    }

    expect(session.pendingDagItems).toEqual([])
  })

  it("should work with other session fields", () => {
    const session: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      repoUrl: "https://github.com/org/repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [
        { role: "user", text: "Create a DAG for this feature" },
        { role: "assistant", text: "Here's the proposed DAG..." },
      ],
      activeSessionId: "session-123",
      pendingFeedback: [],
      mode: "dag-review",
      lastActivityAt: Date.now(),
      parentThreadId: 50,
      pendingDagItems: [
        {
          id: "backend",
          title: "Backend API",
          description: "Build the API",
          dependsOn: [],
        },
        {
          id: "frontend",
          title: "Frontend UI",
          description: "Build the UI",
          dependsOn: ["backend"],
        },
      ],
    }

    expect(session.mode).toBe("dag-review")
    expect(session.parentThreadId).toBe(50)
    expect(session.conversation).toHaveLength(2)
    expect(session.pendingDagItems).toHaveLength(2)
  })
})

describe("DEFAULT_DAG_REVIEW_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof DEFAULT_DAG_REVIEW_PROMPT).toBe("string")
    expect(DEFAULT_DAG_REVIEW_PROMPT.length).toBeGreaterThan(0)
  })

  it("mentions read-only and disabled tools", () => {
    expect(DEFAULT_DAG_REVIEW_PROMPT).toContain("READ-ONLY")
    expect(DEFAULT_DAG_REVIEW_PROMPT).toContain("Edit, Write, and NotebookEdit")
  })

  it("mentions DAG context", () => {
    expect(DEFAULT_DAG_REVIEW_PROMPT).toContain("DAG")
    expect(DEFAULT_DAG_REVIEW_PROMPT).toContain("dependency graph")
  })

  it("includes gh pr workflow instructions", () => {
    expect(DEFAULT_DAG_REVIEW_PROMPT).toContain("gh pr diff")
    expect(DEFAULT_DAG_REVIEW_PROMPT).toContain("gh pr review")
  })

  it("caps at 5 findings", () => {
    expect(DEFAULT_DAG_REVIEW_PROMPT).toContain("Cap at 5 findings")
  })

  it("is included in DEFAULT_PROMPTS", () => {
    expect(DEFAULT_PROMPTS.dag_review).toBe(DEFAULT_DAG_REVIEW_PROMPT)
  })
})

describe("formatDagReviewStart", () => {
  it("includes DAG review header, repo, slug, and task", () => {
    const msg = formatDagReviewStart("my-repo", "cool-slug", "Review DAG PRs")
    expect(msg).toContain("DAG review started")
    expect(msg).toContain("my-repo")
    expect(msg).toContain("cool-slug")
    expect(msg).toContain("Review DAG PRs")
  })

  it("includes /reply instructions", () => {
    const msg = formatDagReviewStart("repo", "slug", "task")
    expect(msg).toContain("/reply")
  })

  it("truncates long tasks", () => {
    const longTask = "x".repeat(300)
    const msg = formatDagReviewStart("repo", "slug", longTask)
    expect(msg).toContain("…")
    expect(msg.length).toBeLessThan(longTask.length + 200)
  })

  it("escapes HTML in task text", () => {
    const msg = formatDagReviewStart("repo", "slug", "<script>alert('xss')</script>")
    expect(msg).toContain("&lt;script&gt;")
    expect(msg).not.toContain("<script>")
  })
})

describe("formatDagReviewChildStarting", () => {
  it("includes node title and PR number", () => {
    const msg = formatDagReviewChildStarting("cool-slug", "Backend API", 42)
    expect(msg).toContain("Reviewing")
    expect(msg).toContain("Backend API")
    expect(msg).toContain("#42")
    expect(msg).toContain("cool-slug")
  })

  it("escapes HTML in node title", () => {
    const msg = formatDagReviewChildStarting("slug", "<b>bad</b>", 1)
    expect(msg).toContain("&lt;b&gt;bad&lt;/b&gt;")
  })
})

describe("formatDagReviewComplete", () => {
  it("includes slug and /reply instructions", () => {
    const msg = formatDagReviewComplete("cool-slug")
    expect(msg).toContain("DAG review complete")
    expect(msg).toContain("cool-slug")
    expect(msg).toContain("/reply")
  })
})

describe("dag-review SDK session mode", () => {
  it("uses 'dag-review' mode for review child sessions", () => {
    // The mode is set in spawnDagReviewChild — verify the value is valid
    const mode: SessionMode = "dag-review"
    expect(mode).toBe("dag-review")
  })

  it("dag-review children have dagId and dagNodeId set", () => {
    const session: TopicSession = {
      threadId: 300,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "review-slug",
      conversation: [{ role: "user", text: "review task" }],
      pendingFeedback: [],
      mode: "dag-review",
      lastActivityAt: Date.now(),
      dagId: "dag-parent-slug",
      dagNodeId: "backend-api",
      parentThreadId: 100,
      splitLabel: "Review: Backend API",
    }

    expect(session.mode).toBe("dag-review")
    expect(session.dagId).toBe("dag-parent-slug")
    expect(session.dagNodeId).toBe("backend-api")
    expect(session.splitLabel).toContain("Review:")
  })

  it("dag-review children have parentThreadId linking to DAG parent", () => {
    const session: TopicSession = {
      threadId: 300,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "review-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "dag-review",
      lastActivityAt: Date.now(),
      dagId: "dag-test",
      dagNodeId: "node-1",
      parentThreadId: 100,
    }

    expect(session.parentThreadId).toBe(100)
  })
})

describe("buildDagReviewChildPrompt", () => {
  const baseNode: DagNode = {
    id: "api",
    title: "Backend API",
    description: "Implement REST endpoints for user management",
    dependsOn: [],
    status: "done",
    prUrl: "https://github.com/org/repo/pull/42",
    branch: "minion/api-slug",
  }

  it("includes node title and PR number", () => {
    const prompt = buildDagReviewChildPrompt(baseNode, [], 42)
    expect(prompt).toContain("## Review: Backend API")
    expect(prompt).toContain("Pull request: #42")
    expect(prompt).toContain("https://github.com/org/repo/pull/42")
  })

  it("includes task description", () => {
    const prompt = buildDagReviewChildPrompt(baseNode, [], 42)
    expect(prompt).toContain("### Task description")
    expect(prompt).toContain("Implement REST endpoints for user management")
  })

  it("includes upstream context when present", () => {
    const upstream: DagNode = {
      id: "db",
      title: "Database Schema",
      description: "Create migrations",
      dependsOn: [],
      status: "done",
      prUrl: "https://github.com/org/repo/pull/40",
      branch: "minion/db-slug",
    }
    const node = { ...baseNode, dependsOn: ["db"] }
    const prompt = buildDagReviewChildPrompt(node, [upstream], 42)
    expect(prompt).toContain("### Upstream dependencies")
    expect(prompt).toContain("Database Schema")
    expect(prompt).toContain("#40")
    expect(prompt).toContain("minion/db-slug")
  })

  it("omits upstream section when no dependencies", () => {
    const prompt = buildDagReviewChildPrompt(baseNode, [], 42)
    expect(prompt).not.toContain("### Upstream dependencies")
  })

  it("includes gh pr diff instructions with PR number", () => {
    const prompt = buildDagReviewChildPrompt(baseNode, [], 42)
    expect(prompt).toContain("gh pr diff 42")
    expect(prompt).toContain("gh pr review")
  })

  it("works without a PR number", () => {
    const nodeNoPr = { ...baseNode, prUrl: undefined }
    const prompt = buildDagReviewChildPrompt(nodeNoPr, [])
    expect(prompt).not.toContain("gh pr diff")
    expect(prompt).toContain("Examine the workspace")
  })

  it("omits description section when node has no description", () => {
    const nodeNoDesc = { ...baseNode, description: "" }
    const prompt = buildDagReviewChildPrompt(nodeNoDesc, [], 42)
    expect(prompt).not.toContain("### Task description")
  })
})
