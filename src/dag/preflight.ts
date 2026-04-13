import { execFile as execFileCb } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { topologicalSort, type DagGraph, type DagNode } from "./dag.js"
import { loggers } from "../logger.js"

const log = loggers.dispatcher
const execFile = promisify(execFileCb)

const GIT_TIMEOUT = 120_000
const FETCH_TIMEOUT = 180_000

async function git(args: string[], cwd: string, timeout = GIT_TIMEOUT): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    timeout,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  return stdout.trim()
}

export interface PreflightSuccess {
  ok: true
}

export interface PreflightFailure {
  ok: false
  failedNode?: DagNode
  conflictFiles?: string[]
  error?: string
}

export type PreflightResult = PreflightSuccess | PreflightFailure

/**
 * Cherry-pick the commits in (baseSha, headSha] onto the current HEAD of `cwd`.
 * Returns a success marker or the list of unmerged files if the cherry-pick
 * aborted due to conflicts. The cherry-pick is always either clean or aborted —
 * no half-applied state remains on failure.
 */
export async function cherryPickRange(
  cwd: string,
  baseSha: string,
  headSha: string,
): Promise<{ ok: true } | { ok: false; files: string[]; error: string }> {
  if (baseSha === headSha) return { ok: true }

  try {
    // --keep-redundant-commits so cherry-pick doesn't stop on commits whose
    // changes are already in the tree (can happen on fan-in nodes).
    await git(
      ["cherry-pick", "--keep-redundant-commits", `${baseSha}..${headSha}`],
      cwd,
      FETCH_TIMEOUT,
    )
    return { ok: true }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    let files: string[] = []
    try {
      const raw = await git(["diff", "--name-only", "--diff-filter=U"], cwd, 15_000)
      files = raw.split("\n").map((l) => l.trim()).filter(Boolean)
    } catch {
      // best-effort; fall through
    }
    try {
      await git(["cherry-pick", "--abort"], cwd, 15_000)
    } catch {
      // already aborted or in bad state
    }
    return { ok: false, files, error: errMsg }
  }
}

/**
 * Pre-flight: cherry-pick every PR node's logical diff onto a throwaway
 * worktree based on origin/<baseBranch> in topological order. If any node
 * conflicts, abort and return the failing node plus the unmerged file list.
 * The caller's working tree is never touched; all work happens in a fresh
 * detached worktree and is cleaned up on return.
 */
export async function runPreflightStaging(
  graph: DagGraph,
  prNodes: DagNode[],
  baseBranch: string,
  hostCwd: string,
): Promise<PreflightResult> {
  const stagingDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `dag-preflight-${graph.id.replace(/[^a-z0-9]/gi, "_")}-`),
  )
  let worktreeCreated = false

  try {
    const branches = Array.from(
      new Set(prNodes.map((n) => n.branch).filter((b): b is string => !!b)),
    )

    try {
      await git(["fetch", "origin", baseBranch, ...branches], hostCwd, FETCH_TIMEOUT)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `fetch failed: ${msg}` }
    }

    try {
      await git(
        ["worktree", "add", "--detach", stagingDir, `origin/${baseBranch}`],
        hostCwd,
        30_000,
      )
      worktreeCreated = true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `worktree add failed: ${msg}` }
    }

    // Order nodes topologically so each cherry-pick builds on the previous ones.
    const order = topologicalSort(graph)
    const orderedPrNodes: DagNode[] = order
      .map((id) => prNodes.find((n) => n.id === id))
      .filter((n): n is DagNode => !!n)

    for (const node of orderedPrNodes) {
      if (!node.branch) {
        return { ok: false, failedNode: node, error: `node ${node.id} has no branch` }
      }

      let headSha: string
      try {
        headSha = await git(["rev-parse", `origin/${node.branch}`], stagingDir, 20_000)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, failedNode: node, error: `failed to resolve origin/${node.branch}: ${msg}` }
      }

      let baseSha = node.baseSha ?? node.mergeBase
      if (!baseSha) {
        try {
          baseSha = await git(
            ["merge-base", `origin/${node.branch}`, `origin/${baseBranch}`],
            stagingDir,
            20_000,
          )
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { ok: false, failedNode: node, error: `merge-base failed: ${msg}` }
        }
      }

      const result = await cherryPickRange(stagingDir, baseSha, headSha)
      if (!result.ok) {
        return { ok: false, failedNode: node, conflictFiles: result.files, error: result.error }
      }
    }

    return { ok: true }
  } finally {
    if (worktreeCreated) {
      try {
        await git(["worktree", "remove", "--force", stagingDir], hostCwd, 30_000)
      } catch (err) {
        log.warn({ err, stagingDir }, "failed to remove preflight worktree")
      }
    }
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
}
