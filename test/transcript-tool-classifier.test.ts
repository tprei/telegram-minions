import { describe, it, expect } from "vitest"
import {
  buildToolCallSummary,
  buildToolResultPayload,
  classifyTool,
  parseMcpName,
  type ClassifiedTool,
} from "../src/transcript/tool-classifier.js"
import type { ToolKind } from "../src/transcript/types.js"
import { TRANSCRIPT_TRUNCATION_BUDGET } from "../src/transcript/types.js"

describe("parseMcpName", () => {
  const cases: Array<{
    name: string
    expected: { server: string; tool: string } | null
  }> = [
    { name: "mcp__github__create_issue", expected: { server: "github", tool: "create_issue" } },
    { name: "mcp__playwright__browser_navigate", expected: { server: "playwright", tool: "browser_navigate" } },
    { name: "mcp__sentry__list_issues", expected: { server: "sentry", tool: "list_issues" } },
    { name: "mcp__server__ns__tool", expected: { server: "server", tool: "ns__tool" } },
    { name: "mcp__server", expected: { server: "server", tool: "" } },
    { name: "mcp__", expected: { server: "unknown", tool: "" } },
    { name: "Read", expected: null },
    { name: "", expected: null },
    { name: "other_prefix__foo__bar", expected: null },
  ]

  for (const { name, expected } of cases) {
    it(`parses ${JSON.stringify(name)}`, () => {
      expect(parseMcpName(name)).toEqual(expected)
    })
  }
})

describe("classifyTool — direct resolvers", () => {
  const cases: Array<{
    label: string
    name: string
    input: Record<string, unknown>
    expected: ClassifiedTool
  }> = [
    {
      label: "Read with file_path",
      name: "Read",
      input: { file_path: "/workspace/src/index.ts" },
      expected: { kind: "read", title: "Read file", subtitle: "/workspace/src/index.ts" },
    },
    {
      label: "Read falls back to path",
      name: "Read",
      input: { path: "README.md" },
      expected: { kind: "read", title: "Read file", subtitle: "README.md" },
    },
    {
      label: "Read without any path key",
      name: "Read",
      input: {},
      expected: { kind: "read", title: "Read file" },
    },
    {
      label: "Write",
      name: "Write",
      input: { file_path: "out.txt" },
      expected: { kind: "write", title: "Write file", subtitle: "out.txt" },
    },
    {
      label: "Edit",
      name: "Edit",
      input: { filePath: "foo.ts" },
      expected: { kind: "edit", title: "Edit file", subtitle: "foo.ts" },
    },
    {
      label: "MultiEdit",
      name: "MultiEdit",
      input: { target_file: "x.md" },
      expected: { kind: "edit", title: "Edit file (multi)", subtitle: "x.md" },
    },
    {
      label: "NotebookEdit prefers notebook_path",
      name: "NotebookEdit",
      input: { notebook_path: "nb.ipynb", file_path: "ignored.ipynb" },
      expected: { kind: "notebook", title: "Edit notebook", subtitle: "nb.ipynb" },
    },
    {
      label: "NotebookEdit falls back to file_path",
      name: "NotebookEdit",
      input: { file_path: "nb.ipynb" },
      expected: { kind: "notebook", title: "Edit notebook", subtitle: "nb.ipynb" },
    },
    {
      label: "Bash with command",
      name: "Bash",
      input: { command: "npm test" },
      expected: { kind: "bash", title: "Run command", subtitle: "npm test" },
    },
    {
      label: "Bash falls back to cmd",
      name: "Bash",
      input: { cmd: "ls" },
      expected: { kind: "bash", title: "Run command", subtitle: "ls" },
    },
    {
      label: "BashOutput has no subtitle",
      name: "BashOutput",
      input: { bash_id: "shell_1" },
      expected: { kind: "bash", title: "Read background output" },
    },
    {
      label: "KillShell",
      name: "KillShell",
      input: {},
      expected: { kind: "bash", title: "Kill background shell" },
    },
    {
      label: "KillBash alias",
      name: "KillBash",
      input: {},
      expected: { kind: "bash", title: "Kill background shell" },
    },
    {
      label: "Grep with pattern",
      name: "Grep",
      input: { pattern: "TODO" },
      expected: { kind: "search", title: "Search", subtitle: "TODO" },
    },
    {
      label: "Grep falls back to query",
      name: "Grep",
      input: { query: "needle" },
      expected: { kind: "search", title: "Search", subtitle: "needle" },
    },
    {
      label: "Glob with pattern",
      name: "Glob",
      input: { pattern: "src/**/*.ts" },
      expected: { kind: "glob", title: "List files", subtitle: "src/**/*.ts" },
    },
    {
      label: "Glob falls back to path",
      name: "Glob",
      input: { path: "src/" },
      expected: { kind: "glob", title: "List files", subtitle: "src/" },
    },
    {
      label: "WebFetch with url",
      name: "WebFetch",
      input: { url: "https://example.com" },
      expected: { kind: "web_fetch", title: "Fetch URL", subtitle: "https://example.com" },
    },
    {
      label: "WebSearch with query",
      name: "WebSearch",
      input: { query: "claude sdk" },
      expected: { kind: "web_search", title: "Web search", subtitle: "claude sdk" },
    },
    {
      label: "Task with description",
      name: "Task",
      input: { description: "Investigate bug", subagent_type: "explorer" },
      expected: { kind: "task", title: "Delegate to agent", subtitle: "Investigate bug" },
    },
    {
      label: "Task falls back to subagent_type",
      name: "Task",
      input: { subagent_type: "planner" },
      expected: { kind: "task", title: "Delegate to agent", subtitle: "planner" },
    },
    {
      label: "TodoWrite",
      name: "TodoWrite",
      input: { todos: [] },
      expected: { kind: "todo", title: "Update todo list" },
    },
    // Goose aliases
    {
      label: "Goose read_file",
      name: "read_file",
      input: { path: "foo.py" },
      expected: { kind: "read", title: "Read file", subtitle: "foo.py" },
    },
    {
      label: "Goose write_file",
      name: "write_file",
      input: { path: "out.py" },
      expected: { kind: "write", title: "Write file", subtitle: "out.py" },
    },
    {
      label: "Goose edit_file",
      name: "edit_file",
      input: { path: "mod.py" },
      expected: { kind: "edit", title: "Edit file", subtitle: "mod.py" },
    },
    {
      label: "Goose shell",
      name: "shell",
      input: { command: "pytest" },
      expected: { kind: "bash", title: "Run command", subtitle: "pytest" },
    },
    {
      label: "Goose list_directory",
      name: "list_directory",
      input: { path: "src" },
      expected: { kind: "glob", title: "List directory", subtitle: "src" },
    },
    {
      label: "Goose search",
      name: "search",
      input: { pattern: "def run" },
      expected: { kind: "search", title: "Search", subtitle: "def run" },
    },
  ]

  for (const { label, name, input, expected } of cases) {
    it(label, () => {
      expect(classifyTool(name, input)).toEqual(expected)
    })
  }
})

describe("classifyTool — MCP tools", () => {
  it("classifies github MCP with repo/owner subtitle", () => {
    const out = classifyTool("mcp__github__create_issue", { owner: "foo", repo: "bar" })
    expect(out.kind).toBe("mcp")
    expect(out.title).toBe("github · create issue")
    // owner comes after repo in the subtitle keys; repo wins
    expect(out.subtitle).toBe("bar")
  })

  it("uses pull_number when no url", () => {
    const out = classifyTool("mcp__github__get_pr", { pull_number: "42" })
    expect(out.subtitle).toBe("42")
  })

  it("prefers url over other keys", () => {
    const out = classifyTool("mcp__github__fetch", {
      url: "https://api.github.com",
      query: "q",
    })
    expect(out.subtitle).toBe("https://api.github.com")
  })

  it("sentry server renders as mcp", () => {
    const out = classifyTool("mcp__sentry__list_issues", { project: "server" })
    expect(out.kind).toBe("mcp")
    expect(out.title).toBe("sentry · list issues")
    expect(out.subtitle).toBe("server")
  })

  it("falls back to mcp when no args match", () => {
    const out = classifyTool("mcp__context7__resolve-library-id", { libraryName: "react" })
    expect(out.kind).toBe("mcp")
    expect(out.title).toBe("context7 · resolve-library-id")
    expect(out.subtitle).toBeUndefined()
  })
})

describe("classifyTool — browser tools", () => {
  it("classifies playwright navigate as browser", () => {
    const out = classifyTool("mcp__playwright__browser_navigate", { url: "https://a.test" })
    expect(out.kind).toBe("browser")
    expect(out.title).toBe("Browser · navigate")
    expect(out.subtitle).toBe("https://a.test")
  })

  it("classifies playwright screenshot with special title", () => {
    const out = classifyTool("mcp__playwright__browser_take_screenshot", { filename: "shot.png" })
    expect(out.kind).toBe("browser")
    expect(out.title).toBe("Browser screenshot")
    expect(out.subtitle).toBe("shot.png")
  })

  it("classifies bare browser_ names", () => {
    const out = classifyTool("browser_click", { selector: "button.primary" })
    expect(out.kind).toBe("browser")
    expect(out.title).toBe("Browser · click")
    expect(out.subtitle).toBe("button.primary")
  })

  it("classifies any mcp__playwright__ tool as browser even without browser_ prefix", () => {
    const out = classifyTool("mcp__playwright__custom_action", { ref: "abc" })
    expect(out.kind).toBe("browser")
    expect(out.title).toBe("Browser · custom action")
    expect(out.subtitle).toBe("abc")
  })

  it("recognises non-playwright MCPs exposing browser_ tools", () => {
    const out = classifyTool("mcp__chromium__browser_close", {})
    expect(out.kind).toBe("browser")
    expect(out.title).toBe("Browser · close")
  })
})

describe("classifyTool — fallbacks and edge cases", () => {
  it("falls back to other for unknown names", () => {
    const out = classifyTool("MysteryTool", { foo: 1 })
    expect(out.kind).toBe("other")
    expect(out.title).toBe("MysteryTool")
    expect(out.subtitle).toBeUndefined()
  })

  it("uses 'unknown' placeholder for empty name", () => {
    const out = classifyTool("", {})
    expect(out.kind).toBe("other")
    expect(out.title).toBe("unknown")
  })

  it("handles non-object input (string)", () => {
    const out = classifyTool("Read", "not-an-object")
    expect(out.kind).toBe("read")
    expect(out.title).toBe("Read file")
    expect(out.subtitle).toBeUndefined()
  })

  it("handles non-object input (array)", () => {
    const out = classifyTool("Bash", ["ls", "-la"])
    expect(out.kind).toBe("bash")
    expect(out.subtitle).toBeUndefined()
  })

  it("handles null input", () => {
    const out = classifyTool("Grep", null)
    expect(out.kind).toBe("search")
    expect(out.subtitle).toBeUndefined()
  })

  it("ignores non-string subtitle candidates", () => {
    const out = classifyTool("Read", { file_path: 42, path: "fallback.ts" })
    expect(out.subtitle).toBe("fallback.ts")
  })

  it("ignores empty string subtitle candidates", () => {
    const out = classifyTool("Bash", { command: "", cmd: "echo hi" })
    expect(out.subtitle).toBe("echo hi")
  })

  it("truncates subtitles longer than MAX_SUBTITLE", () => {
    const long = "a".repeat(200)
    const out = classifyTool("Bash", { command: long })
    expect(out.subtitle).toBeDefined()
    expect(out.subtitle!.length).toBeLessThanOrEqual(120)
    expect(out.subtitle!.endsWith("…")).toBe(true)
  })

  it("leaves subtitles shorter than MAX_SUBTITLE untouched", () => {
    const out = classifyTool("Bash", { command: "short" })
    expect(out.subtitle).toBe("short")
  })
})

describe("buildToolCallSummary", () => {
  it("builds a summary with classified fields", () => {
    const summary = buildToolCallSummary("tool_1", "Read", { file_path: "a.ts" })
    expect(summary).toEqual({
      toolUseId: "tool_1",
      name: "Read",
      kind: "read",
      title: "Read file",
      subtitle: "a.ts",
      input: { file_path: "a.ts" },
    })
  })

  it("normalises input when the tool receives a non-object", () => {
    const summary = buildToolCallSummary("t", "Bash", null)
    expect(summary.input).toEqual({})
    expect(summary.kind).toBe("bash")
  })

  it("falls back to 'unknown' when name is empty", () => {
    const summary = buildToolCallSummary("t", "", {})
    expect(summary.name).toBe("unknown")
    expect(summary.kind).toBe("other")
    expect(summary.title).toBe("unknown")
  })

  it("attaches parentToolUseId when provided", () => {
    const summary = buildToolCallSummary("inner", "Read", { file_path: "a" }, {
      parentToolUseId: "outer",
    })
    expect(summary.parentToolUseId).toBe("outer")
  })

  it("omits parentToolUseId when not provided", () => {
    const summary = buildToolCallSummary("t", "Read", {})
    expect(summary.parentToolUseId).toBeUndefined()
  })

  it("omits subtitle when classifier produces none", () => {
    const summary = buildToolCallSummary("t", "TodoWrite", { todos: [] })
    expect(summary.subtitle).toBeUndefined()
    expect(summary.title).toBe("Update todo list")
  })
})

describe("buildToolResultPayload — text extraction", () => {
  it("extracts plain string results", () => {
    const payload = buildToolResultPayload("hello world")
    expect(payload).toEqual({ status: "ok", text: "hello world" })
  })

  it("extracts Anthropic-style content block arrays", () => {
    const payload = buildToolResultPayload([
      { type: "text", text: "line 1" },
      { type: "text", text: "line 2" },
    ])
    expect(payload.text).toBe("line 1\nline 2")
    expect(payload.status).toBe("ok")
  })

  it("extracts MCP-style { content: [...] } wrappers", () => {
    const payload = buildToolResultPayload({
      content: [{ type: "text", text: "ok" }],
    })
    expect(payload.text).toBe("ok")
  })

  it("extracts resource blocks by text", () => {
    const payload = buildToolResultPayload({
      type: "resource",
      resource: { text: "resource body" },
    })
    expect(payload.text).toBe("resource body")
  })

  it("extracts resource blocks by uri when no text", () => {
    const payload = buildToolResultPayload({
      type: "resource",
      resource: { uri: "file:///tmp/x" },
    })
    expect(payload.text).toBe("file:///tmp/x")
  })

  it("coerces numbers and booleans to strings", () => {
    const payload = buildToolResultPayload([42, true])
    expect(payload.text).toBe("42\ntrue")
  })

  it("skips empty strings", () => {
    const payload = buildToolResultPayload(["", "kept"])
    expect(payload.text).toBe("kept")
  })

  it("omits text when no strings are found", () => {
    const payload = buildToolResultPayload({})
    expect(payload.text).toBeUndefined()
    expect(payload.status).toBe("ok")
  })

  it("handles null / undefined input", () => {
    expect(buildToolResultPayload(null).text).toBeUndefined()
    expect(buildToolResultPayload(undefined).text).toBeUndefined()
  })

  it("picks up stdout and stderr fields", () => {
    const payload = buildToolResultPayload({ stdout: "out", stderr: "err" })
    expect(payload.text).toContain("out")
    expect(payload.text).toContain("err")
  })

  it("marks provider is_error payloads as error and echoes the message", () => {
    const payload = buildToolResultPayload({ is_error: true, error: "bad" })
    expect(payload.status).toBe("error")
    expect(payload.error).toBe("bad")
  })

  it("also honours camelCase isError marker", () => {
    const payload = buildToolResultPayload({ isError: true, text: "boom" })
    expect(payload.status).toBe("error")
  })
})

describe("buildToolResultPayload — images", () => {
  it("emits data URIs from base64 + mimeType", () => {
    const payload = buildToolResultPayload([
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
    ])
    expect(payload.images).toEqual(["data:image/jpeg;base64,AAAA"])
  })

  it("defaults mimeType to image/png", () => {
    const payload = buildToolResultPayload([{ type: "image", data: "BBBB" }])
    expect(payload.images).toEqual(["data:image/png;base64,BBBB"])
  })

  it("uses source.url when provided", () => {
    const payload = buildToolResultPayload([
      { type: "image", source: { url: "https://img.test/a.png" } },
    ])
    expect(payload.images).toEqual(["https://img.test/a.png"])
  })

  it("uses source.data + source.media_type", () => {
    const payload = buildToolResultPayload([
      { type: "image", source: { data: "CCCC", media_type: "image/webp" } },
    ])
    expect(payload.images).toEqual(["data:image/webp;base64,CCCC"])
  })

  it("accepts path-style image references", () => {
    const payload = buildToolResultPayload([{ type: "image", path: "/tmp/shot.png" }])
    expect(payload.images).toEqual(["/tmp/shot.png"])
  })

  it("accepts url-style image references", () => {
    const payload = buildToolResultPayload([{ type: "image", url: "https://cdn/shot.png" }])
    expect(payload.images).toEqual(["https://cdn/shot.png"])
  })

  it("collects multiple images", () => {
    const payload = buildToolResultPayload([
      { type: "image", data: "A" },
      { type: "image", data: "B" },
    ])
    expect(payload.images).toHaveLength(2)
  })
})

describe("buildToolResultPayload — meta extraction", () => {
  it("captures exitCode (camelCase)", () => {
    const payload = buildToolResultPayload({ exitCode: 1, stdout: "x" })
    expect(payload.meta?.exitCode).toBe(1)
  })

  it("captures exit_code (snake_case)", () => {
    const payload = buildToolResultPayload({ exit_code: 2 })
    expect(payload.meta?.exitCode).toBe(2)
  })

  it("captures cwd and mode", () => {
    const payload = buildToolResultPayload({ cwd: "/work", mode: "0644", stdout: "ok" })
    expect(payload.meta?.cwd).toBe("/work")
    expect(payload.meta?.mode).toBe("0644")
  })

  it("captures url at the top level", () => {
    const payload = buildToolResultPayload({ url: "https://x.test", stdout: "body" })
    expect(payload.meta?.url).toBe("https://x.test")
  })

  it("omits meta entirely when nothing structured is present", () => {
    const payload = buildToolResultPayload("hello")
    expect(payload.meta).toBeUndefined()
  })
})

describe("buildToolResultPayload — format detection", () => {
  it("detects unified diff output", () => {
    const payload = buildToolResultPayload("diff --git a/x b/x\n@@ -1,1 +1,1 @@\n-a\n+b")
    expect(payload.format).toBe("diff")
  })

  it("detects JSON payloads", () => {
    const payload = buildToolResultPayload('{"ok":true}')
    expect(payload.format).toBe("json")
  })

  it("leaves invalid-JSON curly text as text", () => {
    const payload = buildToolResultPayload("{ not json")
    expect(payload.format).toBeUndefined()
  })

  it("applies markdown hint for web fetches", () => {
    const payload = buildToolResultPayload("# Heading\nbody", { toolName: "WebFetch" })
    expect(payload.format).toBe("markdown")
  })

  it("applies markdown hint for web searches", () => {
    const payload = buildToolResultPayload("results…", { toolName: "WebSearch" })
    expect(payload.format).toBe("markdown")
  })

  it("uses plain text (no format) for ordinary output", () => {
    const payload = buildToolResultPayload("plain output")
    expect(payload.format).toBeUndefined()
  })
})

describe("buildToolResultPayload — truncation", () => {
  const { fileBytes, bashBytes } = TRANSCRIPT_TRUNCATION_BUDGET

  it("leaves payloads under budget untouched", () => {
    const text = "a".repeat(100)
    const payload = buildToolResultPayload(text, { toolName: "Read" })
    expect(payload.truncated).toBeUndefined()
    expect(payload.originalBytes).toBeUndefined()
    expect(payload.text).toBe(text)
  })

  it("truncates file reads to fileBytes", () => {
    const text = "a".repeat(fileBytes + 100)
    const payload = buildToolResultPayload(text, { toolName: "Read" })
    expect(payload.truncated).toBe(true)
    expect(payload.originalBytes).toBe(fileBytes + 100)
    expect(payload.text!.endsWith("…[truncated]")).toBe(true)
    expect(Buffer.byteLength(payload.text!.replace(/\n…\[truncated\]$/, ""), "utf8")).toBeLessThanOrEqual(fileBytes)
  })

  it("truncates bash output to bashBytes (larger)", () => {
    const text = "b".repeat(bashBytes + 100)
    const payload = buildToolResultPayload(text, { toolName: "Bash" })
    expect(payload.truncated).toBe(true)
    expect(payload.originalBytes).toBe(bashBytes + 100)
    const body = payload.text!.replace(/\n…\[truncated\]$/, "")
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(bashBytes)
  })

  it("does not truncate bash output below bashBytes but above fileBytes", () => {
    const text = "c".repeat(fileBytes + 100)
    const payload = buildToolResultPayload(text, { toolName: "Bash" })
    expect(payload.truncated).toBeUndefined()
    expect(payload.text!.length).toBe(fileBytes + 100)
  })

  it("respects a caller-supplied budget", () => {
    const text = "x".repeat(200)
    const payload = buildToolResultPayload(text, {
      toolName: "Read",
      budget: { fileBytes: 50, bashBytes: 100, totalEventBytes: 1000 },
    })
    expect(payload.truncated).toBe(true)
    const body = payload.text!.replace(/\n…\[truncated\]$/, "")
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(50)
  })

  it("truncates multi-byte UTF-8 correctly without exceeding the byte budget", () => {
    const text = "€".repeat(100) // 3 bytes per char
    const payload = buildToolResultPayload(text, {
      toolName: "Read",
      budget: { fileBytes: 30, bashBytes: 100, totalEventBytes: 1000 },
    })
    expect(payload.truncated).toBe(true)
    const body = payload.text!.replace(/\n…\[truncated\]$/, "")
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(30)
  })
})

describe("buildToolResultPayload — status overrides", () => {
  it("forces error status when options.status is set", () => {
    const payload = buildToolResultPayload("fine", { status: "error" })
    expect(payload.status).toBe("error")
    expect(payload.error).toBe("fine")
  })

  it("uses an explicit error message when provided", () => {
    const payload = buildToolResultPayload("detail", {
      status: "error",
      error: "ENOENT: no such file",
    })
    expect(payload.error).toBe("ENOENT: no such file")
  })

  it("keeps ok status when no error markers are present", () => {
    const payload = buildToolResultPayload("done")
    expect(payload.status).toBe("ok")
    expect(payload.error).toBeUndefined()
  })

  it("truncates long provider error text to 500 chars in payload.error", () => {
    const long = "z".repeat(1000)
    const payload = buildToolResultPayload({ is_error: true, text: long })
    expect(payload.status).toBe("error")
    expect(payload.error).toBeDefined()
    expect(payload.error!.length).toBeLessThanOrEqual(500)
  })

  it("omits error when status is error but no text is available", () => {
    const payload = buildToolResultPayload({}, { status: "error" })
    expect(payload.status).toBe("error")
    expect(payload.error).toBeUndefined()
  })
})

describe("buildToolResultPayload — toolName → kind integration", () => {
  const cases: Array<{ name: string; expectedBudgetKind: ToolKind }> = [
    { name: "Read", expectedBudgetKind: "read" },
    { name: "Write", expectedBudgetKind: "write" },
    { name: "Edit", expectedBudgetKind: "edit" },
    { name: "NotebookEdit", expectedBudgetKind: "notebook" },
    { name: "Bash", expectedBudgetKind: "bash" },
    { name: "WebFetch", expectedBudgetKind: "web_fetch" },
    { name: "WebSearch", expectedBudgetKind: "web_search" },
    { name: "Grep", expectedBudgetKind: "search" },
    { name: "Glob", expectedBudgetKind: "glob" },
  ]

  for (const { name, expectedBudgetKind } of cases) {
    it(`routes ${name} through the correct kind for budget selection`, () => {
      // Sanity: classifier returns the expected kind for this name.
      expect(classifyTool(name, {}).kind).toBe(expectedBudgetKind)
      // And the payload builder accepts the name without error.
      const payload = buildToolResultPayload("body", { toolName: name })
      expect(payload.status).toBe("ok")
      expect(payload.text).toBe("body")
    })
  }

  it("defaults to the file budget when no toolName is provided", () => {
    const text = "y".repeat(TRANSCRIPT_TRUNCATION_BUDGET.fileBytes + 10)
    const payload = buildToolResultPayload(text)
    expect(payload.truncated).toBe(true)
  })
})
