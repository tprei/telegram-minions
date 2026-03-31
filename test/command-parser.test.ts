import { describe, it, expect } from "vitest"
import {
  parseTaskArgs,
  parseReviewArgs,
  buildReviewAllTask,
  buildRepoKeyboard,
  buildProfileKeyboard,
  escapeHtml,
  extractRepoName,
  appendImageContext,
  TASK_PREFIX,
  TASK_SHORT,
  PLAN_PREFIX,
  THINK_PREFIX,
  REVIEW_PREFIX,
  EXECUTE_CMD,
  STATUS_CMD,
  STATS_CMD,
  REPLY_PREFIX,
  REPLY_SHORT,
  CLOSE_CMD,
  STOP_CMD,
  HELP_CMD,
  CLEAN_CMD,
  USAGE_CMD,
  CONFIG_CMD,
  SPLIT_CMD,
  STACK_CMD,
  DAG_CMD,
  LAND_CMD,
  RETRY_CMD,
  SHIP_PREFIX,
} from "../src/commands/command-parser.js"

describe("command-parser constants", () => {
  it("exports all command prefixes", () => {
    expect(TASK_PREFIX).toBe("/task")
    expect(TASK_SHORT).toBe("/w")
    expect(PLAN_PREFIX).toBe("/plan")
    expect(THINK_PREFIX).toBe("/think")
    expect(REVIEW_PREFIX).toBe("/review")
    expect(EXECUTE_CMD).toBe("/execute")
    expect(STATUS_CMD).toBe("/status")
    expect(STATS_CMD).toBe("/stats")
    expect(REPLY_PREFIX).toBe("/reply")
    expect(REPLY_SHORT).toBe("/r")
    expect(CLOSE_CMD).toBe("/close")
    expect(STOP_CMD).toBe("/stop")
    expect(HELP_CMD).toBe("/help")
    expect(CLEAN_CMD).toBe("/clean")
    expect(USAGE_CMD).toBe("/usage")
    expect(CONFIG_CMD).toBe("/config")
    expect(SPLIT_CMD).toBe("/split")
    expect(STACK_CMD).toBe("/stack")
    expect(DAG_CMD).toBe("/dag")
    expect(LAND_CMD).toBe("/land")
    expect(RETRY_CMD).toBe("/retry")
    expect(SHIP_PREFIX).toBe("/ship")
  })
})

describe("parseTaskArgs", () => {
  const repos = {
    "my-repo": "https://github.com/org/my-repo",
    "other": "https://github.com/org/other-repo",
  }

  it("parses URL + task description", () => {
    const result = parseTaskArgs(
      repos,
      "https://github.com/org/test Fix the bug",
    )
    expect(result.repoUrl).toBe("https://github.com/org/test")
    expect(result.task).toBe("Fix the bug")
  })

  it("parses repo alias + task description", () => {
    const result = parseTaskArgs(repos, "my-repo Fix the bug")
    expect(result.repoUrl).toBe("https://github.com/org/my-repo")
    expect(result.task).toBe("Fix the bug")
  })

  it("returns task only when no repo specified", () => {
    const result = parseTaskArgs(repos, "Fix the bug")
    expect(result.repoUrl).toBeUndefined()
    expect(result.task).toBe("Fix the bug")
  })

  it("handles empty args", () => {
    const result = parseTaskArgs(repos, "")
    expect(result.repoUrl).toBeUndefined()
    expect(result.task).toBe("")
  })

  it("handles task-only when alias doesn't exist", () => {
    const result = parseTaskArgs(repos, "unknown-repo Fix the bug")
    expect(result.repoUrl).toBeUndefined()
    expect(result.task).toBe("unknown-repo Fix the bug")
  })

  it("handles multi-word task descriptions", () => {
    const result = parseTaskArgs(
      repos,
      "my-repo Fix the bug and add tests for it",
    )
    expect(result.repoUrl).toBe("https://github.com/org/my-repo")
    expect(result.task).toBe("Fix the bug and add tests for it")
  })

  it("auto-selects repo when only one is configured", () => {
    const singleRepo = { "only": "https://github.com/org/only-repo" }
    const result = parseTaskArgs(singleRepo, "Fix the bug")
    expect(result.repoUrl).toBe("https://github.com/org/only-repo")
    expect(result.task).toBe("Fix the bug")
  })

  it("does not auto-select when multiple repos are configured", () => {
    const result = parseTaskArgs(repos, "Fix the bug")
    expect(result.repoUrl).toBeUndefined()
    expect(result.task).toBe("Fix the bug")
  })
})

describe("parseReviewArgs", () => {
  const repos = {
    "my-repo": "https://github.com/org/my-repo",
  }

  it("parses URL + PR number", () => {
    const result = parseReviewArgs(repos, "https://github.com/org/test 123")
    expect(result.repoUrl).toBe("https://github.com/org/test")
    expect(result.task).toBe("Review PR #123")
  })

  it("parses URL only (review all)", () => {
    const result = parseReviewArgs(repos, "https://github.com/org/test")
    expect(result.repoUrl).toBe("https://github.com/org/test")
    expect(result.task).toBe("")
  })

  it("parses repo alias + PR number", () => {
    const result = parseReviewArgs(repos, "my-repo 456")
    expect(result.repoUrl).toBe("https://github.com/org/my-repo")
    expect(result.task).toBe("Review PR #456")
  })

  it("parses repo alias only (review all)", () => {
    const result = parseReviewArgs(repos, "my-repo")
    expect(result.repoUrl).toBe("https://github.com/org/my-repo")
    expect(result.task).toBe("")
  })

  it("auto-selects repo for PR number when only one repo configured", () => {
    const result = parseReviewArgs(repos, "789")
    expect(result.repoUrl).toBe("https://github.com/org/my-repo")
    expect(result.task).toBe("Review PR #789")
  })

  it("does not auto-select repo for PR number when multiple repos configured", () => {
    const multiRepos = {
      "my-repo": "https://github.com/org/my-repo",
      "other": "https://github.com/org/other-repo",
    }
    const result = parseReviewArgs(multiRepos, "789")
    expect(result.repoUrl).toBeUndefined()
    expect(result.task).toBe("Review PR #789")
  })

  it("handles empty args", () => {
    const result = parseReviewArgs(repos, "")
    expect(result.repoUrl).toBeUndefined()
    expect(result.task).toBe("")
  })
})

describe("buildReviewAllTask", () => {
  it("generates review task for a repo", () => {
    const task = buildReviewAllTask("https://github.com/org/my-repo")
    expect(task).toContain("my-repo")
    expect(task).toContain("gh pr list")
    expect(task).toContain("reviewDecision")
  })
})

describe("buildRepoKeyboard", () => {
  it("builds keyboard with two repos per row", () => {
    const keyboard = buildRepoKeyboard(["repo1", "repo2", "repo3"])
    expect(keyboard).toHaveLength(2)
    expect(keyboard[0]).toHaveLength(2)
    expect(keyboard[0][0].text).toBe("repo1")
    expect(keyboard[0][0].callback_data).toBe("repo:repo1")
    expect(keyboard[0][1].text).toBe("repo2")
    expect(keyboard[1][0].text).toBe("repo3")
    expect(keyboard[1]).toHaveLength(1)
  })

  it("builds keyboard with plan prefix", () => {
    const keyboard = buildRepoKeyboard(["repo1"], "plan")
    expect(keyboard[0][0].callback_data).toBe("plan-repo:repo1")
  })

  it("builds keyboard with think prefix", () => {
    const keyboard = buildRepoKeyboard(["repo1"], "think")
    expect(keyboard[0][0].callback_data).toBe("think-repo:repo1")
  })

  it("builds keyboard with review prefix", () => {
    const keyboard = buildRepoKeyboard(["repo1"], "review")
    expect(keyboard[0][0].callback_data).toBe("review-repo:repo1")
  })

  it("builds keyboard with ship prefix", () => {
    const keyboard = buildRepoKeyboard(["repo1"], "ship")
    expect(keyboard[0][0].callback_data).toBe("ship-repo:repo1")
  })

  it("handles empty repo list", () => {
    const keyboard = buildRepoKeyboard([])
    expect(keyboard).toHaveLength(0)
  })
})

describe("buildProfileKeyboard", () => {
  it("builds keyboard with two profiles per row", () => {
    const profiles = [
      { id: "p1", name: "Profile 1" },
      { id: "p2", name: "Profile 2" },
      { id: "p3", name: "Profile 3" },
    ]
    const keyboard = buildProfileKeyboard(profiles)
    expect(keyboard).toHaveLength(2)
    expect(keyboard[0][0].text).toBe("Profile 1")
    expect(keyboard[0][0].callback_data).toBe("profile:p1")
    expect(keyboard[0][1].text).toBe("Profile 2")
    expect(keyboard[1][0].text).toBe("Profile 3")
  })

  it("handles empty profile list", () => {
    const keyboard = buildProfileKeyboard([])
    expect(keyboard).toHaveLength(0)
  })
})

describe("escapeHtml", () => {
  it("escapes special HTML characters", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;")
    expect(escapeHtml("a & b")).toBe("a &amp; b")
    expect(escapeHtml("<a>&b</a>")).toBe("&lt;a&gt;&amp;b&lt;/a&gt;")
  })

  it("returns unchanged string without special chars", () => {
    expect(escapeHtml("hello world")).toBe("hello world")
  })
})

describe("extractRepoName", () => {
  it("extracts repo name from GitHub URL", () => {
    expect(extractRepoName("https://github.com/org/my-repo")).toBe("my-repo")
    expect(extractRepoName("https://github.com/org/another-repo.git")).toBe(
      "another-repo",
    )
  })

  it("extracts repo name from git URL", () => {
    expect(extractRepoName("git@github.com:org/my-repo.git")).toBe("my-repo")
  })

  it("returns 'repo' for empty string", () => {
    expect(extractRepoName("")).toBe("repo")
  })

  it("returns the string itself for simple strings without slashes", () => {
    expect(extractRepoName("not-a-url")).toBe("not-a-url")
  })
})

describe("appendImageContext", () => {
  it("appends image context to task", () => {
    const task = "Fix this bug"
    const imagePaths = ["/tmp/image1.jpg", "/tmp/image2.jpg"]
    const result = appendImageContext(task, imagePaths)

    expect(result).toContain("Fix this bug")
    expect(result).toContain("## Attached images")
    expect(result).toContain("/tmp/image1.jpg")
    expect(result).toContain("/tmp/image2.jpg")
  })

  it("returns unchanged task when no images", () => {
    const task = "Fix this bug"
    const result = appendImageContext(task, [])
    expect(result).toBe(task)
  })
})
