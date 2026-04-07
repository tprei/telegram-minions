import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"
import { existsSync } from "node:fs"
import type { DispatcherContext } from "../orchestration/dispatcher-context.js"
import type { TopicSession } from "../domain/session-types.js"
import type { DagGraph, DagNode } from "./dag.js"
import { topologicalSort, needsRestack, cleanupMergedBranch, getDownstreamNodes } from "./dag.js"
import { resolveConflictsWithAgent, resolvePhantomConflicts } from "../conflict-resolver.js"
import {
  esc,
  formatLandStart,
  formatLandProgress,
  formatLandComplete,
  formatLandError,
  formatLandSkipped,
  formatLandSummary,
  formatLandConflictResolution,
  formatLandRestacking,
} from "../telegram/format.js"
import { loggers } from "../logger.js"

const log = loggers.dispatcher

const execFile = promisify(execFileCb)

const EXEC_TIMEOUT = 120_000
const MERGEABILITY_POLL_DELAY = 5_000
const MERGEABILITY_POLL_MAX = 6

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
  constructor(private readonly ctx: DispatcherContext) {}

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
        await this.ctx.telegram.sendMessage(
          `⚠️ No DAG or stack found for this session. Use <code>/stack</code> or <code>/dag</code> first.`,
          topicSession.threadId,
        )
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
      await this.ctx.telegram.sendMessage(
        `⚠️ No completed PRs to land.`,
        topicSession.threadId,
      )
      return
    }

    const repo = prNodes.find((n) => n.prUrl)?.prUrl ? repoFromPrUrl(prNodes.find((n) => n.prUrl)!.prUrl!) : undefined
    const baseBranch = await this.detectBaseBranch(repo, topicSession, graph)

    await this.removeChildWorktrees(topicSession, graph)

    await this.ctx.telegram.sendMessage(
      formatLandStart(topicSession.slug, prNodes.length),
      topicSession.threadId,
    )

    let succeeded = 0
    let skipped = 0
    const failedTitles: string[] = []
    const skipNodeIds = new Set<string>()

    for (const node of prNodes) {
      if (signal.aborted) break
      if (skipNodeIds.has(node.id)) {
        skipped++
        await this.ctx.telegram.sendMessage(
          formatLandSkipped(node.title, "upstream restack failed"),
          topicSession.threadId,
        )
        continue
      }
      const nodeRepo = repoFromPrUrl(node.prUrl!) ?? repo
      const repoFlag = nodeRepo ? ["--repo", nodeRepo] : []
      const prNumber = prNumberFromUrl(node.prUrl!)

      if (!prNumber) {
        failedTitles.push(node.title)
        await this.ctx.telegram.sendMessage(
          formatLandError(node.title, "could not parse PR number from URL"),
          topicSession.threadId,
        )
        continue
      }

      try {
        const prState = await gh(["pr", "view", prNumber, ...repoFlag, "--json", "state", "--jq", ".state"])

        if (prState === "MERGED") {
          node.status = "landed"
          skipped++
          await this.ctx.telegram.sendMessage(
            formatLandSkipped(node.title, prState),
            topicSession.threadId,
          )
          continue
        }

        if (prState === "CLOSED") {
          skipped++
          await this.ctx.telegram.sendMessage(
            formatLandSkipped(node.title, prState),
            topicSession.threadId,
          )
          continue
        }
      } catch (err) {
        log.warn({ err, nodeId: node.id }, "PR state check failed, attempting merge anyway")
      }

      await this.ensureMergeable(node, baseBranch, topicSession, graph, signal)

      try {
        await gh(["pr", "merge", prNumber, ...repoFlag, "--squash", "--delete-branch"])
        node.status = "landed"
        succeeded++

        if (node.branch) {
          const worktreePath = this.findWorktreePathForBranch(node)
          const cwd = this.findValidCwd(topicSession, graph)
          if (cwd) {
            await cleanupMergedBranch(node.branch, worktreePath, cwd)
          }
        }

        await this.ctx.telegram.sendMessage(
          formatLandProgress(node.title, node.prUrl!, succeeded - 1, prNodes.length),
          topicSession.threadId,
        )

        const toRestack = needsRestack(graph, node.id, { includeDone: true })
        for (const downstream of toRestack) {
          if (!downstream.branch || !downstream.prUrl) continue

          const dsCwd = this.findWorktreePathForBranch(downstream)
          const useOwnWorktree = !!(dsCwd && existsSync(dsCwd))
          const restackCwd = useOwnWorktree ? dsCwd : this.findValidCwd(topicSession, graph)
          if (!restackCwd) {
            log.warn({ nodeId: downstream.id }, "no valid cwd for restacking — skipping")
            continue
          }

          await this.ctx.telegram.sendMessage(
            formatLandRestacking(downstream.title, downstream.branch),
            topicSession.threadId,
          )

          try {
            const newBase = `origin/${baseBranch}`

            await git(["fetch", "origin", baseBranch], { cwd: restackCwd })
            if (!useOwnWorktree) {
              await git(["checkout", downstream.branch], { cwd: restackCwd })
            }
            await git(["rebase", "--onto", newBase, downstream.mergeBase!, downstream.branch], { cwd: restackCwd })
            await git(["push", "--force-with-lease", "origin", downstream.branch], { cwd: restackCwd })

            downstream.mergeBase = await git(["rev-parse", "HEAD"], { cwd: restackCwd, timeout: 10_000 })

            const dsRepo = repoFromPrUrl(downstream.prUrl!)
            const dsRepoFlag = dsRepo ? ["--repo", dsRepo] : repoFlag
            const dsNumber = prNumberFromUrl(downstream.prUrl!)
            if (dsNumber) {
              await gh(["pr", "edit", dsNumber, ...dsRepoFlag, "--base", baseBranch])
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            log.error({ err, nodeId: downstream.id, branch: downstream.branch }, "restack failed")

            let conflictResolved = false
            try {
              const unmerged = await git(["diff", "--name-only", "--diff-filter=U"], { cwd: restackCwd })
              if (unmerged.length > 0) {
                const { resolved: phantomResolved, remaining } = await resolvePhantomConflicts(restackCwd)
                if (remaining.length > 0) {
                  await this.ctx.telegram.sendMessage(
                    `🤖 Attempting conflict resolution for <b>${esc(downstream.title)}</b>…`,
                    topicSession.threadId,
                  )
                  conflictResolved = await resolveConflictsWithAgent(restackCwd, downstream.branch!, baseBranch)
                } else {
                  conflictResolved = phantomResolved.length > 0
                }

                if (conflictResolved) {
                  await git(["rebase", "--continue"], { cwd: restackCwd, env: { GIT_EDITOR: "true" } })
                  await git(["push", "--force-with-lease", "origin", downstream.branch], { cwd: restackCwd })
                  downstream.mergeBase = await git(["rev-parse", "HEAD"], { cwd: restackCwd, timeout: 10_000 })

                  const dsRepo = repoFromPrUrl(downstream.prUrl!)
                  const dsRepoFlag = dsRepo ? ["--repo", dsRepo] : repoFlag
                  const dsNumber = prNumberFromUrl(downstream.prUrl!)
                  if (dsNumber) {
                    await gh(["pr", "edit", dsNumber, ...dsRepoFlag, "--base", baseBranch])
                  }
                }

                await this.ctx.telegram.sendMessage(
                  formatLandConflictResolution(downstream.title, downstream.branch, conflictResolved),
                  topicSession.threadId,
                )
              }
            } catch {
              // Conflict resolution itself failed
            }

            if (!conflictResolved) {
              await this.ctx.telegram.sendMessage(
                `⚠️ Restack failed for <b>${esc(downstream.title)}</b>: <code>${esc(errMsg)}</code>`,
                topicSession.threadId,
              )
              try { await git(["rebase", "--abort"], { cwd: restackCwd }) } catch { /* ignore */ }

              const transitiveSkips = getDownstreamNodes(graph, downstream.id)
              for (const dep of transitiveSkips) {
                skipNodeIds.add(dep.id)
              }
              skipNodeIds.add(downstream.id)
              if (transitiveSkips.length > 0) {
                const names = transitiveSkips.map((n) => n.title).join(", ")
                await this.ctx.telegram.sendMessage(
                  `⏭️ Skipping ${transitiveSkips.length} downstream node(s) due to restack failure: ${esc(names)}`,
                  topicSession.threadId,
                )
              }
            }
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 3000))
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        failedTitles.push(node.title)
        await this.ctx.telegram.sendMessage(
          formatLandError(node.title, errMsg),
          topicSession.threadId,
        )
        continue
      }
    }

    if (failedTitles.length === 0 && skipped === 0) {
      await this.ctx.telegram.sendMessage(
        formatLandComplete(succeeded, prNodes.length, baseBranch),
        topicSession.threadId,
      )
    } else {
      await this.ctx.telegram.sendMessage(
        formatLandSummary(succeeded, failedTitles.length, skipped, prNodes.length, failedTitles, baseBranch),
        topicSession.threadId,
      )
    }
  }

  private async ensureMergeable(
    node: DagNode,
    baseBranch: string,
    topicSession: TopicSession,
    graph: DagGraph,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return
    const repo = repoFromPrUrl(node.prUrl!)
    const prNumber = prNumberFromUrl(node.prUrl!)
    if (!repo || !prNumber) return

    const repoFlag = ["--repo", repo]

    let mergeable: string
    try {
      mergeable = await gh(["pr", "view", prNumber, ...repoFlag, "--json", "mergeable", "--jq", ".mergeable"])
    } catch {
      return
    }

    if (mergeable === "MERGEABLE") return

    if (!node.branch) {
      log.warn({ nodeId: node.id, mergeable }, "PR not mergeable and no branch info for rebase")
      return
    }

    const nodeCwd = this.findWorktreePathForBranch(node)
    const useOwnWorktree = !!(nodeCwd && existsSync(nodeCwd))
    const cwd = useOwnWorktree ? nodeCwd : this.findValidCwd(topicSession, graph)
    if (!cwd) {
      log.warn({ nodeId: node.id }, "PR not mergeable but no valid cwd for rebase")
      return
    }

    await this.ctx.telegram.sendMessage(
      `🔄 Rebasing <b>${esc(node.title)}</b> to resolve conflicts…`,
      topicSession.threadId,
    )

    try {
      await git(["fetch", "origin", node.branch, baseBranch], { cwd })
      if (!useOwnWorktree) {
        await git(["checkout", node.branch], { cwd })
      }
      if (node.mergeBase) {
        await git(["rebase", "--onto", `origin/${baseBranch}`, node.mergeBase, node.branch], { cwd })
      } else {
        await git(["rebase", `origin/${baseBranch}`], { cwd })
      }
      await git(["push", "--force-with-lease", "origin", node.branch], { cwd })

      await this.ctx.telegram.sendMessage(
        `✅ Rebased <b>${esc(node.title)}</b>`,
        topicSession.threadId,
      )

      await this.waitForMergeability(prNumber, repoFlag)
    } catch {
      try {
        const unmerged = await git(["diff", "--name-only", "--diff-filter=U"], { cwd })
        if (unmerged.length > 0) {
          const { resolved: phantomResolved, remaining } = await resolvePhantomConflicts(cwd)
          let allResolved = remaining.length === 0 && phantomResolved.length > 0
          if (remaining.length > 0) {
            await this.ctx.telegram.sendMessage(
              `🤖 Attempting conflict resolution for <b>${esc(node.title)}</b>…`,
              topicSession.threadId,
            )
            allResolved = await resolveConflictsWithAgent(cwd, node.branch, baseBranch)
          }

          if (allResolved) {
            await git(["rebase", "--continue"], { cwd, env: { GIT_EDITOR: "true" } })
            await git(["push", "--force-with-lease", "origin", node.branch], { cwd })

            await this.ctx.telegram.sendMessage(
              formatLandConflictResolution(node.title, node.branch, true),
              topicSession.threadId,
            )

            await this.waitForMergeability(prNumber, repoFlag)
            return
          }
        }
      } catch { /* fall through */ }

      try { await git(["rebase", "--abort"], { cwd }) } catch { /* ignore */ }
      await this.ctx.telegram.sendMessage(
        `⚠️ Could not resolve conflicts for <b>${esc(node.title)}</b>`,
        topicSession.threadId,
      )
    }
  }

  private async waitForMergeability(prNumber: string, repoFlag: string[], signal?: AbortSignal): Promise<void> {
    for (let i = 0; i < MERGEABILITY_POLL_MAX; i++) {
      if (signal?.aborted) return
      await new Promise<void>((r) => {
        const timer = setTimeout(r, MERGEABILITY_POLL_DELAY)
        signal?.addEventListener("abort", () => { clearTimeout(timer); r() }, { once: true })
      })
      if (signal?.aborted) return
      try {
        const state = await gh(["pr", "view", prNumber, ...repoFlag, "--json", "mergeable", "--jq", ".mergeable"])
        if (state === "MERGEABLE") return
      } catch { /* continue polling */ }
    }
  }

  private async removeChildWorktrees(topicSession: TopicSession, graph: DagGraph): Promise<void> {
    const mainCwd = topicSession.cwd
    if (!mainCwd) return

    for (const node of graph.nodes) {
      if (node.status === "running" || node.status === "pending" || node.status === "ready") continue
      const worktreePath = this.findWorktreePathForBranch(node)
      if (worktreePath && existsSync(worktreePath)) {
        try {
          await git(["worktree", "remove", "--force", worktreePath], { cwd: mainCwd })
          log.info({ nodeId: node.id, worktreePath }, "removed worktree before landing")
        } catch (err) {
          log.warn({ nodeId: node.id, worktreePath, err }, "failed to remove worktree before landing")
        }
      }
    }
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
      if (c && existsSync(c)) return c
    }

    return undefined
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
          await git(["rev-parse", "--verify", `origin/${name}`], { cwd, timeout: 10_000 })
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
      await this.ctx.telegram.sendMessage(
        `⚠️ No PRs found among child sessions.`,
        topicSession.threadId,
      )
      return
    }

    await this.ctx.telegram.sendMessage(
      formatLandStart(topicSession.slug, prUrls.length),
      topicSession.threadId,
    )

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
        await this.ctx.telegram.sendMessage(
          formatLandError(title, "could not parse PR number from URL"),
          topicSession.threadId,
        )
        continue
      }

      try {
        const prState = await gh(["pr", "view", prNumber, ...repoFlag, "--json", "state", "--jq", ".state"])

        if (prState === "MERGED") {
          skipped++
          await this.ctx.telegram.sendMessage(
            formatLandSkipped(title, prState),
            topicSession.threadId,
          )
          continue
        }

        if (prState === "CLOSED") {
          skipped++
          await this.ctx.telegram.sendMessage(
            formatLandSkipped(title, prState),
            topicSession.threadId,
          )
          continue
        }
      } catch (err) {
        log.warn({ err, prUrl }, "PR state check failed, attempting merge anyway")
      }

      try {
        await gh(["pr", "merge", prNumber, ...repoFlag, "--squash", "--delete-branch"])
        succeeded++

        await this.ctx.telegram.sendMessage(
          formatLandProgress(title, prUrl, succeeded - 1, prUrls.length),
          topicSession.threadId,
        )

        await new Promise((resolve) => setTimeout(resolve, 3000))
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        failedTitles.push(title)
        await this.ctx.telegram.sendMessage(
          formatLandError(title, errMsg),
          topicSession.threadId,
        )
        continue
      }
    }

    if (failedTitles.length === 0 && skipped === 0) {
      await this.ctx.telegram.sendMessage(
        formatLandComplete(succeeded, prUrls.length),
        topicSession.threadId,
      )
    } else {
      await this.ctx.telegram.sendMessage(
        formatLandSummary(succeeded, failedTitles.length, skipped, prUrls.length, failedTitles),
        topicSession.threadId,
      )
    }
  }
}
