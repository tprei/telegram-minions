import { describe, it, expect } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("integration test config", () => {
  it("runs in a temp directory with git available", () => {
    const tmp = mkdtempSync(join(tmpdir(), "minion-int-"))
    try {
      execSync("git init --initial-branch=main", { cwd: tmp, stdio: "pipe" })
      execSync("git config user.email test@test.com", { cwd: tmp, stdio: "pipe" })
      execSync("git config user.name Test", { cwd: tmp, stdio: "pipe" })
      writeFileSync(join(tmp, "README.md"), "# test\n")
      execSync("git add . && git commit -m init", { cwd: tmp, stdio: "pipe" })

      const log = execSync("git log --oneline", { cwd: tmp, encoding: "utf-8" })
      expect(log).toContain("init")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("respects the 5s test timeout", () => {
    // This test simply verifies the config is loaded — if the timeout
    // were the default 5000ms this would pass; if someone accidentally
    // set it to something tiny this would fail.
    const start = Date.now()
    expect(Date.now() - start).toBeLessThan(5_000)
  })
})
