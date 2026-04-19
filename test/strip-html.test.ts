import { describe, it, expect } from "vitest"
import { stripHtml } from "../src/telegram/strip-html.js"

describe("stripHtml", () => {
  it("returns plain text unchanged except for trimming", () => {
    expect(stripHtml("hello world")).toBe("hello world")
    expect(stripHtml("  padded  ")).toBe("padded")
  })

  it("strips Telegram formatting tags", () => {
    expect(stripHtml("<b>bold</b>")).toBe("bold")
    expect(stripHtml("<i>it</i><s>strike</s>")).toBe("itstrike")
    expect(stripHtml("<code>x</code> and <pre>y</pre>")).toBe("x and y")
    expect(stripHtml("<blockquote>quoted</blockquote>")).toBe("quoted")
  })

  it("strips anchor tags but keeps their text", () => {
    expect(stripHtml('<a href="https://example.com">link</a>')).toBe("link")
    expect(stripHtml('see <a href="/x">here</a> now')).toBe("see here now")
  })

  it("converts <br> variants to newlines", () => {
    expect(stripHtml("a<br>b")).toBe("a\nb")
    expect(stripHtml("a<br/>b")).toBe("a\nb")
    expect(stripHtml("a<br />b")).toBe("a\nb")
    expect(stripHtml("a<BR>b")).toBe("a\nb")
  })

  it("decodes the supported HTML entities", () => {
    expect(stripHtml("&lt;tag&gt;")).toBe("<tag>")
    expect(stripHtml("a &amp; b")).toBe("a & b")
    expect(stripHtml("&quot;x&quot;")).toBe('"x"')
    expect(stripHtml("it&#39;s")).toBe("it's")
    expect(stripHtml("a&nbsp;b")).toBe("a b")
  })

  it("leaves tags outside the Telegram vocabulary in place", () => {
    expect(stripHtml("<div>x</div>")).toBe("<div>x</div>")
    expect(stripHtml("<p>hello</p>")).toBe("<p>hello</p>")
  })

  it("does not decode unsupported entities", () => {
    expect(stripHtml("&copy; 2025")).toBe("&copy; 2025")
  })

  it("handles nested and mixed formatting", () => {
    expect(stripHtml("<b><i>bi</i></b>")).toBe("bi")
    expect(stripHtml('<blockquote>line1<br>line2</blockquote>')).toBe("line1\nline2")
  })

  it("handles an empty string", () => {
    expect(stripHtml("")).toBe("")
  })

  it("handles realistic Telegram-formatted messages", () => {
    const input = '<b>Task</b>: fix <code>foo()</code><br>see <a href="https://gh.io/1">PR #1</a>'
    expect(stripHtml(input)).toBe("Task: fix foo()\nsee PR #1")
  })

  it("handles entity strings adjacent to tags", () => {
    expect(stripHtml("<b>&amp;</b>")).toBe("&")
    expect(stripHtml("<code>a&lt;b</code>")).toBe("a<b")
  })

  it("does not double-decode — decoded output is not re-scanned for entities", () => {
    expect(stripHtml("&amp;lt;")).toBe("&lt;")
  })
})
