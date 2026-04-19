import { execFile as execFileCb } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { existsSync } from "node:fs"
import { extractRepoName } from "../commands/command-parser.js"
import type { EngineContext } from "../engine/engine-context.js"
import type { TopicSession } from "../domain/session-types.js"
import type { DagGraph, DagNode } from "./dag.js"
import { topologicalSort, cleanupMergedBranch } from "./dag.js"
import { runPreflightStaging } from "./preflight.js"
import { updateAllStackComments } from "./pr-stack-comment.js"
import {
  formatLandStart,
  formatLandProgress,
  formatLandComplete,
  formatLandError,
  formatLandSkipped,
  formatLandSummary,
  formatLandPreflightStart,
  formatLandPreflightPassed,
  formatLandPreflightFailed,
  formatLandRecovered,
  formatLandFailedClosed,
  formatLandPreRetarget,
} from "../telegram/format.js"
import { loggers } from "../logger.js"

const log = loggers.dispatcher

const execFile = promisify(execFileCb)

const EXEC_TIMEOUT = 120_000
const MERGEABILITY_POLL_DELAY = 5_000
const MERGEABILITY_POLL_MAX = 6
const LAND_STEP_DELAY_MS = 3_000

async function gh(args: string[], opts?: { cwd?: string; timeout?: number }): Promise<string> {
  const { stdout } = await execFile("gh", args, {
    cwd: opts?.cwd,
    timeout: opts?.timeout ?? EXEC_TIMEOUT,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  return stdout.trim()
}

async function git(args: string[], opts: { cwd: string; timeout?: number; env?: Record<string, string> }): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? EXEC_TIMEOUT,
    encoding: "utf-8",
    env: { ...process.env, ...opts.env },
  })
  return stdout.trim()
}

function repoFromPrUrl(prUrl: string): string | undefined {
  const m = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)
  return m?.[1]
}

function prNumberFromUrl(prUrl: string): string | undefined {
  const m = prUrl.match(/\/pull\/(\d+)/)
  return m?.[1]
}

export class LandingManager {
  constructor(private readonly ctx: EngineContext) {}

  async handleLandCommand(topicSession: TopicSession): Promise<void> {
    const ac = new AbortController()
    this.ctx.abortControllers.set(topicSession.threadId, ac)
    try {
      await this._handleLandCommand(topicSession, ac.signal)
    } finally {
      this.ctx.abortControllers.delete(topicSession.threadId)
    }
  }

  private async _handleLandCommand(topicSession: TopicSession, signal: AbortSignal): Promise<void> {
    await this.ctx.refreshGitToken()
    if (!topicSession.dagId) {
      if (!topicSession.childThreadIds || topicSession.childThreadIds.length === 0) {
        await this.ctx.postStatus(topicSession, `⚠️ No DAG or stack found for this session. Use <code>/stack</code> or <code>/dag</code> first.`)
        return
      }
    }

    const graph = topicSession.dagId ? this.ctx.dags.get(topicSession.dagId) : undefined

    if (graph) {
      await this.landDag(topicSession, graph, signal)
    } else {
      await this.landChildPRs(topicSession, signal)
    }
  }

  private async landDag(topicSession: TopicSession, graph: DagGraph, signal: AbortSignal): Promise<void> {
    const sorted = topologicalSort(graph)
    const prNodes = sorted
      .map((id) => graph.nodes.find((n) => n.id === id)!)
      .filter((n) => n.status === "done" && n.prUrl)

    if (prNodes.length === 0) {
      await this.ctx.postStatus(topicSession, `⚠️ No completed PRs to land.`)
      return
    }

    const repo = repoFromPrUrl(prNodes[0].prUrl!)
    const baseBranch = await this.detectBaseBranch(repo, topicSession, graph)

    // Pre-flight: cherry-pick all nodes onto a throwaway branch off origin/<base>
    await this.ctx.postStatus(topicSession, formatLandPreflightStart(topicSession.slug, prNodes.length))

    const hostCwd = this.findValidCwd(topicSession, graph)
    const preflight = hostCwd
      ? await runPreflightStaging(graph, prNodes, baseBranch, hostCwd)
      : { ok: false as const, error: "no valid cwd for pre-flight staging" }

    if (!preflight.ok) {
      const title = preflight.failedNode?.title ?? "unknown node"
      await this.ctx.postStatus(topicSession, formatLandPreflightFailed(title, preflight.conflictFiles ?? [], preflight.error))
      if (preflight.error) {
        log.warn({ dagId: graph.id, nodeId: preflight.failedNode?.id, error: preflight.error }, "preflight failed with error")
      }
      return
    }

    await this.ctx.postStatus(topicSession, formatLandPreflightPassed(prNodes.length))

    // Pre-flight retarget: point every PR at baseBranch BEFORE any merges. This
    // prevents GitHub from auto-closing downstream PRs when we squash-merge with
    // --delete-branch — a stacked PR loses its base when the upstream branch is
    // deleted, and GitHub closes it. Retargeting first keeps every PR anchored
    // to baseBranch so deletions never cascade.
    await this.ctx.postStatus(topicSession, formatLandPreRetarget(prNodes.length, baseBranch))
    await this.preRetargetToBase(prNodes, baseBranch)

    // Clean up child worktrees so branch deletion doesn't hit a lock
    await this.pruneWorktrees(topicSession)
    await this.removeChildWorktrees(topicSession, graph)
    await this.pruneWorktrees(topicSession)

    await this.ctx.postStatus(topicSession, formatLandStart(topicSession.slug, prNodes.length))

    let succeeded = 0
    let recovered = 0
    let skipped = 0
    const failedTitles: string[] = []

    for (const node of prNodes) {
      if (signal.aborted) break
      const nodeRepo = repoFromPrUrl(node.prUrl!) ?? repo
      const repoFlag = nodeRepo ? ["--repo", nodeRepo] : []
      const prNumber = prNumberFromUrl(node.prUrl!)

      if (!prNumber) {
        failedTitles.push(node.title)
        await this.ctx.postStatus(topicSession, formatLandError(node.title, "could not parse PR number from URL"))
        continue
      }

      let wasRecovered = false
      try {
        const prState = await gh(["pr", "view", prNumber, ...repoFlag, "--json", "state", "--jq", ".state"])
        if (prState === "MERGED") {
          node.status = "landed"
          skipped++
          await this.ctx.postStatus(topicSession, formatLandSkipped(node.title, prState))
          continue
        }
        if (prState === "CLOSED") {
          try {
            await gh(["pr", "edit", prNumber, ...repoFlag, "--base", baseBranch])
            await gh(["pr", "reopen", prNumber, ...repoFlag])
            wasRecovered = true
            log.info({ nodeId: node.id, prNumber }, "reopened auto-closed PR")
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            failedTitles.push(node.title)
            log.error({ err, nodeId: node.id, prNumber }, "failed to reopen auto-closed PR")
            await this.ctx.postStatus(topicSession, formatLandFailedClosed(node.title, errMsg))
            continue
          }
        }
      } catch (err) {
        log.warn({ err, nodeId: node.id }, "PR state check failed, attempting merge anyway")
      }

      // Ensure PR is targeting the base branch (GitHub auto-retargets after upstream merge,
      // but be explicit in case the previous merge didn't get picked up yet).
      try {
        await gh(["pr", "edit", prNumber, ...repoFlag, "--base", baseBranch])
      } catch (err) {
        log.warn({ err, nodeId: node.id }, "pre-merge retarget to base failed — continuing")
      }

      await this.waitForMergeability(prNumber, repoFlag, signal)

      try {
        try {
          await gh(["pr", "merge", prNumber, ...repoFlag, "--squash", "--delete-branch"])
        } catch (mergeErr) {
          let actualState: string | undefined
          try {
            actualState = await gh(["pr", "view", prNumber, ...repoFlag, "--json", "state", "--jq", ".state"])
          } catch { /* best-effort */ }
          if (actualState !== "MERGED") throw mergeErr
          log.warn(
            { nodeId: node.id, prNumber, err: mergeErr instanceof Error ? mergeErr.message : String(mergeErr) },
            "gh pr merge errored but PR state is MERGED — treating as success",
          )
        }

        node.status = "landed"
        succeeded++
        if (wasRecovered) recovered++

        if (node.branch) {
          const worktreePath = this.findWorktreePathForBranch(node)
          const cwd = this.findValidCwd(topicSession, graph)
          if (cwd) {
            await cleanupMergedBranch(node.branch, worktreePath, cwd).catch(() => { /* best-effort */ })
          }
        }

        await this.ctx.postStatus(topicSession, wasRecovered
            ? formatLandRecovered(node.title, node.prUrl!, succeeded - 1, prNodes.length)
            : formatLandProgress(node.title, node.prUrl!, succeeded - 1, prNodes.length))

        // Update stack comments on remaining PRs so reviewers see the new state.
        try { await updateAllStackComments(graph) } catch { /* non-critical */ }

        // Small pause so GitHub can process the auto-retarget of downstream PRs.
        await new Promise((resolve) => setTimeout(resolve, LAND_STEP_DELAY_MS))
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        failedTitles.push(node.title)
        await this.ctx.postStatus(topicSession, formatLandError(node.title, errMsg))
        continue
      }
    }

    try { await updateAllStackComments(graph) } catch { /* non-critical */ }

    if (failedTitles.length === 0 && skipped === 0) {
      await this.ctx.postStatus(topicSession, formatLandComplete(succeeded, prNodes.length, baseBranch))
      // All PRs landed — clean up DAG and child sessions to free memory
      this.ctx.dags.delete(graph.id)
      this.ctx.broadcastDagDeleted(graph.id)
      await this.ctx.closeChildSessions(topicSession)
      await this.ctx.persistDags()
    } else {
      await this.ctx.postStatus(topicSession, formatLandSummary(succeeded, failedTitles.length, skipped, prNodes.length, failedTitles, baseBranch, recovered))
    }
  }

  private async preRetargetToBase(prNodes: DagNode[], baseBranch: string): Promise<void> {
    for (const node of prNodes) {
      const prNumber = prNumberFromUrl(node.prUrl!)
      if (!prNumber) continue
      const nodeRepo = repoFromPrUrl(node.prUrl!)
      const repoFlag = nodeRepo ? ["--repo", nodeRepo] : []
      try {
        await gh(["pr", "edit", prNumber, ...repoFlag, "--base", baseBranch])
        log.info({ nodeId: node.id, prNumber, baseBranch }, "pre-retargeted PR to base")
      } catch (err) {
        log.warn({ err, nodeId: node.id, prNumber }, "pre-retarget to base failed — will retry inline")
      }
    }
  }

  private async waitForMergeability(prNumber: string, repoFlag: string[], signal?: AbortSignal): Promise<void> {
    for (let i = 0; i < MERGEABILITY_POLL_MAX; i++) {
      if (signal?.aborted) return
      try {
        const state = await gh(["pr", "view", prNumber, ...repoFlag, "--json", "mergeable", "--jq", ".mergeable"])
        if (state === "MERGEABLE") return
      } catch { /* continue polling */ }
      await new Promise<void>((r) => {
        const timer = setTimeout(r, MERGEABILITY_POLL_DELAY)
        signal?.addEventListener("abort", () => { clearTimeout(timer); r() }, { once: true })
      })
    }
  }

  private async pruneWorktrees(topicSession: TopicSession): Promise<void> {
    const bareDir = this.resolveBareDir(topicSession)
    if (!bareDir) return
    try {
      await git(["worktree", "prune"], { cwd: bareDir, timeout: 30_000 })
      log.info({ bareDir }, "pruned stale worktrees before landing")
    } catch (err) {
      log.warn({ err, bareDir }, "failed to prune worktrees")
    }
  }

  private async removeChildWorktrees(topicSession: TopicSession, graph: DagGraph): Promise<void> {
    const bareDir = this.resolveBareDir(topicSession)
    const cwd = bareDir ?? topicSession.cwd
    if (!cwd) return

    for (const node of graph.nodes) {
      if (node.status === "running" || node.status === "pending" || node.status === "ready") continue
      const worktreePath = this.findWorktreePathForBranch(node)
      if (worktreePath && existsSync(worktreePath)) {
        try {
          await git(["worktree", "remove", "--force", worktreePath], { cwd })
          log.info({ nodeId: node.id, worktreePath }, "removed worktree before landing")
        } catch (err) {
          log.warn({ nodeId: node.id, worktreePath, err }, "failed to remove worktree before landing")
          try {
            fs.rmSync(worktreePath, { recursive: true, force: true })
            log.info({ nodeId: node.id, worktreePath }, "force-removed worktree directory after git remove failed")
          } catch {
            // directory may be locked or already gone
          }
        }
      }
    }
  }

  private resolveBareDir(topicSession: TopicSession): string | undefined {
    if (!topicSession.repoUrl) return undefined
    const repoName = extractRepoName(topicSession.repoUrl)
    const bareDir = path.join(this.ctx.config.workspace.root, ".repos", `${repoName}.git`)
    return existsSync(bareDir) ? bareDir : undefined
  }

  private findValidCwd(topicSession: TopicSession, graph?: DagGraph): string | undefined {
    const candidates: (string | undefined)[] = []

    if (graph) {
      for (const node of graph.nodes) {
        if (node.threadId) {
          const child = this.ctx.topicSessions.get(node.threadId)
          if (child?.cwd) candidates.push(child.cwd)
        }
      }
    }

    if (topicSession.childThreadIds) {
      for (const id of topicSession.childThreadIds) {
        const child = this.ctx.topicSessions.get(id)
        if (child?.cwd) candidates.push(child.cwd)
      }
    }

    candidates.push(topicSession.cwd)

    for (const c of candidates) {
      if (c && existsSync(c) && this.isValidGitDir(c)) return c
    }

    return undefined
  }

  private isValidGitDir(dir: string): boolean {
    const gitPath = path.join(dir, ".git")
    try {
      const stat = fs.statSync(gitPath)
      if (stat.isDirectory()) return true
      // Worktree: .git is a file containing "gitdir: /path/to/metadata"
      const content = fs.readFileSync(gitPath, "utf8").trim()
      const match = content.match(/^gitdir:\s*(.+)$/)
      if (!match) return false
      return existsSync(match[1])
    } catch {
      return false
    }
  }

  private async detectBaseBranch(repo: string | undefined, topicSession: TopicSession, graph?: DagGraph): Promise<string> {
    try {
      const repoArg = repo ? [repo] : []
      return await gh(["repo", "view", ...repoArg, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"])
    } catch (err) {
      log.warn({ err, repo }, "gh repo view failed — falling back to local git ref detection")
    }

    const cwd = this.findValidCwd(topicSession, graph)
    if (cwd) {
      for (const name of ["main", "master"]) {
        try {
          await git(["rev-parse", "--verify", `refs/heads/${name}`], { cwd, timeout: 10_000 })
          return name
        } catch { /* try next */ }
      }
    }

    log.warn({ repo }, "could not detect default branch — falling back to 'main'")
    return "main"
  }

  private findWorktreePathForBranch(node: DagNode): string | undefined {
    if (node.threadId) {
      const child = this.ctx.topicSessions.get(node.threadId)
      if (child?.cwd) return child.cwd
    }
    return undefined
  }

  private async landChildPRs(topicSession: TopicSession, signal: AbortSignal): Promise<void> {
    if (!topicSession.childThreadIds) return

    const prUrls: { title: string; prUrl: string }[] = []
    for (const childId of topicSession.childThreadIds) {
      const child = this.ctx.topicSessions.get(childId)
      if (child) {
        const prUrl = this.ctx.extractPRFromConversation(child)
        if (prUrl) {
          prUrls.push({ title: child.splitLabel ?? child.slug, prUrl })
        }
      }
    }

    if (prUrls.length === 0) {
      await this.ctx.postStatus(topicSession, `⚠️ No PRs found among child sessions.`)
      return
    }

    await this.ctx.postStatus(topicSession, formatLandStart(topicSession.slug, prUrls.length))

    let succeeded = 0
    let skipped = 0
    const failedTitles: string[] = []

    for (const { title, prUrl } of prUrls) {
      if (signal.aborted) break
      const nodeRepo = repoFromPrUrl(prUrl)
      const repoFlag = nodeRepo ? ["--repo", nodeRepo] : []
      const prNumber = prNumberFromUrl(prUrl)

      if (!prNumber) {
        failedTitles.push(title)
        await this.ctx.postStatus(topicSession, formatLandError(title, "could not parse PR number from URL"))
        continue
      }

      try {
        const prState = await gh(["pr", "view", prNumber, ...repoFlag, "--json", "state", "--jq", ".state"])

        if (prState === "MERGED") {
          skipped++
          await this.ctx.postStatus(topicSession, formatLandSkipped(title, prState))
          continue
        }

        if (prState === "CLOSED") {
          skipped++
          await this.ctx.postStatus(topicSession, formatLandSkipped(title, prState))
          continue
        }
      } catch (err) {
        log.warn({ err, prUrl }, "PR state check failed, attempting merge anyway")
      }

      try {
        await gh(["pr", "merge", prNumber, ...repoFlag, "--squash", "--delete-branch"])
        succeeded++

        await this.ctx.postStatus(topicSession, formatLandProgress(title, prUrl, succeeded - 1, prUrls.length))

        await new Promise((resolve) => setTimeout(resolve, LAND_STEP_DELAY_MS))
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        failedTitles.push(title)
        await this.ctx.postStatus(topicSession, formatLandError(title, errMsg))
        continue
      }
    }

    if (failedTitles.length === 0 && skipped === 0) {
      await this.ctx.postStatus(topicSession, formatLandComplete(succeeded, prUrls.length))
      // All PRs landed — clean up child sessions to free memory
      await this.ctx.closeChildSessions(topicSession)
    } else {
      await this.ctx.postStatus(topicSession, formatLandSummary(succeeded, failedTitles.length, skipped, prUrls.length, failedTitles))
    }
  }
}
