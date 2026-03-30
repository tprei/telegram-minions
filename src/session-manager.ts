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
import type { AutoAdvance, SessionMeta, TopicSession } from "./types.js"
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
  mode: "task" | "plan" | "think" | "review" | "ship-think"
  autoAdvance?: AutoAdvance
}

/**
 * Build a context prompt from the conversation history.
 * Used when resuming a session with user feedback.
 */
export function buildContextPrompt(topicSession: TopicSession): string {
  const isThink = topicSession.mode === "think" || topicSession.mode === "ship-think"
  const isPlan = topicSession.mode === "plan" || topicSession.mode === "ship-plan"
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
    const isThink = topicSession.mode === "think" || topicSession.mode === "ship-think"
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

type GitOpts = { stdio: import("node:child_process").StdioOptions; timeout: number; env: NodeJS.ProcessEnv }

function fetchBareRepo(bareDir: string, gitOpts: GitOpts): void {
  const excludeRefs: string[] = []
  try {
    const wtOutput = execSync("git worktree list --porcelain", { ...gitOpts, cwd: bareDir }).toString()
    for (const m of wtOutput.matchAll(/^branch refs\/heads\/(.+)$/gm)) {
      excludeRefs.push(`^refs/heads/${m[1]}`)
    }
  } catch {
    // worktree list failed — proceed without exclusions
  }

  const refspecs = [`+refs/heads/*:refs/heads/*`, ...excludeRefs]
    .map((r) => JSON.stringify(r))
    .join(" ")
  execSync(`git fetch --prune origin ${refspecs}`, { ...gitOpts, cwd: bareDir })
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
      } else {
        log.debug({ repoUrl, bareDir }, "cloning bare repo")
        execSync(
          `git clone --bare ${JSON.stringify(repoUrl)} ${JSON.stringify(bareDir)}`,
          gitOpts,
        )
        // bare clones don't configure a fetch refspec — add one so
        // subsequent fetches update refs/heads/* from the remote
        execSync(
          `git config remote.origin.fetch "+refs/heads/*:refs/heads/*"`,
          { ...gitOpts, cwd: bareDir },
        )
      }
      fetchBareRepo(bareDir, gitOpts)

      const branch = `minion/${slug}`
      const startRef = startBranch ?? resolveDefaultBranch(bareDir, gitOpts, repoUrl)

      // Clean up any leftover worktree and branch from a previous session
      // with the same slug (hash collisions are likely with ~4.5k combinations)
      if (fs.existsSync(workDir)) {
        try {
          execSync(`git worktree remove --force ${JSON.stringify(workDir)}`, { ...gitOpts, cwd: bareDir })
        } catch {
          fs.rmSync(workDir, { recursive: true, force: true })
        }
      }
      try {
        execSync(`git worktree prune`, { ...gitOpts, cwd: bareDir })
        execSync(`git branch -D ${JSON.stringify(branch)}`, { ...gitOpts, cwd: bareDir })
      } catch {
        // branch/worktree doesn't exist, that's fine
      }

      log.debug({ workDir, branch, startRef }, "adding worktree")
      execSync(
        `git worktree add ${JSON.stringify(workDir)} -b ${JSON.stringify(branch)} ${startRef}`,
        { ...gitOpts, cwd: bareDir },
      )

      execSync(`git remote set-url origin ${JSON.stringify(repoUrl)}`, {
        ...gitOpts,
        cwd: workDir,
      })

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
        // Clean up the branch so slug collisions don't block future sessions
        if (topicSession.branch) {
          try {
            await execFileAsync("git", ["branch", "-D", topicSession.branch], {
              cwd: bareDir, timeout: 10_000,
            })
            log.debug({ branch: topicSession.branch }, "removed branch")
          } catch {
            // branch may not exist
          }
        }
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
      makeNodeModulesReadOnly(path.join(pkgDir, "node_modules"), label)
      return
    } catch (err) {
      log.warn({ err, label }, "hardlink copy failed, falling back to npm ci")
    }
  }

  try {
    const installCmd = fs.existsSync(lockFile) ? "npm ci --prefer-offline" : "npm install --prefer-offline"
    log.debug({ installCmd, label }, "running package install")
    execSync(installCmd, { cwd: pkgDir, stdio, timeout: 300_000 })

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
    makeNodeModulesReadOnly(path.join(pkgDir, "node_modules"), label)
  } catch (err) {
    log.warn({ err, label }, "dependency bootstrap failed (non-fatal)")
  }
}

/**
 * Make node_modules read-only to prevent agents from running `npm install`
 * and breaking the hardlink cache. Uses `chmod -R a-w` so npm fails fast
 * instead of silently duplicating everything.
 */
function makeNodeModulesReadOnly(nmDir: string, label: string): void {
  try {
    execSync(`chmod -R a-w ${JSON.stringify(nmDir)}`, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    })
    log.debug({ label }, "made node_modules read-only")
  } catch (err) {
    log.warn({ err, label }, "failed to make node_modules read-only (non-fatal)")
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
        // Restore write permissions before removal (node_modules may be read-only)
        try {
          execSync(`chmod -R u+w ${JSON.stringify(target)}`, {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30_000,
          })
        } catch { /* best-effort */ }
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
        try {
          execSync(`chmod -R u+w ${JSON.stringify(nested)}`, {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30_000,
          })
        } catch { /* best-effort */ }
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
    fetchBareRepo(bareDir, gitOpts)

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
