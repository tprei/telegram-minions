import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import type { DispatcherContext } from "./dispatcher-context.js"
import type { TopicSession } from "./types.js"
import type { DagGraph, DagNode } from "./dag.js"
import { topologicalSort, needsRestack, cleanupMergedBranch } from "./dag.js"
import { resolveConflictsWithAgent } from "./conflict-resolver.js"
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
} from "./format.js"
import { loggers } from "./logger.js"

const log = loggers.dispatcher

const EXEC_TIMEOUT = 120_000
const MERGEABILITY_POLL_DELAY = 5_000
const MERGEABILITY_POLL_MAX = 6

function ghSync(args: string[], opts?: { cwd?: string; timeout?: number }): string {
  return execFileSync("gh", args, {
    cwd: opts?.cwd,
    timeout: opts?.timeout ?? EXEC_TIMEOUT,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim()
}

function gitSync(args: string[], opts: { cwd: string; timeout?: number; env?: Record<string, string> }): string {
  return execFileSync("git", args, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? EXEC_TIMEOUT,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...opts.env },
  }).trim()
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
      await this.landDag(topicSession, graph)
    } else {
      await this.landChildPRs(topicSession)
    }
  }

  private async landDag(topicSession: TopicSession, graph: DagGraph): Promise<void> {
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

    await this.ctx.telegram.sendMessage(
      formatLandStart(topicSession.slug, prNodes.length),
      topicSession.threadId,
    )

    let baseBranch: string
    try {
      const repoFlag = repo ? ["--repo", repo] : []
      baseBranch = ghSync(["repo", "view", ...repoFlag, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"])
    } catch {
      baseBranch = "main"
    }

    let succeeded = 0
    let skipped = 0
    const failedTitles: string[] = []

    for (const node of prNodes) {
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
        const prState = ghSync(["pr", "view", prNumber, ...repoFlag, "--json", "state", "--jq", ".state"])

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

      await this.ensureMergeable(node, baseBranch, topicSession, graph)

      try {
        ghSync(["pr", "merge", prNumber, ...repoFlag, "--squash", "--delete-branch"])
        node.status = "landed"
        succeeded++

        if (node.branch) {
          const worktreePath = this.findWorktreePathForBranch(node)
          const cwd = this.findValidCwd(topicSession, graph)
          if (cwd) {
            cleanupMergedBranch(node.branch, worktreePath, cwd)
          }
        }

        await this.ctx.telegram.sendMessage(
          formatLandProgress(node.title, node.prUrl!, succeeded - 1, prNodes.length),
          topicSession.threadId,
        )

        const toRestack = needsRestack(graph, node.id)
        if (toRestack.length > 0) {
          const cwd = this.findValidCwd(topicSession, graph)
          if (cwd) {
            try {
              gitSync(["fetch", "origin"], { cwd })
            } catch (err) {
              log.warn({ err, nodeId: node.id }, "git fetch failed during restack")
            }

            for (const downstream of toRestack) {
              if (!downstream.branch || !downstream.prUrl) continue

              await this.ctx.telegram.sendMessage(
                formatLandRestacking(downstream.title, downstream.branch),
                topicSession.threadId,
              )

              try {
                const newBase = `origin/${baseBranch}`

                gitSync(["checkout", downstream.branch], { cwd })
                gitSync(["rebase", "--onto", newBase, downstream.mergeBase!, downstream.branch], { cwd })
                gitSync(["push", "--force-with-lease", "origin", downstream.branch], { cwd })

                downstream.mergeBase = gitSync(["rev-parse", "HEAD"], { cwd, timeout: 10_000 })

                const dsRepo = repoFromPrUrl(downstream.prUrl!)
                const dsRepoFlag = dsRepo ? ["--repo", dsRepo] : repoFlag
                const dsNumber = prNumberFromUrl(downstream.prUrl!)
                if (dsNumber) {
                  ghSync(["pr", "edit", dsNumber, ...dsRepoFlag, "--base", baseBranch])
                }
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err)
                log.error({ err, nodeId: downstream.id, branch: downstream.branch }, "restack failed")

                let conflictResolved = false
                try {
                  const unmerged = gitSync(["diff", "--name-only", "--diff-filter=U"], { cwd })
                  if (unmerged.length > 0) {
                    await this.ctx.telegram.sendMessage(
                      `🤖 Attempting conflict resolution for <b>${esc(downstream.title)}</b>…`,
                      topicSession.threadId,
                    )
                    conflictResolved = await resolveConflictsWithAgent(cwd, downstream.branch, baseBranch)

                    if (conflictResolved) {
                      gitSync(["rebase", "--continue"], { cwd, env: { GIT_EDITOR: "true" } })
                      gitSync(["push", "--force-with-lease", "origin", downstream.branch], { cwd })
                      downstream.mergeBase = gitSync(["rev-parse", "HEAD"], { cwd, timeout: 10_000 })

                      const dsRepo = repoFromPrUrl(downstream.prUrl!)
                      const dsRepoFlag = dsRepo ? ["--repo", dsRepo] : repoFlag
                      const dsNumber = prNumberFromUrl(downstream.prUrl!)
                      if (dsNumber) {
                        ghSync(["pr", "edit", dsNumber, ...dsRepoFlag, "--base", baseBranch])
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
                  try { gitSync(["rebase", "--abort"], { cwd }) } catch { /* ignore */ }
                }
              }
            }
          } else {
            log.warn({ nodeId: node.id }, "no valid cwd for restacking — skipping restack")
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
        formatLandComplete(succeeded, prNodes.length),
        topicSession.threadId,
      )
    } else {
      await this.ctx.telegram.sendMessage(
        formatLandSummary(succeeded, failedTitles.length, skipped, prNodes.length, failedTitles),
        topicSession.threadId,
      )
    }
  }

  private async ensureMergeable(
    node: DagNode,
    baseBranch: string,
    topicSession: TopicSession,
    graph: DagGraph,
  ): Promise<void> {
    const repo = repoFromPrUrl(node.prUrl!)
    const prNumber = prNumberFromUrl(node.prUrl!)
    if (!repo || !prNumber) return

    const repoFlag = ["--repo", repo]

    let mergeable: string
    try {
      mergeable = ghSync(["pr", "view", prNumber, ...repoFlag, "--json", "mergeable", "--jq", ".mergeable"])
    } catch {
      return
    }

    if (mergeable === "MERGEABLE") return

    if (!node.branch) {
      log.warn({ nodeId: node.id, mergeable }, "PR not mergeable and no branch info for rebase")
      return
    }

    const cwd = this.findValidCwd(topicSession, graph)
    if (!cwd) {
      log.warn({ nodeId: node.id }, "PR not mergeable but no valid cwd for rebase")
      return
    }

    await this.ctx.telegram.sendMessage(
      `🔄 Rebasing <b>${esc(node.title)}</b> to resolve conflicts…`,
      topicSession.threadId,
    )

    try {
      gitSync(["fetch", "origin", node.branch, baseBranch], { cwd })
      gitSync(["checkout", node.branch], { cwd })
      gitSync(["rebase", `origin/${baseBranch}`], { cwd })
      gitSync(["push", "--force-with-lease", "origin", node.branch], { cwd })

      await this.ctx.telegram.sendMessage(
        `✅ Rebased <b>${esc(node.title)}</b>`,
        topicSession.threadId,
      )

      await this.waitForMergeability(prNumber, repoFlag)
    } catch {
      try {
        const unmerged = gitSync(["diff", "--name-only", "--diff-filter=U"], { cwd })
        if (unmerged.length > 0) {
          await this.ctx.telegram.sendMessage(
            `🤖 Attempting conflict resolution for <b>${esc(node.title)}</b>…`,
            topicSession.threadId,
          )

          if (await resolveConflictsWithAgent(cwd, node.branch, baseBranch)) {
            gitSync(["rebase", "--continue"], { cwd, env: { GIT_EDITOR: "true" } })
            gitSync(["push", "--force-with-lease", "origin", node.branch], { cwd })

            await this.ctx.telegram.sendMessage(
              formatLandConflictResolution(node.title, node.branch, true),
              topicSession.threadId,
            )

            await this.waitForMergeability(prNumber, repoFlag)
            return
          }
        }
      } catch { /* fall through */ }

      try { gitSync(["rebase", "--abort"], { cwd }) } catch { /* ignore */ }
      await this.ctx.telegram.sendMessage(
        `⚠️ Could not resolve conflicts for <b>${esc(node.title)}</b>`,
        topicSession.threadId,
      )
    }
  }

  private async waitForMergeability(prNumber: string, repoFlag: string[]): Promise<void> {
    for (let i = 0; i < MERGEABILITY_POLL_MAX; i++) {
      await new Promise((r) => setTimeout(r, MERGEABILITY_POLL_DELAY))
      try {
        const state = ghSync(["pr", "view", prNumber, ...repoFlag, "--json", "mergeable", "--jq", ".mergeable"])
        if (state === "MERGEABLE") return
      } catch { /* continue polling */ }
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

  private findWorktreePathForBranch(node: DagNode): string | undefined {
    if (node.threadId) {
      const child = this.ctx.topicSessions.get(node.threadId)
      if (child?.cwd) return child.cwd
    }
    return undefined
  }

  private async landChildPRs(topicSession: TopicSession): Promise<void> {
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
        const prState = ghSync(["pr", "view", prNumber, ...repoFlag, "--json", "state", "--jq", ".state"])

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
        ghSync(["pr", "merge", prNumber, ...repoFlag, "--squash", "--delete-branch"])
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
