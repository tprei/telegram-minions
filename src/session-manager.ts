/**
 * Session management utilities for minion sessions.
 * Handles session lifecycle, workspace preparation, and prompt building.
 */

import { execSync, execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import crypto from "node:crypto"
import type { SessionHandle } from "./session.js"
import type { SessionMeta, TopicSession } from "./types.js"
import { extractRepoName } from "./command-parser.js"
import { loggers } from "./logger.js"
import { DefaultBranchError } from "./errors.js"

const log = loggers.session

const execFileAsync = promisify(execFile)

export interface ActiveSession {
  handle: SessionHandle
  meta: SessionMeta
  task: string
}

export interface PendingTask {
  task: string
  threadId?: number
  repoSlug?: string
  repoUrl?: string
  mode: "task" | "plan" | "think" | "review"
}

/**
 * Build a context prompt from the conversation history.
 * Used when resuming a session with user feedback.
 */
export function buildContextPrompt(topicSession: TopicSession): string {
  const isThink = topicSession.mode === "think"
  const isPlan = topicSession.mode === "plan"
  const isReview = topicSession.mode === "review"
  const header = isThink
    ? "## Research context\n\nYou are continuing a deep-research conversation. Here is the history:"
    : isPlan
      ? "## Planning context\n\nYou are continuing a planning conversation. Here is the history:"
      : isReview
        ? "## Review context\n\nYou are continuing a code review conversation. Here is the history:"
        : "## Follow-up context\n\nYou previously worked on this task. Here is the conversation history:"

  const MAX_ASSISTANT_CHARS = 4000
  const lines: string[] = [header, ""]

  for (const msg of topicSession.conversation) {
    const label = msg.role === "user" ? "**User**" : "**Agent**"
    lines.push(`${label}:`)
    if (msg.role === "assistant" && msg.text.length > MAX_ASSISTANT_CHARS) {
      lines.push(`[earlier output truncated]\n…${msg.text.slice(-MAX_ASSISTANT_CHARS)}`)
    } else {
      lines.push(msg.text)
    }
    lines.push("")
  }

  lines.push("---")
  if (isThink) {
    lines.push(
      "Dig deeper based on the latest question. Search the web for additional context. Be thorough.",
    )
  } else if (isPlan) {
    lines.push(
      "Refine the plan based on the latest feedback. Present the updated plan clearly.",
    )
  } else if (isReview) {
    lines.push(
      "Address the user's follow-up about the review. Look deeper at the areas they highlighted.",
    )
  } else {
    lines.push("The workspace still has your previous changes (branch, commits, PR).")
    lines.push("Address the user's latest feedback. Push updates to the existing branch.")
  }

  return lines.join("\n")
}

/**
 * Build an execution prompt from a planning/thinking session.
 * Used when transitioning from plan mode to task execution.
 */
export function buildExecutionPrompt(
  topicSession: TopicSession,
  directive?: string,
): string {
  const MAX_ASSISTANT_CHARS = 4000
  const conversation = topicSession.conversation

  const originalRequest = conversation[0]?.text ?? ""

  const lines: string[] = ["## Task", "", originalRequest, ""]

  if (conversation.length > 1) {
    const isThink = topicSession.mode === "think"
    const isReview = topicSession.mode === "review"
    lines.push(
      isThink
        ? "## Research thread"
        : isReview
          ? "## Review thread"
          : "## Planning thread",
    )
    lines.push("")
    for (const msg of conversation.slice(1)) {
      const label = msg.role === "user" ? "**User**" : "**Agent**"
      lines.push(`${label}:`)
      if (msg.role === "assistant" && msg.text.length > MAX_ASSISTANT_CHARS) {
        lines.push(`[earlier output truncated]\n…${msg.text.slice(-MAX_ASSISTANT_CHARS)}`)
      } else {
        lines.push(msg.text)
      }
      lines.push("")
    }
  }

  lines.push("---")
  if (directive) {
    lines.push(directive)
  } else {
    lines.push("Implement the plan above. Follow the plan closely.")
  }

  return lines.join("\n")
}

/**
 * Prepare a workspace directory for a session.
 * For repos: clones bare, creates worktree branch.
 * For local: creates empty directory.
 */
export function prepareWorkspace(
  slug: string,
  workspaceRoot: string,
  repoUrl?: string,
  startBranch?: string,
): string | null {
  const workDir = path.join(workspaceRoot, slug)

  try {
    if (repoUrl) {
      const reposDir = path.join(workspaceRoot, ".repos")
      fs.mkdirSync(reposDir, { recursive: true })

      const repoName = extractRepoName(repoUrl)
      const bareDir = path.join(reposDir, `${repoName}.git`)
      const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
      const stdio: import("node:child_process").StdioOptions = [
        "ignore",
        "pipe",
        "pipe",
      ]
      const gitOpts = { stdio, timeout: 120_000, env: gitEnv }

      if (fs.existsSync(bareDir)) {
        log.debug({ repoUrl, bareDir }, "fetching repo")
        ensureBareRefspec(bareDir, gitOpts)
        execSync(`git fetch --prune origin`, { ...gitOpts, cwd: bareDir })
        updateLocalHead(bareDir, gitOpts)
      } else {
        log.debug({ repoUrl, bareDir }, "cloning bare repo")
        execSync(
          `git clone --bare ${JSON.stringify(repoUrl)} ${JSON.stringify(bareDir)}`,
          gitOpts,
        )
        ensureBareRefspec(bareDir, gitOpts)
      }

      const branch = `minion/${slug}`
      const startRef = startBranch ?? resolveDefaultBranch(bareDir, gitOpts, repoUrl)
      log.debug({ workDir, branch, startRef }, "adding worktree")
      execSync(
        `git worktree add ${JSON.stringify(workDir)} -b ${JSON.stringify(branch)} ${startRef}`,
        { ...gitOpts, cwd: bareDir },
      )

      execSync(`git remote set-url origin ${JSON.stringify(repoUrl)}`, {
        ...gitOpts,
        cwd: workDir,
      })

      execSync(`git config rerere.enabled true`, { ...gitOpts, cwd: workDir })

      bootstrapDependencies(workDir, reposDir, repoName)
    } else {
      fs.mkdirSync(workDir, { recursive: true })
    }

    return workDir
  } catch (err) {
    log.error({ err }, "prepareWorkspace failed")
    return null
  }
}

/**
 * Remove a workspace directory, handling worktrees for repos.
 */
export async function removeWorkspace(
  topicSession: TopicSession,
  workspaceRoot: string,
): Promise<void> {
  if (!topicSession.cwd || !fs.existsSync(topicSession.cwd)) return

  try {
    if (topicSession.repoUrl) {
      const repoName = extractRepoName(topicSession.repoUrl)
      const bareDir = path.join(workspaceRoot, ".repos", `${repoName}.git`)
      if (fs.existsSync(bareDir)) {
        await execFileAsync(
          "git",
          ["worktree", "remove", "--force", topicSession.cwd],
          { cwd: bareDir, timeout: 30_000 },
        )
        log.debug({ cwd: topicSession.cwd }, "removed worktree")
        return
      }
    }

    fs.rmSync(topicSession.cwd, { recursive: true, force: true })
    log.debug({ cwd: topicSession.cwd }, "removed workspace")
  } catch (err) {
    log.error({ err, cwd: topicSession.cwd }, "failed to remove workspace")
    try {
      fs.rmSync(topicSession.cwd, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

/**
 * Ensure the bare repo has a fetch refspec configured.
 * `git clone --bare` omits the fetch refspec, so `git fetch` won't
 * update local refs without it.
 */
function ensureBareRefspec(bareDir: string, gitOpts: object): void {
  try {
    const existing = execSync(`git config --get remote.origin.fetch`, {
      ...gitOpts,
      cwd: bareDir,
    })
      .toString()
      .trim()
    if (existing) return
  } catch {
    /* not set — add it */
  }
  try {
    execSync(
      `git config remote.origin.fetch "+refs/heads/*:refs/heads/*"`,
      { ...gitOpts, cwd: bareDir },
    )
  } catch {
    /* best effort */
  }
}

/**
 * Update local HEAD ref to match remote default branch.
 */
export function updateLocalHead(bareDir: string, gitOpts: object): void {
  const defaultBranch = resolveDefaultBranch(bareDir, gitOpts)
  try {
    execSync(
      `git update-ref refs/heads/${defaultBranch} refs/remotes/origin/${defaultBranch}`,
      { ...gitOpts, cwd: bareDir },
    )
  } catch {
    /* remote ref may not exist yet */
  }
}

/**
 * Resolve the default branch name from a bare git repo.
 * Tries HEAD symbolic-ref, then main, then master.
 */
export function resolveDefaultBranch(bareDir: string, gitOpts: object, repoUrl?: string): string {
  try {
    const ref = execSync("git symbolic-ref HEAD", { ...gitOpts, cwd: bareDir })
      .toString()
      .trim()
    const branch = ref.replace("refs/heads/", "")
    execSync(`git rev-parse --verify refs/heads/${branch}`, {
      ...gitOpts,
      cwd: bareDir,
    })
    return branch
  } catch {
    /* detached HEAD, unborn branch, or not set */
  }

  for (const name of ["main", "master"]) {
    try {
      execSync(`git rev-parse --verify refs/heads/${name}`, {
        ...gitOpts,
        cwd: bareDir,
      })
      return name
    } catch {
      /* doesn't exist */
    }
  }

  throw new DefaultBranchError(repoUrl)
}

function bootstrapOnePackage(
  pkgDir: string, reposDir: string, cacheKey: string, label: string,
): void {
  const lockFile = path.join(pkgDir, "package-lock.json")
  const cacheDir = path.join(reposDir, `${cacheKey}-node_modules`)
  const cacheLockHash = path.join(reposDir, `${cacheKey}-lock.hash`)

  const currentHash = fs.existsSync(lockFile)
    ? crypto.createHash("sha256").update(fs.readFileSync(lockFile)).digest("hex")
    : null

  const cachedHash = fs.existsSync(cacheLockHash)
    ? fs.readFileSync(cacheLockHash, "utf8").trim()
    : null

  const stdio: import("node:child_process").StdioOptions = ["ignore", "pipe", "pipe"]

  if (currentHash && cachedHash === currentHash && fs.existsSync(cacheDir)) {
    try {
      execSync(`cp -al ${JSON.stringify(cacheDir)} ${JSON.stringify(path.join(pkgDir, "node_modules"))}`, {
        stdio, timeout: 30_000,
      })
      log.debug({ label }, "hardlinked node_modules")
      return
    } catch (err) {
      log.warn({ err, label }, "hardlink copy failed, falling back to npm ci")
    }
  }

  try {
    const installCmd = fs.existsSync(lockFile) ? "npm ci" : "npm install"
    log.debug({ installCmd, label }, "running package install")
    execSync(installCmd, { cwd: pkgDir, stdio, timeout: 120_000 })

    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true })
    }
    execSync(`cp -al ${JSON.stringify(path.join(pkgDir, "node_modules"))} ${JSON.stringify(cacheDir)}`, {
      stdio, timeout: 60_000,
    })
    if (currentHash) {
      fs.writeFileSync(cacheLockHash, currentHash)
    }
    log.debug({ label }, "cached node_modules")
  } catch (err) {
    log.warn({ err, label }, "dependency bootstrap failed (non-fatal)")
  }
}

export function bootstrapDependencies(workDir: string, reposDir: string, repoName: string): void {
  if (fs.existsSync(path.join(workDir, "package.json"))) {
    bootstrapOnePackage(workDir, reposDir, repoName, workDir)
  }

  try {
    const entries = fs.readdirSync(workDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue
      const nested = path.join(workDir, entry.name)
      if (fs.existsSync(path.join(nested, "package.json"))) {
        bootstrapOnePackage(nested, reposDir, `${repoName}-${entry.name}`, `${workDir}/${entry.name}`)
      }
    }
  } catch {
    // non-fatal
  }
}

/**
 * Clean build artifacts from a workspace to free disk space.
 */
export function cleanBuildArtifacts(cwd: string): void {
  const artifacts = ["node_modules", ".next", ".turbo", ".cache", "dist", ".npm"]
  for (const name of artifacts) {
    const target = path.join(cwd, name)
    try {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true })
        log.debug({ name, cwd }, "cleaned artifact")
      }
    } catch (err) {
      log.error({ err, name, cwd }, "failed to clean artifact")
    }
  }
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue
      const nested = path.join(cwd, entry.name, "node_modules")
      if (fs.existsSync(nested)) {
        fs.rmSync(nested, { recursive: true, force: true })
        log.debug({ name: `${entry.name}/node_modules`, cwd }, "cleaned nested artifact")
      }
    }
  } catch { /* non-fatal */ }
  const homeCacheDir = path.join(cwd, ".home", ".npm")
  try {
    if (fs.existsSync(homeCacheDir)) {
      fs.rmSync(homeCacheDir, { recursive: true, force: true })
      log.debug({ cwd }, "cleaned .home/.npm")
    }
  } catch {
    /* best effort */
  }
}

/**
 * Calculate directory size in bytes using du command.
 */
export function dirSizeBytes(dirPath: string): number {
  try {
    const output = execSync(`du -sb ${JSON.stringify(dirPath)}`, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).toString()
    return parseInt(output.split("\t")[0] ?? "0", 10) || 0
  } catch {
    return 0
  }
}

/**
 * Download Telegram photos to a temp directory.
 * Returns paths to downloaded image files.
 */
export async function downloadPhotos(
  photos:
    | import("./types.js").TelegramPhotoSize[]
    | undefined,
  telegramClient: {
    downloadFile: (fileId: string, destPath: string) => Promise<boolean>
  },
): Promise<string[]> {
  if (!photos || photos.length === 0) return []

  const imagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "minion-images-"))

  // Telegram sends multiple sizes; pick the largest (last in the array)
  const largest = photos[photos.length - 1]
  const filename = `${largest.file_unique_id}.jpg`
  const destPath = path.join(imagesDir, filename)

  const ok = await telegramClient.downloadFile(largest.file_id, destPath)
  if (!ok) return []

  return [destPath]
}

/**
 * Prepare a merge branch for fan-in DAG nodes.
 * Checks for merge conflicts before creating a real merge.
 */
export function prepareFanInBranch(
  slug: string,
  repoUrl: string,
  upstreamBranches: string[],
  workspaceRoot: string,
): string | null {
  if (upstreamBranches.length <= 1) {
    return upstreamBranches[0] ?? null
  }

  const repoName = extractRepoName(repoUrl)
  const bareDir = path.join(workspaceRoot, ".repos", `${repoName}.git`)
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  const stdio: import("node:child_process").StdioOptions = ["ignore", "pipe", "pipe"]
  const gitOpts = { stdio, timeout: 120_000, env: gitEnv }

  try {
    // Fetch latest state
    execSync(`git fetch --prune origin`, { ...gitOpts, cwd: bareDir })

    // Use git merge-tree to check for conflicts before creating a real merge
    const baseBranch = upstreamBranches[0]
    for (let i = 1; i < upstreamBranches.length; i++) {
      const result = execSync(
        `git merge-tree --write-tree ${baseBranch} ${upstreamBranches[i]}`,
        { ...gitOpts, cwd: bareDir },
      )
        .toString()
        .trim()

      // If merge-tree reports conflicts, the exit code is non-zero (caught by try/catch)
      log.debug({ baseBranch, branch: upstreamBranches[i], result: result.slice(0, 40) }, "merge-tree check OK")
    }

    // No conflicts detected — return first branch, actual merge happens in prepareWorkspace + post-checkout merge
    return upstreamBranches[0]
  } catch (err) {
    log.warn({ err, slug }, "fan-in merge conflict detected")
    return null
  }
}

/**
 * Merge additional upstream branches into a worktree.
 * Used for fan-in DAG nodes with multiple dependencies.
 */
export function mergeUpstreamBranches(
  workDir: string,
  additionalBranches: string[],
): boolean {
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  const stdio: import("node:child_process").StdioOptions = ["ignore", "pipe", "pipe"]
  const gitOpts = { stdio, timeout: 120_000, env: gitEnv }

  for (const branch of additionalBranches) {
    try {
      execSync(`git merge --no-edit ${JSON.stringify(branch)}`, {
        ...gitOpts,
        cwd: workDir,
      })
      log.debug({ branch, workDir }, "merged branch into worktree")
    } catch (err) {
      log.error({ err, branch, workDir }, "merge of branch into worktree failed")
      // Abort the merge
      try {
        execSync(`git merge --abort`, { ...gitOpts, cwd: workDir })
      } catch {
        /* best effort */
      }
      return false
    }
  }

  return true
}

export interface RestackResult {
  success: boolean
  newMergeBase?: string
  conflictFiles?: string[]
  error?: string
}

/**
 * Rebase a branch onto a new base commit.
 *
 * Uses `git rebase --onto` for the standard case (pre-squash, where original
 * commits still exist). Falls back to cherry-pick when rebase fails — this
 * handles post-squash scenarios where the original merge base no longer exists
 * in the target branch's history.
 *
 * Operates in a temporary worktree so it doesn't interfere with running sessions.
 */
export async function rebaseBranchOnto(
  workspaceRoot: string,
  repoUrl: string,
  branch: string,
  oldMergeBase: string,
  newBase: string,
): Promise<RestackResult> {
  const repoName = extractRepoName(repoUrl)
  const bareDir = path.join(workspaceRoot, ".repos", `${repoName}.git`)
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  const stdio: import("node:child_process").StdioOptions = ["ignore", "pipe", "pipe"]
  const gitOpts = { stdio, timeout: 120_000, env: gitEnv }

  // Create a temporary worktree for the rebase operation
  const tmpName = `restack-${Date.now()}`
  const tmpDir = path.join(workspaceRoot, `.restack-tmp`, tmpName)
  fs.mkdirSync(path.join(workspaceRoot, `.restack-tmp`), { recursive: true })

  try {
    // Fetch latest state (ensureBareRefspec so new branches are fetched as local refs)
    ensureBareRefspec(bareDir, gitOpts)
    execSync(`git fetch --prune origin`, { ...gitOpts, cwd: bareDir })

    // Create temporary worktree on the branch to rebase
    execSync(
      `git worktree add ${JSON.stringify(tmpDir)} ${JSON.stringify(branch)}`,
      { ...gitOpts, cwd: bareDir },
    )

    // Configure the worktree for rebase/cherry-pick operations
    execSync(`git config rerere.enabled true`, { ...gitOpts, cwd: tmpDir })
    execSync(`git config user.email "minion@restack"`, { ...gitOpts, cwd: tmpDir })
    execSync(`git config user.name "minion"`, { ...gitOpts, cwd: tmpDir })

    // Try rebase --onto first (works when original commits exist in history)
    try {
      execSync(
        `git rebase --onto ${JSON.stringify(newBase)} ${JSON.stringify(oldMergeBase)}`,
        { ...gitOpts, cwd: tmpDir },
      )

      const newHead = execSync(`git rev-parse HEAD`, { ...gitOpts, cwd: tmpDir })
        .toString()
        .trim()

      // Force-push the rebased branch
      execSync(
        `git push --force origin HEAD:${JSON.stringify(branch)}`,
        { ...gitOpts, cwd: tmpDir },
      )

      log.info({ branch, oldMergeBase, newBase, newHead }, "rebase --onto succeeded")

      // New merge base is the tip of newBase
      const mergeBase = execSync(
        `git rev-parse ${JSON.stringify(newBase)}`,
        { ...gitOpts, cwd: tmpDir },
      )
        .toString()
        .trim()

      return { success: true, newMergeBase: mergeBase }
    } catch (rebaseErr) {
      // Abort the failed rebase
      try {
        execSync(`git rebase --abort`, { ...gitOpts, cwd: tmpDir })
      } catch {
        /* may not be in rebase state */
      }

      log.debug({ branch, err: rebaseErr }, "rebase --onto failed, trying cherry-pick")
    }

    // Fallback: cherry-pick approach (works post-squash when merge base is gone)
    return await cherryPickRestack(tmpDir, branch, oldMergeBase, newBase, gitOpts)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err, branch }, "rebaseBranchOnto failed")
    return { success: false, error: message }
  } finally {
    // Clean up temporary worktree
    try {
      execSync(
        `git worktree remove --force ${JSON.stringify(tmpDir)}`,
        { ...gitOpts, cwd: bareDir },
      )
    } catch {
      // Best effort — remove directory manually if worktree removal fails
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
        execSync(`git worktree prune`, { ...gitOpts, cwd: bareDir })
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Cherry-pick approach for restacking after a squash merge.
 *
 * When upstream was squash-merged, the old merge base commit no longer exists
 * in the target branch's history. We identify the unique commits on the branch
 * (between old merge base and branch tip), reset to the new base, then
 * cherry-pick each commit.
 */
async function cherryPickRestack(
  workDir: string,
  branch: string,
  oldMergeBase: string,
  newBase: string,
  gitOpts: { stdio: import("node:child_process").StdioOptions; timeout: number; env: NodeJS.ProcessEnv },
): Promise<RestackResult> {
  // Get the list of commits to cherry-pick (oldest first)
  const commitList = execSync(
    `git rev-list --reverse ${JSON.stringify(oldMergeBase)}..HEAD`,
    { ...gitOpts, cwd: workDir },
  )
    .toString()
    .trim()

  if (!commitList) {
    // No unique commits — just reset to new base
    execSync(
      `git reset --hard ${JSON.stringify(newBase)}`,
      { ...gitOpts, cwd: workDir },
    )

    execSync(
      `git push --force origin HEAD:${JSON.stringify(branch)}`,
      { ...gitOpts, cwd: workDir },
    )

    const mergeBase = execSync(
      `git rev-parse ${JSON.stringify(newBase)}`,
      { ...gitOpts, cwd: workDir },
    )
      .toString()
      .trim()

    return { success: true, newMergeBase: mergeBase }
  }

  const commits = commitList.split("\n")

  // Reset to the new base
  execSync(
    `git reset --hard ${JSON.stringify(newBase)}`,
    { ...gitOpts, cwd: workDir },
  )

  // Cherry-pick each commit
  for (const commit of commits) {
    try {
      execSync(
        `git cherry-pick ${JSON.stringify(commit)}`,
        { ...gitOpts, cwd: workDir },
      )
    } catch {
      // Check if rerere resolved all conflicts
      const status = execSync(`git status --porcelain`, { ...gitOpts, cwd: workDir })
        .toString()
        .trim()

      const unresolvedConflicts = status
        .split("\n")
        .filter((line) => line.startsWith("UU") || line.startsWith("AA") || line.startsWith("DD"))

      if (unresolvedConflicts.length > 0) {
        const conflictFiles = unresolvedConflicts.map((line) => line.slice(3))
        // Abort the cherry-pick
        try {
          execSync(`git cherry-pick --abort`, { ...gitOpts, cwd: workDir })
        } catch {
          /* best effort */
        }
        // Reset back to the branch's original state
        try {
          execSync(`git checkout --force ${JSON.stringify(branch)}`, { ...gitOpts, cwd: workDir })
        } catch {
          /* best effort */
        }
        log.warn({ branch, conflictFiles }, "cherry-pick hit unresolved conflicts")
        return { success: false, conflictFiles, error: "unresolved merge conflicts" }
      }

      // rerere resolved the conflicts — continue
      execSync(`git add -A`, { ...gitOpts, cwd: workDir })
      execSync(
        `git cherry-pick --continue`,
        { ...gitOpts, cwd: workDir, env: { ...gitOpts.env, GIT_EDITOR: "true" } },
      )
    }
  }

  // Force-push the rebased branch
  execSync(
    `git push --force origin HEAD:${JSON.stringify(branch)}`,
    { ...gitOpts, cwd: workDir },
  )

  const newHead = execSync(`git rev-parse HEAD`, { ...gitOpts, cwd: workDir })
    .toString()
    .trim()

  const mergeBase = execSync(
    `git rev-parse ${JSON.stringify(newBase)}`,
    { ...gitOpts, cwd: workDir },
  )
    .toString()
    .trim()

  log.info({ branch, commits: commits.length, newHead }, "cherry-pick restack succeeded")

  return { success: true, newMergeBase: mergeBase }
}

/**
 * Restack a single branch onto its updated upstream.
 *
 * High-level wrapper that fetches, rebases (or cherry-picks), and force-pushes.
 * Returns the new merge base commit hash on success so the caller can update
 * the DagNode.mergeBase field.
 */
export async function restackBranch(
  workspaceRoot: string,
  repoUrl: string,
  branch: string,
  oldMergeBase: string,
  newUpstreamBranch: string,
): Promise<RestackResult> {
  const repoName = extractRepoName(repoUrl)
  const bareDir = path.join(workspaceRoot, ".repos", `${repoName}.git`)
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  const stdio: import("node:child_process").StdioOptions = ["ignore", "pipe", "pipe"]
  const gitOpts = { stdio, timeout: 120_000, env: gitEnv }

  // Resolve the upstream branch to a commit hash (the new base)
  try {
    ensureBareRefspec(bareDir, gitOpts)
    execSync(`git fetch --prune origin`, { ...gitOpts, cwd: bareDir })
  } catch (err) {
    log.error({ err, repoUrl }, "fetch failed during restack")
    return { success: false, error: "git fetch failed" }
  }

  let newBase: string
  try {
    // With bare refspec +refs/heads/*:refs/heads/*, branches are local refs
    newBase = execSync(
      `git rev-parse ${JSON.stringify(newUpstreamBranch)}`,
      { ...gitOpts, cwd: bareDir },
    )
      .toString()
      .trim()
  } catch (err) {
    log.error({ err, newUpstreamBranch }, "could not resolve upstream branch")
    return { success: false, error: `cannot resolve upstream branch: ${newUpstreamBranch}` }
  }

  // If the merge base hasn't changed, no restack needed
  if (newBase === oldMergeBase) {
    log.debug({ branch, oldMergeBase }, "branch already up to date, skipping restack")
    return { success: true, newMergeBase: oldMergeBase }
  }

  return rebaseBranchOnto(workspaceRoot, repoUrl, branch, oldMergeBase, newBase)
}

/**
 * Capture the current HEAD commit of a branch in the bare repo.
 * Used to record the merge base when spawning DAG children.
 */
export function captureMergeBase(
  workspaceRoot: string,
  repoUrl: string,
  branch: string,
): string | null {
  const repoName = extractRepoName(repoUrl)
  const bareDir = path.join(workspaceRoot, ".repos", `${repoName}.git`)
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  const stdio: import("node:child_process").StdioOptions = ["ignore", "pipe", "pipe"]
  const gitOpts = { stdio, timeout: 30_000, env: gitEnv }

  try {
    return execSync(
      `git rev-parse ${JSON.stringify(branch)}`,
      { ...gitOpts, cwd: bareDir },
    )
      .toString()
      .trim()
  } catch (err) {
    log.warn({ err, branch }, "failed to capture merge base")
    return null
  }
}
