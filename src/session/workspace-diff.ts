import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"

const execFile = promisify(execFileCb)

const GIT_TIMEOUT_MS = 30_000
const MAX_PATCH_BYTES = 10 * 1024 * 1024

export interface WorkspaceDiff {
  /** Reference that was compared against — `main`, `master`, or `HEAD` fallback. */
  base: string
  /** Head reference that was diffed — the session's branch or plain `HEAD`. */
  head: string
  /** Unified-diff text. Empty string when there are no changes. */
  patch: string
  /** True when the patch was truncated at MAX_PATCH_BYTES. */
  truncated: boolean
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    encoding: "utf-8",
    maxBuffer: MAX_PATCH_BYTES + 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  return stdout
}

async function hasRef(cwd: string, ref: string): Promise<boolean> {
  try {
    await gitOutput(cwd, ["rev-parse", "--verify", ref])
    return true
  } catch {
    return false
  }
}

/**
 * Compute a unified diff for a session's worktree.
 *
 * Resolution order for the base reference:
 *   1. `origin/main`
 *   2. `origin/master`
 *   3. local `main`
 *   4. local `master`
 *   5. fall back to `HEAD`, which produces an unstaged-changes diff only
 *
 * The `head` is always `HEAD` — callers can combine with `session.branch`
 * for display purposes.
 */
export async function computeWorkspaceDiff(cwd: string, headBranch?: string): Promise<WorkspaceDiff> {
  const candidates = ["refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"]
  let base = "HEAD"
  for (const ref of candidates) {
    if (await hasRef(cwd, ref)) {
      base = ref.replace(/^refs\/(heads|remotes)\//, "")
      break
    }
  }

  // `git diff <base>` covers both committed-on-branch and uncommitted
  // working-tree changes, which is what a "preview this PR" view needs.
  const raw = await gitOutput(cwd, ["diff", "--no-color", base])
  const truncated = raw.length > MAX_PATCH_BYTES
  const patch = truncated ? raw.slice(0, MAX_PATCH_BYTES) : raw

  return {
    base,
    head: headBranch ?? "HEAD",
    patch,
    truncated,
  }
}
