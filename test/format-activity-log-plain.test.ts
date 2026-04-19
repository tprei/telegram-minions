import { describe, it, expect } from "vitest"
import { formatActivityLogPlain } from "../src/telegram/format.js"

describe("formatActivityLogPlain", () => {
  it("renders singular 'tool' when count is 1", () => {
    const result = formatActivityLogPlain(["Read file.ts"], 1)
    expect(result.split("\n")[0]).toBe("**🔧 Activity · 1 tool**")
  })

  it("renders plural 'tools' for zero tools", () => {
    const result = formatActivityLogPlain([], 0)
    expect(result).toBe("**🔧 Activity · 0 tools**\n")
  })

  it("renders plural 'tools' when count is > 1", () => {
    const result = formatActivityLogPlain(["Read a.ts", "Read b.ts"], 2)
    expect(result.split("\n")[0]).toBe("**🔧 Activity · 2 tools**")
  })

  it("prefixes each line with '- '", () => {
    const result = formatActivityLogPlain(["first", "second"], 2)
    const lines = result.split("\n")
    expect(lines[2]).toBe("- first")
    expect(lines[3]).toBe("- second")
  })

  it("places a blank line between header and body", () => {
    const result = formatActivityLogPlain(["entry"], 1)
    const lines = result.split("\n")
    expect(lines[0]).toBe("**🔧 Activity · 1 tool**")
    expect(lines[1]).toBe("")
    expect(lines[2]).toBe("- entry")
  })

  it("strips <code> tags to backticks", () => {
    const result = formatActivityLogPlain(["Read <code>src/index.ts</code>"], 1)
    expect(result).toContain("- Read `src/index.ts`")
  })

  it("strips <b> tags to markdown bold", () => {
    const result = formatActivityLogPlain(["Ran <b>npm test</b>"], 1)
    expect(result).toContain("- Ran **npm test**")
  })

  it("unescapes HTML entities (&amp; &lt; &gt;)", () => {
    const result = formatActivityLogPlain(["cat a &amp; b &lt;pipe&gt; c"], 1)
    expect(result).toContain("- cat a & b <pipe> c")
  })

  it("handles multiple tag types in one line", () => {
    const result = formatActivityLogPlain(
      ["<b>Edit</b> <code>a &amp; b.ts</code>"],
      1,
    )
    expect(result).toContain("- **Edit** `a & b.ts`")
  })

  it("preserves empty strings and whitespace-only lines", () => {
    const result = formatActivityLogPlain(["", "   "], 2)
    const lines = result.split("\n")
    expect(lines[2]).toBe("- ")
    expect(lines[3]).toBe("-    ")
  })

  it("returns only the header and trailing separator when lines is empty", () => {
    const result = formatActivityLogPlain([], 3)
    expect(result).toBe("**🔧 Activity · 3 tools**\n")
  })
})
