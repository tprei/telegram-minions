import { execSync } from "node:child_process"
import type { DispatcherContext } from "../dispatcher-context.js"
import type { TopicSession } from "../types.js"
import type { DagGraph, DagNode } from "../dag.js"
import { topologicalSort, needsRestack, cleanupMergedBranch } from "../dag.js"
import { resolveConflictsWithAgent } from "../conflict-resolver.js"
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
} from "../format.js"
import { loggers } from "../logger.js"

const log = loggers.dispatcher

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

    const anyCwd = this.findChildCwd(topicSession, graph) ?? topicSession.cwd
    const gitOpts = { stdio: ["pipe" as const, "pipe" as const, "pipe" as const], timeout: 120_000 }

    await this.ctx.telegram.sendMessage(
      formatLandStart(topicSession.slug, prNodes.length),
      topicSession.threadId,
    )

    let baseBranch: string
    try {
      baseBranch = execSync(
        `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`,
        { ...gitOpts, cwd: anyCwd, encoding: "utf-8", env: { ...process.env } },
      ).trim()
    } catch {
      baseBranch = "main"
    }

    let succeeded = 0
    let skipped = 0
    const failedTitles: string[] = []

    for (const node of prNodes) {
      try {
        const prState = execSync(
          `gh pr view ${JSON.stringify(node.prUrl!)} --json state --jq .state`,
          { ...gitOpts, cwd: anyCwd, encoding: "utf-8", env: { ...process.env } },
        ).trim()

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

      try {
        execSync(
          `gh pr merge ${JSON.stringify(node.prUrl!)} --squash`,
          { ...gitOpts, cwd: anyCwd, env: { ...process.env } },
        )
        node.status = "landed"
        succeeded++

        if (node.branch) {
          const worktreePath = this.findWorktreePathForBranch(node)
          cleanupMergedBranch(node.branch, worktreePath, anyCwd)
        }

        await this.ctx.telegram.sendMessage(
          formatLandProgress(node.title, node.prUrl!, succeeded - 1, prNodes.length),
          topicSession.threadId,
        )

        const toRestack = needsRestack(graph, node.id)
        if (toRestack.length > 0) {
          try {
            execSync(`git fetch origin`, { ...gitOpts, cwd: anyCwd, env: { ...process.env } })
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

              execSync(`git checkout ${JSON.stringify(downstream.branch)}`, { ...gitOpts, cwd: anyCwd, env: { ...process.env } })
              execSync(
                `git rebase --onto ${newBase} ${downstream.mergeBase} ${JSON.stringify(downstream.branch)}`,
                { ...gitOpts, cwd: anyCwd, env: { ...process.env } },
              )
              execSync(
                `git push --force-with-lease origin ${JSON.stringify(downstream.branch)}`,
                { ...gitOpts, cwd: anyCwd, env: { ...process.env } },
              )

              downstream.mergeBase = execSync("git rev-parse HEAD", { cwd: anyCwd, encoding: "utf-8", timeout: 10_000 }).trim()

              execSync(
                `gh pr edit ${JSON.stringify(downstream.prUrl)} --base ${baseBranch}`,
                { ...gitOpts, cwd: anyCwd, env: { ...process.env } },
              )
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err)
              log.error({ err, nodeId: downstream.id, branch: downstream.branch }, "restack failed")

              let conflictResolved = false
              try {
                const unmerged = execSync("git diff --name-only --diff-filter=U", { cwd: anyCwd, encoding: "utf-8" }).trim()
                if (unmerged.length > 0) {
                  await this.ctx.telegram.sendMessage(
                    `🤖 Attempting conflict resolution for <b>${esc(downstream.title)}</b>…`,
                    topicSession.threadId,
                  )
                  conflictResolved = await resolveConflictsWithAgent(anyCwd, downstream.branch, baseBranch)

                  if (conflictResolved) {
                    execSync(`git rebase --continue`, { ...gitOpts, cwd: anyCwd, env: { ...process.env, GIT_EDITOR: "true" } })
                    execSync(
                      `git push --force-with-lease origin ${JSON.stringify(downstream.branch)}`,
                      { ...gitOpts, cwd: anyCwd, env: { ...process.env } },
                    )
                    downstream.mergeBase = execSync("git rev-parse HEAD", { cwd: anyCwd, encoding: "utf-8", timeout: 10_000 }).trim()
                    execSync(
                      `gh pr edit ${JSON.stringify(downstream.prUrl)} --base ${baseBranch}`,
                      { ...gitOpts, cwd: anyCwd, env: { ...process.env } },
                    )
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
                try { execSync(`git rebase --abort`, { cwd: anyCwd, stdio: "pipe" }) } catch { /* ignore */ }
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

  private findChildCwd(parent: TopicSession, graph: DagGraph): string | undefined {
    for (const node of graph.nodes) {
      if (node.threadId) {
        const child = this.ctx.topicSessions.get(node.threadId)
        if (child?.cwd) return child.cwd
      }
    }
    if (parent.childThreadIds) {
      for (const id of parent.childThreadIds) {
        const child = this.ctx.topicSessions.get(id)
        if (child?.cwd) return child.cwd
      }
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
    const gitOpts = { stdio: ["pipe" as const, "pipe" as const, "pipe" as const], timeout: 60_000 }
    const anyCwd = topicSession.cwd || this.ctx.topicSessions.get(topicSession.childThreadIds[0])?.cwd

    for (const { title, prUrl } of prUrls) {
      try {
        const prState = execSync(
          `gh pr view ${JSON.stringify(prUrl)} --json state --jq .state`,
          { ...gitOpts, cwd: anyCwd, encoding: "utf-8", env: { ...process.env } },
        ).trim()

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
        execSync(
          `gh pr merge ${JSON.stringify(prUrl)} --squash`,
          { ...gitOpts, cwd: anyCwd, env: { ...process.env } },
        )
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
