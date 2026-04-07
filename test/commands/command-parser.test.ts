import { describe, it, expect } from "vitest"
import {
  parseTaskArgs,
  parseReviewArgs,
  escapeHtml,
  extractRepoName,
  appendImageContext,
} from "../../src/commands/command-parser.js"

describe("parseTaskArgs", () => {
  const repos: Record<string, string> = {
    app: "https://github.com/org/app",
    api: "https://github.com/org/api",
  }

  it("extracts URL and task from full URL input", () => {
    const result = parseTaskArgs(repos, "https://github.com/org/app Fix the bug")
    expect(result).toEqual({
      repoUrl: "https://github.com/org/app",
      task: "Fix the bug",
    })
  })

  it("resolves repo alias and task", () => {
    const result = parseTaskArgs(repos, "app Fix the bug")
    expect(result).toEqual({
      repoUrl: "https://github.com/org/app",
      task: "Fix the bug",
    })
  })

  it("returns task only when no URL and no alias match", () => {
    const result = parseTaskArgs(repos, "Fix the bug")
    expect(result).toEqual({ task: "Fix the bug" })
  })

  it("auto-selects single configured repo", () => {
    const single = { myrepo: "https://github.com/org/myrepo" }
    const result = parseTaskArgs(single, "Fix the bug")
    expect(result).toEqual({
      repoUrl: "https://github.com/org/myrepo",
      task: "Fix the bug",
    })
  })

  it("trims whitespace from task", () => {
    const result = parseTaskArgs(repos, "app   some task  ")
    expect(result.task).toBe("some task")
  })
})

describe("parseReviewArgs", () => {
  const repos: Record<string, string> = {
    app: "https://github.com/org/app",
  }

  it("returns empty task for empty args", () => {
    expect(parseReviewArgs(repos, "")).toEqual({ task: "" })
  })

  it("extracts URL and PR number", () => {
    const result = parseReviewArgs(repos, "https://github.com/org/app 42")
    expect(result).toEqual({
      repoUrl: "https://github.com/org/app",
      task: "Review PR #42",
    })
  })

  it("extracts URL only", () => {
    const result = parseReviewArgs(repos, "https://github.com/org/app")
    expect(result).toEqual({
      repoUrl: "https://github.com/org/app",
      task: "",
    })
  })

  it("resolves alias with PR number", () => {
    const result = parseReviewArgs(repos, "app 99")
    expect(result).toEqual({
      repoUrl: "https://github.com/org/app",
      task: "Review PR #99",
    })
  })

  it("resolves alias without PR number", () => {
    const result = parseReviewArgs(repos, "app")
    expect(result).toEqual({
      repoUrl: "https://github.com/org/app",
      task: "",
    })
  })

  it("auto-selects single repo for bare PR number", () => {
    const result = parseReviewArgs(repos, "7")
    expect(result).toEqual({
      repoUrl: "https://github.com/org/app",
      task: "Review PR #7",
    })
  })

  it("returns task only for bare PR number with multiple repos", () => {
    const multi = {
      app: "https://github.com/org/app",
      api: "https://github.com/org/api",
    }
    const result = parseReviewArgs(multi, "7")
    expect(result).toEqual({ task: "Review PR #7" })
  })
})

describe("escapeHtml", () => {
  it("escapes ampersands, angle brackets", () => {
    expect(escapeHtml("<b>Tom & Jerry</b>")).toBe("&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;")
  })

  it("returns plain text unchanged", () => {
    expect(escapeHtml("hello")).toBe("hello")
  })
})

describe("extractRepoName", () => {
  it("extracts repo name from GitHub URL", () => {
    expect(extractRepoName("https://github.com/org/my-repo")).toBe("my-repo")
  })

  it("strips .git suffix", () => {
    expect(extractRepoName("https://github.com/org/my-repo.git")).toBe("my-repo")
  })

  it("falls back to 'repo' for empty string", () => {
    expect(extractRepoName("")).toBe("repo")
  })
})

describe("appendImageContext", () => {
  it("returns original task when no images", () => {
    expect(appendImageContext("Do stuff", [])).toBe("Do stuff")
  })

  it("appends image references", () => {
    const result = appendImageContext("Do stuff", ["/tmp/img1.png", "/tmp/img2.png"])
    expect(result).toContain("Do stuff")
    expect(result).toContain("## Attached images")
    expect(result).toContain("- `/tmp/img1.png`")
    expect(result).toContain("- `/tmp/img2.png`")
  })
})
