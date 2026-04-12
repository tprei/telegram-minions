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
  formatThinkStart,
  formatThinkIteration,
  formatThinkComplete,
  formatDagAnalyzing,
  formatDoctorAnalyzing,
  formatDagStart,
  formatDagNodeSkipped,
  formatDagAllDone,
  formatDagCIWaiting,
  formatDagCIFailed,
  formatDagForceAdvance,
  formatStackAnalyzing,
  formatProfileList,
  formatConfigHelp,
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

describe("formatThinkStart", () => {
  it("includes repo, slug, and task", () => {
    const result = formatThinkStart("my-repo", "abc", "Investigate the issue");
    expect(result).toContain("my-repo");
    expect(result).toContain("abc");
    expect(result).toContain("Investigate the issue");
    expect(result).toContain("Deep research started");
  });

  it("escapes HTML in task text", () => {
    const result = formatThinkStart("repo", "s1", "check <script>");
    expect(result).toContain("&lt;script&gt;");
  });
});

describe("formatThinkIteration", () => {
  it("includes slug and iteration number", () => {
    const result = formatThinkIteration("abc", 3);
    expect(result).toContain("abc");
    expect(result).toContain("iteration 3");
    expect(result).toContain("Thinking deeper");
  });
});

describe("formatThinkComplete", () => {
  it("includes slug and reply instructions", () => {
    const result = formatThinkComplete("abc");
    expect(result).toContain("abc");
    expect(result).toContain("Research complete");
    expect(result).toContain("/reply");
  });
});

describe("formatDagAnalyzing", () => {
  it("includes slug", () => {
    const result = formatDagAnalyzing("dag-slug");
    expect(result).toContain("dag-slug");
    expect(result).toContain("Analyzing conversation");
  });
});

describe("formatDoctorAnalyzing", () => {
  it("includes slug", () => {
    const result = formatDoctorAnalyzing("doc-slug");
    expect(result).toContain("doc-slug");
    expect(result).toContain("Diagnosing");
  });
});

describe("formatStackAnalyzing", () => {
  it("includes slug", () => {
    const result = formatStackAnalyzing("stk-slug");
    expect(result).toContain("stk-slug");
    expect(result).toContain("Analyzing conversation");
    expect(result).toContain("stacked PRs");
  });
});

describe("formatDagStart", () => {
  it("formats DAG mode with dependencies", () => {
    const children = [
      { slug: "a", title: "Task A", dependsOn: [] },
      { slug: "b", title: "Task B", dependsOn: ["a"] },
    ];
    const result = formatDagStart("parent", children, false);
    expect(result).toContain("DAG: 2 tasks");
    expect(result).toContain("Task A");
    expect(result).toContain("Task B");
    expect(result).toContain("← a");
    expect(result).toContain("parallel");
  });

  it("formats Stack mode with sequential note", () => {
    const children = [{ slug: "a", title: "Task A", dependsOn: [] }];
    const result = formatDagStart("parent", children, true);
    expect(result).toContain("Stack: 1 tasks");
    expect(result).toContain("sequentially");
  });
});

describe("formatDagNodeSkipped", () => {
  it("includes title and reason", () => {
    const result = formatDagNodeSkipped("Node X", "dependency failed");
    expect(result).toContain("Skipped");
    expect(result).toContain("Node X");
    expect(result).toContain("dependency failed");
  });
});

describe("formatDagAllDone", () => {
  it("shows succeeded/total without failures", () => {
    const result = formatDagAllDone(3, 3, 0);
    expect(result).toContain("3/3 succeeded");
    expect(result).not.toContain("failed");
  });

  it("shows failure count when present", () => {
    const result = formatDagAllDone(2, 3, 1);
    expect(result).toContain("2/3 succeeded");
    expect(result).toContain("1 failed");
  });
});

describe("formatDagCIWaiting", () => {
  it("includes slug, title, and PR link", () => {
    const result = formatDagCIWaiting("s1", "Build API", "https://github.com/o/r/pull/1");
    expect(result).toContain("s1");
    expect(result).toContain("Build API");
    expect(result).toContain("https://github.com/o/r/pull/1");
    expect(result).toContain("waiting for CI");
  });
});

describe("formatDagCIFailed", () => {
  it("shows block message for block policy", () => {
    const result = formatDagCIFailed("s1", "Build API", "https://github.com/o/r/pull/1", "block");
    expect(result).toContain("CI failed");
    expect(result).toContain("Dependents blocked");
    expect(result).toContain("/force");
  });

  it("shows proceed message for non-block policy", () => {
    const result = formatDagCIFailed("s1", "Build API", "https://github.com/o/r/pull/1", "warn");
    expect(result).toContain("CI failed");
    expect(result).toContain("Proceeding with dependents");
    expect(result).toContain("warn");
  });
});

describe("formatDagForceAdvance", () => {
  it("includes title and nodeId", () => {
    const result = formatDagForceAdvance("Build API", "node-1");
    expect(result).toContain("Force-advancing");
    expect(result).toContain("Build API");
    expect(result).toContain("node-1");
  });
});

describe("formatProfileList", () => {
  it("lists profiles with default marker", () => {
    const profiles = [
      { id: "p1", name: "Profile 1" },
      { id: "p2", name: "Profile 2", baseUrl: "https://api.example.com" },
    ];
    const result = formatProfileList(profiles, "p2");
    expect(result).toContain("p1");
    expect(result).toContain("Profile 1");
    expect(result).toContain("p2");
    expect(result).toContain("https://api.example.com");
    expect(result).toContain("⭐");
  });

  it("omits star when no default", () => {
    const profiles = [{ id: "p1", name: "Profile 1" }];
    const result = formatProfileList(profiles);
    expect(result).not.toContain("⭐");
  });
});

describe("formatConfigHelp", () => {
  it("includes config command reference", () => {
    const result = formatConfigHelp();
    expect(result).toContain("Config commands");
    expect(result).toContain("/config");
    expect(result).toContain("/config default");
    expect(result).toContain("/config add");
    expect(result).toContain("/config remove");
  });
});
