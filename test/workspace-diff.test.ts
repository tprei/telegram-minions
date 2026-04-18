import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { computeWorkspaceDiff } from "../src/session/workspace-diff.js"

const execFile = promisify(execFileCb)

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "tester",
      GIT_AUTHOR_EMAIL: "tester@example.com",
      GIT_COMMITTER_NAME: "tester",
      GIT_COMMITTER_EMAIL: "tester@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  })
}

describe("computeWorkspaceDiff", () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-diff-"))
    await git(dir, "init", "--initial-branch=main")
    await fs.writeFile(path.join(dir, "README.md"), "initial\n")
    await git(dir, "add", ".")
    await git(dir, "commit", "-m", "init")
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("returns an empty patch when the tree is clean", async () => {
    const result = await computeWorkspaceDiff(dir)
    expect(result.patch).toBe("")
    expect(result.base).toBe("main")
    expect(result.truncated).toBe(false)
  })

  it("reports uncommitted changes against the base", async () => {
    await fs.writeFile(path.join(dir, "README.md"), "initial\nchanged\n")
    const result = await computeWorkspaceDiff(dir)
    expect(result.patch).toContain("+changed")
    expect(result.base).toBe("main")
  })

  it("diffs the feature branch against main when a main ref exists", async () => {
    await git(dir, "checkout", "-b", "minion/test")
    await fs.writeFile(path.join(dir, "feature.txt"), "hello\n")
    await git(dir, "add", ".")
    await git(dir, "commit", "-m", "feature")

    const result = await computeWorkspaceDiff(dir, "minion/test")
    expect(result.base).toBe("main")
    expect(result.head).toBe("minion/test")
    expect(result.patch).toContain("+hello")
    expect(result.patch).toContain("feature.txt")
  })
})
