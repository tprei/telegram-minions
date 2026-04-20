import { describe, it, expect } from "vitest"
import { formatPinnedStatus } from "../src/telegram/format.js"

describe("formatPinnedStatus", () => {
  it("renders the working state with ⚡ icon and 'Working' label", () => {
    const out = formatPinnedStatus("bold-arc", "owner/repo", "working")
    expect(out).toContain("⚡")
    expect(out).toContain("<b>Working</b>")
    expect(out).toContain("<code>bold-arc</code>")
    expect(out).toContain("owner/repo")
  })

  it("renders the completed state with ✅ icon and 'Complete' label", () => {
    const out = formatPinnedStatus("slug", "repo", "completed")
    expect(out).toContain("✅")
    expect(out).toContain("<b>Complete</b>")
  })

  it("renders the errored state with ❌ icon and 'Error' label", () => {
    const out = formatPinnedStatus("slug", "repo", "errored")
    expect(out).toContain("❌")
    expect(out).toContain("<b>Error</b>")
  })

  it("renders a linked PR number when prUrl is a GitHub PR URL", () => {
    const out = formatPinnedStatus(
      "slug",
      "owner/repo",
      "completed",
      "https://github.com/owner/repo/pull/42",
    )
    expect(out).toContain('<b>PR:</b> <a href="https://github.com/owner/repo/pull/42">#42</a>')
  })

  it("falls back to the full URL as the link text when no /pull/<n> segment matches", () => {
    const url = "https://example.com/some-other-url"
    const out = formatPinnedStatus("slug", "repo", "working", url)
    expect(out).toContain(`<a href="${url}">#${url}</a>`)
  })

  it("renders extra label/state when no prUrl is provided", () => {
    const out = formatPinnedStatus("slug", "repo", "working", undefined, {
      label: "waiting for review",
      state: "Status",
    })
    expect(out).toContain("Status: waiting for review")
    expect(out).not.toContain("<b>PR:</b>")
  })

  it("prefers prUrl over extra when both are provided", () => {
    const out = formatPinnedStatus(
      "slug",
      "repo",
      "working",
      "https://github.com/o/r/pull/7",
      { label: "ignored", state: "Status" },
    )
    expect(out).toContain("#7")
    expect(out).not.toContain("Status: ignored")
  })

  it("omits the extra block when only one of label/state is supplied", () => {
    const onlyLabel = formatPinnedStatus("slug", "repo", "working", undefined, { label: "x" })
    const onlyState = formatPinnedStatus("slug", "repo", "working", undefined, { state: "y" })
    expect(onlyLabel).not.toContain(": x")
    expect(onlyState).not.toContain("y:")
  })

  it("produces a single-line output when neither prUrl nor extra is provided", () => {
    const out = formatPinnedStatus("slug", "repo", "working")
    expect(out.split("\n")).toHaveLength(1)
  })

  it("HTML-escapes slug, repo, prUrl, and extra fields", () => {
    const out = formatPinnedStatus(
      "slug&<>",
      "owner/<repo>",
      "working",
      "https://x/pull/<1>",
      { label: "a&b", state: "s<t>" },
    )
    // prUrl branch wins — extra is not used.
    expect(out).toContain("<code>slug&amp;&lt;&gt;</code>")
    expect(out).toContain("owner/&lt;repo&gt;")
    expect(out).toContain('href="https://x/pull/&lt;1&gt;"')
    expect(out).not.toContain("<repo>")
  })

  it("escapes extra label/state when they are rendered", () => {
    const out = formatPinnedStatus("slug", "repo", "working", undefined, {
      label: "a&b",
      state: "s<t>",
    })
    expect(out).toContain("s&lt;t&gt;: a&amp;b")
  })
})
