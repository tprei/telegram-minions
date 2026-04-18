import { describe, it, expect } from "vitest"
import { formatThinkStart } from "../src/telegram/format.js"

describe("formatThinkStart", () => {
  it("includes the deep-research header, repo, slug, and task", () => {
    const msg = formatThinkStart("my-repo", "cool-slug", "Investigate memory leak")
    expect(msg).toContain("Deep research started")
    expect(msg).toContain("my-repo")
    expect(msg).toContain("cool-slug")
    expect(msg).toContain("Investigate memory leak")
  })

  it("wraps the task in a blockquote", () => {
    const msg = formatThinkStart("repo", "slug", "some task")
    expect(msg).toContain("<blockquote>some task</blockquote>")
  })

  it("renders slug inside a <code> element", () => {
    const msg = formatThinkStart("repo", "slug-abc", "task")
    expect(msg).toContain("<code>slug-abc</code>")
  })

  it("renders repo inside a <b> element", () => {
    const msg = formatThinkStart("my-repo", "slug", "task")
    expect(msg).toContain("<b>my-repo</b>")
  })

  it("includes /reply follow-up instructions", () => {
    const msg = formatThinkStart("repo", "slug", "task")
    expect(msg).toContain("/reply")
    expect(msg).toContain("/r")
  })

  it("truncates tasks longer than 200 characters", () => {
    const longTask = "x".repeat(300)
    const msg = formatThinkStart("repo", "slug", longTask)
    expect(msg).toContain("…")
    expect(msg).not.toContain("x".repeat(300))
  })

  it("does not truncate tasks at exactly 200 characters", () => {
    const task = "y".repeat(200)
    const msg = formatThinkStart("repo", "slug", task)
    expect(msg).toContain(task)
    expect(msg).not.toContain("…")
  })

  it("escapes HTML in the task text", () => {
    const msg = formatThinkStart("repo", "slug", "<script>alert('xss')</script>")
    expect(msg).toContain("&lt;script&gt;")
    expect(msg).toContain("&lt;/script&gt;")
    expect(msg).not.toContain("<script>")
  })

  it("escapes HTML in the repo name", () => {
    const msg = formatThinkStart("<bad>", "slug", "task")
    expect(msg).toContain("&lt;bad&gt;")
    expect(msg).not.toMatch(/<b>\s*<bad>/)
  })

  it("escapes HTML in the slug", () => {
    const msg = formatThinkStart("repo", "<slug>", "task")
    expect(msg).toContain("&lt;slug&gt;")
  })

  it("escapes ampersands in the task", () => {
    const msg = formatThinkStart("repo", "slug", "a & b")
    expect(msg).toContain("a &amp; b")
  })

  it("handles an empty task string", () => {
    const msg = formatThinkStart("repo", "slug", "")
    expect(msg).toContain("<blockquote></blockquote>")
  })
})
