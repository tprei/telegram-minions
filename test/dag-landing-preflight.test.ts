import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { cherryPickRange, runPreflightStaging } from "../src/dag/preflight.js"
import type { DagGraph, DagNode } from "../src/dag/dag.js"

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function writeFile(cwd: string, relPath: string, content: string): void {
  const abs = path.join(cwd, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

/**
 * Set up a "remote" bare repository and a "local" bare-clone + worktree layout
 * matching production (where repos are cloned with `git clone --bare` and a
 * custom fetch refspec `+refs/heads/*:refs/heads/*`). Under this layout,
 * `origin/<branch>` refs do NOT exist — branches are stored directly as
 * `refs/heads/*`.
 *
 *   master ── m1 ── m2
 *             │
 *             minion/a ── a1 ── a2
 *             │
 *             minion/b ── b1  (either compatible or conflicting with a)
 */
function setupFixture(conflicting: boolean): { localCwd: string; graph: DagGraph; nodes: DagNode[] } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-fixture-"))
  const remoteDir = path.join(base, "remote.git")
  const workDir = path.join(base, "work")
  const bareDir = path.join(base, "bare.git")
  const localDir = path.join(base, "local")

  // Bare remote
  fs.mkdirSync(remoteDir, { recursive: true })
  execFileSync("git", ["init", "--bare", "-b", "master"], { cwd: remoteDir, stdio: "pipe" })

  // Working clone to build branches
  execFileSync("git", ["clone", remoteDir, workDir], { stdio: "pipe" })
  git(workDir, ["config", "user.email", "test@example.com"])
  git(workDir, ["config", "user.name", "Test"])
  git(workDir, ["checkout", "-b", "master"])

  writeFile(workDir, "README.md", "initial\n")
  git(workDir, ["add", "README.md"])
  git(workDir, ["commit", "-m", "initial"])
  git(workDir, ["push", "origin", "master"])

  // Branch minion/a off master, edits common.ts
  git(workDir, ["checkout", "-b", "minion/a"])
  writeFile(workDir, "common.ts", "export const A = 1\n")
  git(workDir, ["add", "common.ts"])
  git(workDir, ["commit", "-m", "add common.ts"])
  const aBaseSha = git(workDir, ["rev-parse", "master"])
  git(workDir, ["push", "origin", "minion/a"])

  // Branch minion/b off master independently
  git(workDir, ["checkout", "master"])
  git(workDir, ["checkout", "-b", "minion/b"])
  if (conflicting) {
    // Same file, conflicting content
    writeFile(workDir, "common.ts", "export const B = 2\n")
  } else {
    // Different file, no conflict
    writeFile(workDir, "other.ts", "export const B = 2\n")
  }
  git(workDir, ["add", "."])
  git(workDir, ["commit", "-m", "add B"])
  const bBaseSha = git(workDir, ["rev-parse", "master"])
  git(workDir, ["push", "origin", "minion/b"])

  // Bare clone + worktree layout matching production session setup.
  // Production clones with `git clone --bare` and uses refspec
  // `+refs/heads/*:refs/heads/*` so branches are stored as refs/heads/*
  // (NOT refs/remotes/origin/*). The worktree is detached so that
  // `git fetch origin master` doesn't fail with "refusing to fetch into
  // branch checked out at ..." — in production the worktree is on a
  // feature branch, not master.
  execFileSync("git", ["clone", "--bare", remoteDir, bareDir], { stdio: "pipe" })
  git(bareDir, ["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"])
  git(bareDir, ["fetch", "origin"])
  execFileSync("git", ["worktree", "add", "--detach", localDir], { cwd: bareDir, stdio: "pipe" })
  git(localDir, ["config", "user.email", "preflight@example.com"])
  git(localDir, ["config", "user.name", "Preflight"])

  const nodes: DagNode[] = [
    {
      id: "a",
      title: "Task A",
      description: "",
      dependsOn: [],
      status: "done",
      branch: "minion/a",
      baseSha: aBaseSha,
      prUrl: "https://github.com/org/repo/pull/1",
    },
    {
      id: "b",
      title: "Task B",
      description: "",
      dependsOn: ["a"],
      status: "done",
      branch: "minion/b",
      baseSha: bBaseSha,
      prUrl: "https://github.com/org/repo/pull/2",
    },
  ]

  const graph: DagGraph = {
    id: "dag-test",
    repo: "r",
    parentThreadId: 1,
    createdAt: 0,
    nodes,
  }

  return { localCwd: localDir, graph, nodes }
}

describe("runPreflightStaging", () => {
  let fixtures: string[] = []

  beforeEach(() => {
    fixtures = []
  })

  afterEach(() => {
    for (const dir of fixtures) {
      try { fs.rmSync(path.dirname(dir), { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  it("returns ok when all nodes cherry-pick cleanly", async () => {
    const { localCwd, graph, nodes } = setupFixture(false)
    fixtures.push(localCwd)

    const result = await runPreflightStaging(graph, nodes, "master", localCwd)

    expect(result.ok).toBe(true)
  })

  it("does not touch the host worktree when staging succeeds", async () => {
    const { localCwd, graph, nodes } = setupFixture(false)
    fixtures.push(localCwd)

    const headBefore = git(localCwd, ["rev-parse", "HEAD"])
    await runPreflightStaging(graph, nodes, "master", localCwd)
    const headAfter = git(localCwd, ["rev-parse", "HEAD"])

    expect(headAfter).toBe(headBefore)
  })

  it("cleans up the staging worktree after success", async () => {
    const { localCwd, graph, nodes } = setupFixture(false)
    fixtures.push(localCwd)

    await runPreflightStaging(graph, nodes, "master", localCwd)

    const worktreeList = git(localCwd, ["worktree", "list"])
    expect(worktreeList).not.toContain("dag-preflight-")
  })

  it("reports failedNode and conflict files when a node conflicts", async () => {
    const { localCwd, graph, nodes } = setupFixture(true)
    fixtures.push(localCwd)

    const result = await runPreflightStaging(graph, nodes, "master", localCwd)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failedNode?.id).toBe("b")
      expect(result.conflictFiles).toContain("common.ts")
    }
  })

  it("identifies the owning node when a branch is missing locally", async () => {
    const { localCwd, graph, nodes } = setupFixture(false)
    fixtures.push(localCwd)

    // Delete the local ref for minion/b so preflight's rev-parse fails on it.
    // This mirrors the real failure mode where a child session errors before
    // ever creating its worktree (and therefore its branch) in the host repo.
    execFileSync("git", ["branch", "-D", "minion/b"], { cwd: localCwd, stdio: "pipe" })

    const result = await runPreflightStaging(graph, nodes, "master", localCwd)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failedNode?.id).toBe("b")
      expect(result.error).toContain("minion/b")
      expect(result.error).toContain("not found locally")
    }
  })

  it("leaves the host worktree clean after a conflict", async () => {
    const { localCwd, graph, nodes } = setupFixture(true)
    fixtures.push(localCwd)

    const headBefore = git(localCwd, ["rev-parse", "HEAD"])
    await runPreflightStaging(graph, nodes, "master", localCwd)
    const headAfter = git(localCwd, ["rev-parse", "HEAD"])

    expect(headAfter).toBe(headBefore)
    // No leftover staging worktrees
    const worktreeList = git(localCwd, ["worktree", "list"])
    expect(worktreeList).not.toContain("dag-preflight-")
  })
})

describe("cherryPickRange", () => {
  let tmpDir = ""
  let aSha = ""
  let bSha = ""

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-pick-"))
    execFileSync("git", ["init", "-b", "master"], { cwd: tmpDir, stdio: "pipe" })
    git(tmpDir, ["config", "user.email", "t@t"])
    git(tmpDir, ["config", "user.name", "t"])

    writeFile(tmpDir, "a.txt", "a\n")
    git(tmpDir, ["add", "a.txt"])
    git(tmpDir, ["commit", "-m", "a"])
    aSha = git(tmpDir, ["rev-parse", "HEAD"])

    writeFile(tmpDir, "b.txt", "b\n")
    git(tmpDir, ["add", "b.txt"])
    git(tmpDir, ["commit", "-m", "b"])
    bSha = git(tmpDir, ["rev-parse", "HEAD"])
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns ok when baseSha === headSha", async () => {
    const result = await cherryPickRange(tmpDir, aSha, aSha)
    expect(result.ok).toBe(true)
  })

  it("applies commits in the given range", async () => {
    // Reset to aSha so b.txt isn't present
    git(tmpDir, ["reset", "--hard", aSha])
    expect(fs.existsSync(path.join(tmpDir, "b.txt"))).toBe(false)

    const result = await cherryPickRange(tmpDir, aSha, bSha)
    expect(result.ok).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, "b.txt"))).toBe(true)
  })

  it("aborts cleanly on conflict and returns conflict files", async () => {
    // Create a diverging edit to a.txt, then try cherry-picking another edit to a.txt
    git(tmpDir, ["checkout", "-b", "divergent"])
    writeFile(tmpDir, "a.txt", "divergent\n")
    git(tmpDir, ["commit", "-am", "divergent a"])

    // Back on master, create a fork that edits a.txt differently
    git(tmpDir, ["checkout", "master"])
    git(tmpDir, ["checkout", "-b", "other"])
    writeFile(tmpDir, "a.txt", "other\n")
    git(tmpDir, ["commit", "-am", "other a"])
    const otherSha = git(tmpDir, ["rev-parse", "HEAD"])
    const otherBase = git(tmpDir, ["rev-parse", "master"])

    // Now switch to divergent and try cherry-pick
    git(tmpDir, ["checkout", "divergent"])
    const result = await cherryPickRange(tmpDir, otherBase, otherSha)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.files).toContain("a.txt")
    }

    // The workspace should be back in a clean state (no unmerged files)
    const unmerged = git(tmpDir, ["diff", "--name-only", "--diff-filter=U"])
    expect(unmerged).toBe("")
  })
})
