import { describe, it, expect } from "vitest";
import {
  esc,
  truncate,
  formatToolLine,
  formatActivityLog,
  formatToolActivity,
  formatSessionStart,
  formatSessionComplete,
  formatSessionError,
  formatSessionInterrupted,
} from "../../src/telegram/format.js";

describe("esc", () => {
  it("escapes ampersands, angle brackets", () => {
    expect(esc("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("returns empty string unchanged", () => {
    expect(esc("")).toBe("");
  });

  it("leaves clean strings unchanged", () => {
    expect(esc("hello world")).toBe("hello world");
  });
});

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("short", 10)).toBe("short");
  });

  it("truncates and adds ellipsis", () => {
    const result = truncate("a very long string here", 10);
    expect(result.length).toBeLessThanOrEqual(11); // 10 + ellipsis char
    expect(result).toContain("…");
  });

  it("trims trailing whitespace before ellipsis", () => {
    const result = truncate("hello     world beyond", 10);
    expect(result).not.toMatch(/\s…$/);
  });

  it("returns exact-length strings unchanged", () => {
    expect(truncate("12345", 5)).toBe("12345");
  });
});

describe("formatToolLine", () => {
  it("formats Bash tool with command summary", () => {
    const result = formatToolLine("Bash", { command: "npm test" });
    expect(result).toContain("💻");
    expect(result).toContain("npm test");
  });

  it("formats Read tool with file path", () => {
    const result = formatToolLine("Read", { file_path: "/src/index.ts" });
    expect(result).toContain("📖");
    expect(result).toContain("/src/index.ts");
  });

  it("formats Write tool with file path", () => {
    const result = formatToolLine("Write", { file_path: "/src/new.ts" });
    expect(result).toContain("✏️");
    expect(result).toContain("/src/new.ts");
  });

  it("formats Grep tool with pattern", () => {
    const result = formatToolLine("Grep", { pattern: "TODO" });
    expect(result).toContain("🔍");
    expect(result).toContain("TODO");
  });

  it("formats Glob tool with pattern", () => {
    const result = formatToolLine("Glob", { pattern: "src/**/*.ts" });
    expect(result).toContain("📂");
    expect(result).toContain("src/**/*.ts");
  });

  it("formats WebSearch with query", () => {
    const result = formatToolLine("WebSearch", { query: "vitest docs" });
    expect(result).toContain("🌐");
    expect(result).toContain("vitest docs");
  });

  it("formats WebFetch with url", () => {
    const result = formatToolLine("WebFetch", { url: "https://example.com" });
    expect(result).toContain("🌐");
    expect(result).toContain("https://example.com");
  });

  it("falls back to tool name for unknown tools", () => {
    const result = formatToolLine("UnknownTool", {});
    expect(result).toContain("🔧");
    expect(result).toContain("UnknownTool");
  });

  it("escapes HTML in args", () => {
    const result = formatToolLine("Bash", { command: "echo <b>hi</b>" });
    expect(result).toContain("&lt;b&gt;");
    expect(result).not.toContain("<b>");
  });
});

describe("formatActivityLog", () => {
  it("formats header with tool count", () => {
    const result = formatActivityLog(["line1", "line2"], 5);
    expect(result).toContain("5 tools");
    expect(result).toContain("line1");
    expect(result).toContain("line2");
  });

  it("uses singular for 1 tool", () => {
    const result = formatActivityLog(["line1"], 1);
    expect(result).toContain("1 tool");
    expect(result).not.toContain("1 tools");
  });
});

describe("formatToolActivity", () => {
  it("includes tool count when > 1", () => {
    const result = formatToolActivity("Bash", { command: "ls" }, 3);
    expect(result).toContain("(3 tools)");
  });

  it("omits tool count when 1", () => {
    const result = formatToolActivity("Bash", { command: "ls" }, 1);
    expect(result).not.toContain("(1 tool");
  });
});

describe("formatSessionStart", () => {
  it("includes repo, slug, and task", () => {
    const result = formatSessionStart("my-repo", "abc123", "Fix the bug");
    expect(result).toContain("my-repo");
    expect(result).toContain("abc123");
    expect(result).toContain("Fix the bug");
    expect(result).toContain("Session started");
  });

  it("escapes HTML in task text", () => {
    const result = formatSessionStart("repo", "s1", "use <script> tag");
    expect(result).toContain("&lt;script&gt;");
  });
});

describe("formatSessionComplete", () => {
  it("formats duration in seconds", () => {
    const result = formatSessionComplete("s1", 45_000, null);
    expect(result).toContain("45s");
    expect(result).toContain("Complete");
  });

  it("formats duration in minutes and seconds", () => {
    const result = formatSessionComplete("s1", 125_000, null);
    expect(result).toContain("2m 5s");
  });

  it("includes token count when provided", () => {
    const result = formatSessionComplete("s1", 10_000, 5000);
    expect(result).toContain("5,000 tokens");
  });

  it("omits token count when null", () => {
    const result = formatSessionComplete("s1", 10_000, null);
    expect(result).not.toContain("tokens");
  });

  it("includes tool count when provided", () => {
    const result = formatSessionComplete("s1", 10_000, null, 7);
    expect(result).toContain("7 tools");
  });
});

describe("formatSessionError", () => {
  it("includes slug and error message", () => {
    const result = formatSessionError("s1", "something broke");
    expect(result).toContain("s1");
    expect(result).toContain("something broke");
    expect(result).toContain("Error");
  });
});

describe("formatSessionInterrupted", () => {
  it("includes slug and interrupted message", () => {
    const result = formatSessionInterrupted("s1");
    expect(result).toContain("s1");
    expect(result).toContain("interrupted");
  });
});
