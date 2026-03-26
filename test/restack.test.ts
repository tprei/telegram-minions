import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import {
  rebaseBranchOnto,
  restackBranch,
  captureMergeBase,
  prepareWorkspace,
} from "../src/session-manager.js"

const stdio: import("node:child_process").StdioOptions = ["ignore", "pipe", "pipe"]
const gitOpts = { stdio, timeout: 30_000 }

/**
 * Helper to create a test git repo with a remote (bare repo) and working tree.
 * The "repoUrl" uses the naming convention expected by extractRepoName() so
 * that session-manager functions find the bare repo at .repos/<name>.git.
 */
function createTestRepo(): {
  bareDir: string
  workspaceRoot: string
  workDir: string
  repoUrl: string
  git: (cmd: string, cwd?: string) => string
  sync: () => void
  cleanup: () => void
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restack-test-"))

  // Create a "remote" bare repo with explicit main branch
  // Name it "test-repo.git" so extractRepoName() returns "test-repo"
  const originDir = path.join(tmpDir, "test-repo.git")
  execSync(`git init --bare --initial-branch=main ${originDir}`, gitOpts)

  // Create a working clone to set up initial content
  const setupDir = path.join(tmpDir, "setup")
  execSync(`git clone ${originDir} ${setupDir}`, gitOpts)
  execSync(`git config user.email "test@test.com"`, { ...gitOpts, cwd: setupDir })
  execSync(`git config user.name "Test"`, { ...gitOpts, cwd: setupDir })
  execSync(`git checkout -b main`, { ...gitOpts, cwd: setupDir })

  // Create initial commit on main
  fs.writeFileSync(path.join(setupDir, "README.md"), "# Test repo\n")
  execSync(`git add README.md`, { ...gitOpts, cwd: setupDir })
  execSync(`git commit -m "initial commit"`, { ...gitOpts, cwd: setupDir })
  execSync(`git push -u origin main`, { ...gitOpts, cwd: setupDir })

  // Set up the workspace root with .repos dir matching our session-manager conventions
  // extractRepoName(originDir) returns "test-repo", so bare clone goes to .repos/test-repo.git
  const workspaceRoot = path.join(tmpDir, "workspace")
  const reposDir = path.join(workspaceRoot, ".repos")
  fs.mkdirSync(reposDir, { recursive: true })

  const bareDir = path.join(reposDir, "test-repo.git")
  execSync(`git clone --bare ${originDir} ${bareDir}`, gitOpts)
  // Configure fetch refspec so git fetch updates local refs (bare clones omit this)
  execSync(`git config remote.origin.fetch "+refs/heads/*:refs/heads/*"`, { ...gitOpts, cwd: bareDir })

  const git = (cmd: string, cwd?: string): string => {
    return execSync(`git ${cmd}`, { ...gitOpts, cwd: cwd ?? setupDir })
      .toString()
      .trim()
  }

  // Sync the workspace bare repo with the origin (after pushing new branches)
  const sync = (): void => {
    execSync(`git fetch --prune origin`, { ...gitOpts, cwd: bareDir })
  }

  return {
    bareDir,
    workspaceRoot,
    workDir: setupDir,
    repoUrl: originDir,
    git,
    sync,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  }
}

describe("rebaseBranchOnto", () => {
  let env: ReturnType<typeof createTestRepo>

  beforeEach(() => {
    env = createTestRepo()
  })

  afterEach(() => {
    env.cleanup()
  })

  it("rebases a branch onto a new base using rebase --onto", async () => {
    const { git, workDir, workspaceRoot, repoUrl, bareDir } = env

    // Create branch-a with a commit
    git("checkout -b branch-a", workDir)
    fs.writeFileSync(path.join(workDir, "a.txt"), "a content\n")
    git("add a.txt", workDir)
    git("commit -m 'add a.txt'", workDir)
    git("push origin branch-a", workDir)

    // Create branch-b based on branch-a
    git("checkout -b branch-b", workDir)
    fs.writeFileSync(path.join(workDir, "b.txt"), "b content\n")
    git("add b.txt", workDir)
    git("commit -m 'add b.txt'", workDir)
    git("push origin branch-b", workDir)

    const branchBMergeBase = git("rev-parse branch-a", workDir)

    // Now update branch-a with a new commit
    git("checkout branch-a", workDir)
    fs.writeFileSync(path.join(workDir, "a2.txt"), "a2 content\n")
    git("add a2.txt", workDir)
    git("commit -m 'add a2.txt'", workDir)
    git("push origin branch-a", workDir)

    // The function fetches internally — just call it
    const result = await rebaseBranchOnto(
      workspaceRoot,
      repoUrl,
      "branch-b",
      branchBMergeBase,
      "branch-a",
    )

    expect(result.success).toBe(true)
    expect(result.newMergeBase).toBeDefined()

    // Verify branch-b now contains both a2.txt and b.txt
    const verifyDir = path.join(workspaceRoot, "verify-rebase")
    execSync(`git worktree add ${verifyDir} branch-b`, { ...gitOpts, cwd: bareDir })

    expect(fs.existsSync(path.join(verifyDir, "b.txt"))).toBe(true)
    expect(fs.existsSync(path.join(verifyDir, "a2.txt"))).toBe(true)
    expect(fs.existsSync(path.join(verifyDir, "a.txt"))).toBe(true)

    // Cleanup verify worktree
    execSync(`git worktree remove --force ${verifyDir}`, { ...gitOpts, cwd: bareDir })
  })

  it("returns conflict info when rebase has unresolvable conflicts", async () => {
    const { git, workDir, workspaceRoot, repoUrl } = env

    // Create branch-a that modifies a file
    git("checkout -b branch-a", workDir)
    fs.writeFileSync(path.join(workDir, "shared.txt"), "branch-a version\n")
    git("add shared.txt", workDir)
    git("commit -m 'branch-a: add shared.txt'", workDir)
    git("push origin branch-a", workDir)

    const mergeBase = git("rev-parse main", workDir)

    // Create branch-b with conflicting changes to same file
    git("checkout main", workDir)
    git("checkout -b branch-b", workDir)
    fs.writeFileSync(path.join(workDir, "shared.txt"), "branch-b version\n")
    git("add shared.txt", workDir)
    git("commit -m 'branch-b: add shared.txt'", workDir)
    git("push origin branch-b", workDir)

    // Rebase branch-b onto branch-a — should conflict on shared.txt
    const result = await rebaseBranchOnto(
      workspaceRoot,
      repoUrl,
      "branch-b",
      mergeBase,
      "branch-a",
    )

    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  it("handles branch with no unique commits (fast-forward)", async () => {
    const { git, workDir, workspaceRoot, repoUrl } = env

    // Create branch-a
    git("checkout -b branch-a", workDir)
    fs.writeFileSync(path.join(workDir, "a.txt"), "a content\n")
    git("add a.txt", workDir)
    git("commit -m 'add a.txt'", workDir)
    git("push origin branch-a", workDir)

    // Create branch-b at same point as branch-a (no unique commits)
    git("checkout -b branch-b", workDir)
    git("push origin branch-b", workDir)

    const branchBBase = git("rev-parse branch-a", workDir)

    // Add new commit on branch-a
    git("checkout branch-a", workDir)
    fs.writeFileSync(path.join(workDir, "a2.txt"), "a2\n")
    git("add a2.txt", workDir)
    git("commit -m 'add a2'", workDir)
    git("push origin branch-a", workDir)

    const result = await rebaseBranchOnto(
      workspaceRoot,
      repoUrl,
      "branch-b",
      branchBBase,
      "branch-a",
    )

    expect(result.success).toBe(true)
    expect(result.newMergeBase).toBeDefined()
  })
})

describe("restackBranch", () => {
  let env: ReturnType<typeof createTestRepo>

  beforeEach(() => {
    env = createTestRepo()
  })

  afterEach(() => {
    env.cleanup()
  })

  it("skips restack when upstream hasn't changed", async () => {
    const { git, workDir, workspaceRoot, repoUrl } = env

    // Create branch-a
    git("checkout -b branch-a", workDir)
    fs.writeFileSync(path.join(workDir, "a.txt"), "a\n")
    git("add a.txt", workDir)
    git("commit -m 'add a'", workDir)
    git("push origin branch-a", workDir)

    const mergeBase = git("rev-parse branch-a", workDir)

    // Create branch-b
    git("checkout -b branch-b", workDir)
    fs.writeFileSync(path.join(workDir, "b.txt"), "b\n")
    git("add b.txt", workDir)
    git("commit -m 'add b'", workDir)
    git("push origin branch-b", workDir)

    // Restack branch-b — upstream branch-a hasn't changed
    const result = await restackBranch(
      workspaceRoot,
      repoUrl,
      "branch-b",
      mergeBase,
      "branch-a",
    )

    expect(result.success).toBe(true)
    expect(result.newMergeBase).toBe(mergeBase)
  })

  it("restacks when upstream has new commits", async () => {
    const { git, workDir, workspaceRoot, repoUrl } = env

    // Create branch-a
    git("checkout -b branch-a", workDir)
    fs.writeFileSync(path.join(workDir, "a.txt"), "a\n")
    git("add a.txt", workDir)
    git("commit -m 'add a'", workDir)
    git("push origin branch-a", workDir)

    const originalBase = git("rev-parse branch-a", workDir)

    // Create branch-b based on branch-a
    git("checkout -b branch-b", workDir)
    fs.writeFileSync(path.join(workDir, "b.txt"), "b\n")
    git("add b.txt", workDir)
    git("commit -m 'add b'", workDir)
    git("push origin branch-b", workDir)

    // Add commit to branch-a
    git("checkout branch-a", workDir)
    fs.writeFileSync(path.join(workDir, "a2.txt"), "a2\n")
    git("add a2.txt", workDir)
    git("commit -m 'add a2'", workDir)
    git("push origin branch-a", workDir)

    const result = await restackBranch(
      workspaceRoot,
      repoUrl,
      "branch-b",
      originalBase,
      "branch-a",
    )

    expect(result.success).toBe(true)
    expect(result.newMergeBase).not.toBe(originalBase)
  })

  it("returns error for non-existent upstream branch", async () => {
    const { git, workDir, workspaceRoot, repoUrl } = env

    git("checkout -b branch-a", workDir)
    fs.writeFileSync(path.join(workDir, "a.txt"), "a\n")
    git("add a.txt", workDir)
    git("commit -m 'add a'", workDir)
    git("push origin branch-a", workDir)

    const result = await restackBranch(
      workspaceRoot,
      repoUrl,
      "branch-a",
      "abc123",
      "nonexistent-branch",
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain("cannot resolve upstream branch")
  })
})

describe("captureMergeBase", () => {
  let env: ReturnType<typeof createTestRepo>

  beforeEach(() => {
    env = createTestRepo()
  })

  afterEach(() => {
    env.cleanup()
  })

  it("captures current HEAD of a branch", () => {
    const { git, workDir, workspaceRoot, repoUrl, sync } = env

    git("checkout -b test-branch", workDir)
    fs.writeFileSync(path.join(workDir, "test.txt"), "test\n")
    git("add test.txt", workDir)
    git("commit -m 'test commit'", workDir)
    git("push origin test-branch", workDir)

    // Sync so the bare repo has the local ref
    sync()

    const expectedSha = git("rev-parse test-branch", workDir)
    const result = captureMergeBase(workspaceRoot, repoUrl, "test-branch")

    expect(result).toBe(expectedSha)
  })

  it("returns null for non-existent branch", () => {
    const { workspaceRoot, repoUrl } = env

    const result = captureMergeBase(workspaceRoot, repoUrl, "nonexistent-branch")
    expect(result).toBeNull()
  })
})

describe("prepareWorkspace enables rerere", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rerere-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("sets rerere.enabled in the worktree", () => {
    // Create a simple origin repo
    const originDir = path.join(tmpDir, "test-repo.git")
    execSync(`git init --bare --initial-branch=main ${originDir}`, gitOpts)

    const setupDir = path.join(tmpDir, "setup")
    execSync(`git clone ${originDir} ${setupDir}`, gitOpts)
    execSync(`git config user.email "test@test.com"`, { ...gitOpts, cwd: setupDir })
    execSync(`git config user.name "Test"`, { ...gitOpts, cwd: setupDir })
    execSync(`git checkout -b main`, { ...gitOpts, cwd: setupDir })
    fs.writeFileSync(path.join(setupDir, "README.md"), "# Test\n")
    execSync(`git add .`, { ...gitOpts, cwd: setupDir })
    execSync(`git commit -m "init"`, { ...gitOpts, cwd: setupDir })
    execSync(`git push -u origin main`, { ...gitOpts, cwd: setupDir })

    const workspaceRoot = path.join(tmpDir, "workspace")

    const workDir = prepareWorkspace("test-rerere", workspaceRoot, originDir)
    expect(workDir).not.toBeNull()

    const rerereValue = execSync(`git config rerere.enabled`, {
      ...gitOpts,
      cwd: workDir!,
    })
      .toString()
      .trim()

    expect(rerereValue).toBe("true")
  })
})
