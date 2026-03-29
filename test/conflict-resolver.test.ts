import { describe, it, expect } from "vitest"
import { buildConflictResolutionPrompt } from "../src/conflict-resolver.js"

describe("buildConflictResolutionPrompt", () => {
  it("includes branch names and conflict files", () => {
    const prompt = buildConflictResolutionPrompt(
      "minion/feature",
      "main",
      ["src/auth.ts", "src/config.ts"],
    )

    expect(prompt).toContain("minion/feature")
    expect(prompt).toContain("main")
    expect(prompt).toContain("src/auth.ts")
    expect(prompt).toContain("src/config.ts")
  })

  it("includes resolution instructions", () => {
    const prompt = buildConflictResolutionPrompt("feat", "main", ["file.ts"])

    expect(prompt).toContain("git add")
    expect(prompt).toContain("conflict markers")
    expect(prompt).toContain("Do NOT run `git rebase --continue`")
  })

  it("lists all conflict files", () => {
    const files = ["a.ts", "b.ts", "c.ts"]
    const prompt = buildConflictResolutionPrompt("feat", "main", files)

    for (const f of files) {
      expect(prompt).toContain(f)
    }
  })
})
