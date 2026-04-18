import { execFile as execFileCb, spawn } from "node:child_process"
import { promisify } from "node:util"
import crypto from "node:crypto"
import type { DispatcherContext } from "../orchestration/dispatcher-context.js"
import type { TopicSession } from "../domain/session-types.js"
import { generateSlug } from "../slugs.js"
import { DEFAULT_RECOVERY_PROMPT, DEFAULT_DAG_REVIEW_PROMPT } from "../config/prompts.js"
import { findPRByBranch } from "../ci/ci-babysit.js"
import { captureException } from "../sentry.js"
import {
  esc,
  formatDagStart,
  formatDagNodeStarting,
  formatDagNodeComplete,
  formatDagNodeSkipped,
  formatDagAllDone,
  formatDagCIWaiting,
  formatDagCIFailed,
  formatDagForceAdvance,
  formatDagReviewStart,
  formatDagReviewChildStarting,
  formatDagReviewComplete,
} from "../telegram/format.js"
import { buildDagChildPrompt } from "./dag-extract.js"
import {
  buildDag,
  advanceDag,
  failNode,
  resetFailedNode,
  isDagComplete,
  readyNodes,
  dagProgress,
  getUpstreamBranches,
  renderDagForGitHub,
  renderDagStatus,
  upsertDagSection,
  type DagGraph,
  type DagNode,
  type DagInput,
} from "./dag.js"
import { updateAllStackComments } from "./pr-stack-comment.js"
import { loggers } from "../logger.js"

const log = loggers.dispatcher
const execFile = promisify(execFileCb)

/**
 * Build a task prompt for a DAG review child session.
 * Includes the node title, PR number, and upstream context so the
 * reviewer understands integration boundaries.
 */
export function buildDagReviewChildPrompt(
  node: DagNode,
  upstreamNodes: DagNode[],
  prNumber?: number,
): string {
  const lines: string[] = [
    `## Review: ${node.title}`,
    "",
  ]

  if (prNumber) {
    lines.push(`Pull request: #${prNumber}`)
  }
  if (node.prUrl) {
    lines.push(`URL: ${node.prUrl}`)
  }
  lines.push("")

  if (node.description) {
    lines.push("### Task description")
    lines.push("")
    lines.push(node.description)
    lines.push("")
  }

  if (upstreamNodes.length > 0) {
    lines.push("### Upstream dependencies")
    lines.push("")
    lines.push("This node depends on the following completed PRs. Check for integration issues:")
    lines.push("")
    for (const upstream of upstreamNodes) {
      const upstreamPrNum = upstream.prUrl?.match(/\/pull\/(\d+)/)?.[1]
      lines.push(`- **${upstream.title}**${upstreamPrNum ? ` (#${upstreamPrNum})` : ""}${upstream.branch ? ` — branch: \`${upstream.branch}\`` : ""}`)
    }
    lines.push("")
  }

  lines.push("### Instructions")
  lines.push("")
  if (prNumber) {
    lines.push(`1. Run \`gh pr diff ${prNumber}\` to get the full diff`)
    lines.push("2. Read changed files for context beyond just the diff")
    lines.push("3. Check for integration issues with upstream dependencies")
    lines.push("4. Post your review to GitHub using `gh pr review`")
  } else {
    lines.push("1. Examine the workspace for changes")
    lines.push("2. Check for integration issues with upstream dependencies")
    lines.push("3. Report findings in your response")
  }

  return lines.join("\n")
}

/**
 * DagOrchestrator — extracted from Dispatcher.
 *
 * Owns DAG graph creation, node scheduling, child spawning,
 * and child completion handling.
 */
export class DagOrchestrator {
  private readonly ctx: DispatcherContext

  constructor(ctx: DispatcherContext) {
    this.ctx = ctx
  }

  async startDag(
    topicSession: TopicSession,
    items: DagInput[],
    isStack: boolean,
  ): Promise<void> {
    const dagId = `dag-${topicSession.slug}`

    let graph: DagGraph
    try {
      graph = buildDag(dagId, items, topicSession.threadId, topicSession.repo, topicSession.repoUrl)
    } catch (err) {
      await this.ctx.telegram.sendMessage(
        `❌ <b>Invalid DAG</b>: <code>${err instanceof Error ? err.message : String(err)}</code>`,
        topicSession.threadId,
      )
      return
    }

    await this.ctx.closeChildSessions(topicSession)
    topicSession.childThreadIds = []
    topicSession.dagId = dagId

    this.ctx.dags.set(dagId, graph)
    await this.ctx.persistDags()
    this.ctx.broadcastDag(graph, "dag_created")

    const childSummaries = graph.nodes.map((n) => ({
      slug: n.id,
      title: n.title,
      dependsOn: n.dependsOn,
    }))

    await this.ctx.telegram.sendMessage(
      formatDagStart(topicSession.slug, childSummaries, isStack),
      topicSession.threadId,
    )
    await this.ctx.telegram.sendMessage(
      renderDagStatus(graph, isStack),
      topicSession.threadId,
    )
    await this.ctx.updateTopicTitle(topicSession, isStack ? "📚" : "🔗")

    await this.scheduleDagNodes(topicSession, graph, isStack)
    await this.ctx.persistTopicSessions()
  }

  async scheduleDagNodes(
    topicSession: TopicSession,
    graph: DagGraph,
    isStack: boolean,
  ): Promise<void> {
    const ready = readyNodes(graph)

    for (const node of ready) {
      const runningDagNodes = graph.nodes.filter(n => n.status === "running").length
      const dagSlots = this.ctx.config.workspace.maxDagConcurrency - runningDagNodes
      const globalSlots = this.ctx.config.workspace.maxConcurrentSessions - this.ctx.sessions.size
      const available = Math.min(dagSlots, globalSlots)
      if (available <= 0) {
        log.warn({ dagId: graph.id, nodeId: node.id }, "no session slots for DAG node, will retry when a slot opens")
        break
      }

      node.status = "running"

      const threadId = await this.spawnDagChild(topicSession, graph, node, isStack)
      if (threadId) {
        node.threadId = threadId
        topicSession.childThreadIds!.push(threadId)
      } else {
        const skipped = failNode(graph, node.id)
        node.error = "Failed to spawn child session"

        await this.ctx.telegram.sendMessage(
          formatDagNodeSkipped(node.title, "Failed to spawn session"),
          topicSession.threadId,
        )

        if (skipped.length > 0) {
          for (const skippedId of skipped) {
            const skippedNode = graph.nodes.find((n) => n.id === skippedId)!
            await this.ctx.telegram.sendMessage(
              formatDagNodeSkipped(skippedNode.title, `upstream "${node.id}" failed`),
              topicSession.threadId,
            )
          }
        }
      }
    }
  }

  async spawnDagChild(
    parent: TopicSession,
    graph: DagGraph,
    node: DagNode,
    isStack: boolean,
  ): Promise<number | null> {
    const sessionId = crypto.randomUUID()
    const slug = generateSlug(sessionId)
    const repo = parent.repo
    const topicName = `${isStack ? "📚" : "🔗"} ${repo} · ${slug}`

    let topic: { message_thread_id: number }
    try {
      topic = await this.ctx.telegram.createForumTopic(topicName)
    } catch (err) {
      log.error({ err }, "failed to create DAG child topic")
      captureException(err, { operation: "createForumTopic", parentSlug: parent.slug, dagNode: node.id })
      return null
    }

    const threadId = topic.message_thread_id

    const upstreamBranches = getUpstreamBranches(graph, node.id)
    let startBranch: string | undefined

    if (upstreamBranches.length === 1) {
      startBranch = upstreamBranches[0]
    } else if (upstreamBranches.length > 1) {
      const fanInBranch = await this.ctx.prepareFanInBranch(slug, parent.repoUrl!, upstreamBranches)
      if (!fanInBranch) {
        await this.ctx.telegram.sendMessage(
          `❌ Merge conflict detected when combining upstream branches for <b>${node.title}</b>.`,
          threadId,
        )
        await this.ctx.telegram.deleteForumTopic(threadId)
        return null
      }
      startBranch = fanInBranch
    }

    const cwd = await this.ctx.prepareWorkspace(slug, parent.repoUrl, startBranch)
    if (!cwd) {
      await this.ctx.telegram.sendMessage(`❌ Failed to prepare workspace.`, threadId)
      await this.ctx.telegram.deleteForumTopic(threadId)
      return null
    }

    let conflictFiles: string[] = []
    if (upstreamBranches.length > 1 && startBranch) {
      const additionalBranches = upstreamBranches.filter((b) => b !== startBranch)
      if (additionalBranches.length > 0) {
        const mergeResult = this.ctx.mergeUpstreamBranches(cwd, additionalBranches)
        if (!mergeResult.ok && mergeResult.conflictFiles.length === 0) {
          await this.ctx.telegram.sendMessage(
            `❌ Failed to merge upstream branches for <b>${node.title}</b>.`,
            threadId,
          )
          await this.ctx.telegram.deleteForumTopic(threadId)
          await this.ctx.removeWorkspace({ cwd, repoUrl: parent.repoUrl }).catch(() => {})
          return null
        }
        conflictFiles = mergeResult.conflictFiles
        if (conflictFiles.length > 0) {
          await this.ctx.telegram.sendMessage(
            `⚠️ Merge conflicts in ${conflictFiles.length} file(s) for <b>${esc(node.title)}</b> — agent will resolve.`,
            threadId,
          )
        }
      }
    }

    const branch = `minion/${slug}`
    node.branch = branch

    try {
      const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8", timeout: 10_000 })
      const sha = stdout.trim()
      node.mergeBase = sha
      node.baseSha = sha
    } catch {
      log.warn({ dagId: graph.id, nodeId: node.id }, "failed to record baseSha/mergeBase")
    }

    const task = buildDagChildPrompt(
      parent.conversation,
      { id: node.id, title: node.title, description: node.description, dependsOn: node.dependsOn },
      graph.nodes.map((n) => ({ id: n.id, title: n.title, description: n.description, dependsOn: n.dependsOn })),
      upstreamBranches,
      isStack,
      conflictFiles,
    )

    const childSession: TopicSession = {
      threadId,
      repo,
      repoUrl: parent.repoUrl,
      cwd,
      slug,
      conversation: [{ role: "user", text: task }],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      profileId: parent.profileId,
      parentThreadId: parent.threadId,
      splitLabel: node.title,
      branch: parent.repoUrl ? `minion/${slug}` : undefined,
      dagId: graph.id,
      dagNodeId: node.id,
    }

    this.ctx.topicSessions.set(threadId, childSession)
    this.ctx.broadcastSession(childSession, "session_created")

    await this.ctx.telegram.sendMessage(
      formatDagNodeStarting(node.title, node.id, slug, threadId, this.ctx.config.telegram.chatId),
      parent.threadId,
    )

    await this.ctx.spawnTopicAgent(childSession, task, { browserEnabled: false })
    return threadId
  }

  async onDagChildComplete(
    childSession: TopicSession,
    state: string,
  ): Promise<void> {
    if (!childSession.dagId || !childSession.dagNodeId) return

    // Route dag-review children to their own completion handler
    if (childSession.mode === "dag-review") {
      await this.onDagReviewChildComplete(childSession)
      return
    }

    const graph = this.ctx.dags.get(childSession.dagId)
    if (!graph) return

    const node = graph.nodes.find((n) => n.id === childSession.dagNodeId)
    if (!node) return

    const parent = this.ctx.topicSessions.get(graph.parentThreadId)
    if (!parent) return

    const prUrl = this.ctx.extractPRFromConversation(childSession) ?? undefined
    if (prUrl) childSession.prUrl = prUrl

    childSession.conversation = []

    try {
      if (state === "errored" || state === "failed") {
        const skipped = failNode(graph, node.id)
        node.error = "Session errored"

        const progress = dagProgress(graph)
        await this.ctx.telegram.sendMessage(
          formatDagNodeComplete(childSession.slug, state, node.title, prUrl, {
            done: progress.done,
            total: progress.total,
            running: progress.running,
          }, childSession.threadId, this.ctx.config.telegram.chatId),
          parent.threadId,
        )

        for (const skippedId of skipped) {
          const skippedNode = graph.nodes.find((n) => n.id === skippedId)!
          await this.ctx.telegram.sendMessage(
            formatDagNodeSkipped(skippedNode.title, `upstream "${node.id}" failed`),
            parent.threadId,
          )
        }
      } else {
        let resolvedPrUrl = prUrl
        if (!resolvedPrUrl && node.branch) {
          resolvedPrUrl = (await findPRByBranch(node.branch, childSession.cwd)) ?? undefined
        }

        if (!resolvedPrUrl && !node.recoveryAttempted) {
          node.recoveryAttempted = true

          await this.ctx.telegram.sendMessage(
            `⚠️ <b>${esc(childSession.slug)}</b> completed without a PR — spawning recovery session…`,
            parent.threadId,
          )

          const recoveryTask = [
            `## Recovery task`,
            `The previous session was assigned: "${node.title}"`,
            node.description ? `\nDescription: ${node.description}` : "",
            `\nIt completed without opening a pull request. Check the workspace, fix any issues, and create a PR.`,
          ].join("\n")

          childSession.conversation = [{ role: "user", text: recoveryTask }]
          const spawned = await this.ctx.spawnTopicAgent(childSession, recoveryTask, undefined, DEFAULT_RECOVERY_PROMPT)
          if (!spawned) {
            const skipped = failNode(graph, node.id)
            node.error = "Recovery blocked: max sessions reached"
            await this.ctx.telegram.sendMessage(
              `❌ Recovery for <b>${esc(childSession.slug)}</b> blocked — max sessions reached.`,
              parent.threadId,
            )
            for (const skippedId of skipped) {
              const skippedNode = graph.nodes.find((n) => n.id === skippedId)!
              await this.ctx.telegram.sendMessage(
                formatDagNodeSkipped(skippedNode.title, `upstream "${node.id}" recovery blocked`),
                parent.threadId,
              )
            }
          } else {
            await this.ctx.persistTopicSessions()
            return
          }
        }

        if (node.status === "failed") {
          // Already handled (e.g. recovery spawn was rejected) — skip to completion checks
        } else if (!resolvedPrUrl) {
          const skipped = failNode(graph, node.id)
          node.error = "Completed without opening a PR"

          const progress = dagProgress(graph)
          await this.ctx.telegram.sendMessage(
            formatDagNodeComplete(childSession.slug, "failed", node.title, undefined, {
              done: progress.done,
              total: progress.total,
              running: progress.running,
            }, childSession.threadId, this.ctx.config.telegram.chatId),
            parent.threadId,
          )

          for (const skippedId of skipped) {
            const skippedNode = graph.nodes.find((n) => n.id === skippedId)!
            await this.ctx.telegram.sendMessage(
              formatDagNodeSkipped(skippedNode.title, `upstream "${node.id}" completed without PR`),
              parent.threadId,
            )
          }
        } else {
          node.prUrl = resolvedPrUrl
          await this.captureHeadSha(node, childSession.cwd)

          const ciPolicy = this.ctx.config.ci.dagCiPolicy
          if (ciPolicy !== "skip" && this.ctx.config.ci.babysitEnabled && resolvedPrUrl) {
            node.status = "ci-pending"
            await this.ctx.persistDags()

            const progress = dagProgress(graph)
            await this.ctx.telegram.sendMessage(
              formatDagNodeComplete(childSession.slug, state, node.title, resolvedPrUrl, {
                done: progress.done,
                total: progress.total,
                running: progress.running,
              }, childSession.threadId, this.ctx.config.telegram.chatId),
              parent.threadId,
            )

            await this.ctx.telegram.sendMessage(
              formatDagCIWaiting(childSession.slug, node.title, resolvedPrUrl),
              parent.threadId,
            )

            const ciBabysitResult = await this.ctx.babysitDagChildCI(childSession, resolvedPrUrl)

            if (ciBabysitResult) {
              node.status = "done"
              await this.ctx.persistDags()
            } else if (ciPolicy === "warn") {
              node.status = "done"
              await this.ctx.persistDags()
              await this.ctx.telegram.sendMessage(
                formatDagCIFailed(childSession.slug, node.title, resolvedPrUrl, ciPolicy),
                parent.threadId,
              )
            } else {
              node.status = "ci-failed"
              node.error = "CI checks failed"
              await this.ctx.persistDags()
              await this.ctx.telegram.sendMessage(
                formatDagCIFailed(childSession.slug, node.title, resolvedPrUrl, ciPolicy),
                parent.threadId,
              )
            }
          } else {
            node.status = "done"
            await this.ctx.persistDags()

            const progress = dagProgress(graph)
            await this.ctx.telegram.sendMessage(
              formatDagNodeComplete(childSession.slug, state, node.title, resolvedPrUrl, {
                done: progress.done,
                total: progress.total,
                running: progress.running,
              }, childSession.threadId, this.ctx.config.telegram.chatId),
              parent.threadId,
            )
          }
        }
      }
    } catch (err) {
      log.error({ err, nodeId: node.id, dagId: graph.id }, "DAG child completion error — recovering node status")
      captureException(err, { operation: "onDagChildComplete", nodeId: node.id, dagId: graph.id })

      if (node.status === "running" || node.status === "ci-pending") {
        const resolvedPr = prUrl ?? node.prUrl
        if (resolvedPr) {
          node.prUrl = resolvedPr
          node.status = "done"
        } else {
          failNode(graph, node.id)
          node.error = `Internal error: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }

    try {
      if (node.status === "done") {
        advanceDag(graph)
      }
      if (readyNodes(graph).length > 0) {
        const isStack = !graph.nodes.some((n) => n.dependsOn.length > 1) &&
          graph.nodes.every((n, i) => i === 0 || n.dependsOn.length === 1)
        await this.scheduleDagNodes(parent, graph, isStack)
      }
    } catch (err) {
      log.error({ err, dagId: graph.id }, "DAG advancement failed")
    }

    this.ctx.broadcastDag(graph, "dag_updated")

    try { await this.ctx.updatePinnedDagStatus(parent, graph) } catch { /* non-critical */ }
    try { await this.updateDagPRDescriptions(graph, childSession.cwd) } catch { /* non-critical */ }
    try { await updateAllStackComments(graph, { cwd: childSession.cwd }) } catch { /* non-critical */ }

    if (isDagComplete(graph)) {
      try {
        const progress = dagProgress(graph)
        const totalFailed = progress.failed + progress.ciFailed
        await this.ctx.telegram.sendMessage(
          formatDagAllDone(progress.done, progress.total, totalFailed),
          parent.threadId,
        )

        await this.ctx.runDeferredBabysit(parent.threadId)

        if (parent.autoAdvance?.phase === "dag") {
          if (totalFailed > 0) {
            parent.autoAdvance.phase = "dag"
            await this.ctx.updateTopicTitle(parent, "⚠️")
            await this.ctx.telegram.sendMessage(
              `🚢 Ship pipeline halted: ${totalFailed} DAG node(s) failed. Use <code>/retry</code> to fix failed nodes.`,
              parent.threadId,
            )
          } else {
            await this.ctx.shipAdvanceToVerification(parent, graph)
          }
        } else if (totalFailed > 0) {
          await this.ctx.updateTopicTitle(parent, "⚠️")
          await this.ctx.telegram.sendMessage(
            `Send <code>/retry</code> to retry failed nodes, <code>/force node-id</code> to advance past CI failures, or <code>/close</code> to finish.`,
            parent.threadId,
          )
        } else {
          await this.ctx.updateTopicTitle(parent, "✅")
          await this.ctx.closeChildSessions(parent)
        }
      } catch (err) {
        log.error({ err, dagId: graph.id }, "DAG completion handling failed")
      }
    }

    await this.ctx.persistTopicSessions()
    await this.ctx.persistDags()
  }

  /**
   * Record the current head SHA of the node's branch. Prefers the remote
   * ref (since the child has already pushed by the time this runs) and
   * falls back to the local branch if the fetch fails.
   */
  async captureHeadSha(node: DagNode, cwd: string): Promise<void> {
    if (!node.branch) return
    try {
      await execFile("git", ["fetch", "origin", node.branch], { cwd, encoding: "utf-8", timeout: 30_000 })
      const { stdout } = await execFile("git", ["rev-parse", node.branch], { cwd, encoding: "utf-8", timeout: 10_000 })
      node.headSha = stdout.trim()
    } catch {
      try {
        const { stdout } = await execFile("git", ["rev-parse", node.branch], { cwd, encoding: "utf-8", timeout: 10_000 })
        node.headSha = stdout.trim()
      } catch {
        log.warn({ dagId: node.id, branch: node.branch }, "failed to record headSha")
      }
    }
  }

  async updateDagPRDescriptions(graph: DagGraph, cwd: string): Promise<void> {
    await this.ctx.refreshGitToken()
    const nodesWithPRs = graph.nodes.filter((n) => n.prUrl)
    if (nodesWithPRs.length === 0) return

    for (const node of nodesWithPRs) {
      try {
        const dagSection = renderDagForGitHub(graph, node.id)
        const prNumber = node.prUrl!.match(/\/pull\/(\d+)/)?.[1]
        if (!prNumber) continue

        const repoMatch = node.prUrl!.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)
        const repoFlag = repoMatch ? ["--repo", repoMatch[1]] : []

        const { stdout: currentBody } = await execFile(
          "gh",
          ["pr", "view", prNumber, ...repoFlag, "--json", "body", "--jq", ".body"],
          { cwd, timeout: 90_000, encoding: "utf-8", env: { ...process.env } },
        )

        const newBody = upsertDagSection(currentBody, dagSection)

        await new Promise<void>((resolve, reject) => {
          const proc = spawn("gh", ["pr", "edit", prNumber!, ...repoFlag, "--body-file", "-"], {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env },
          })
          proc.stdin.end(newBody)
          const timer = setTimeout(() => { proc.kill(); reject(new Error("gh pr edit timed out")) }, 90_000)
          proc.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`gh pr edit exited ${code}`)) })
          proc.on("error", (err) => { clearTimeout(timer); reject(err) })
        })
      } catch (err) {
        log.error({ err, prUrl: node.prUrl }, "failed to update DAG section in PR")
      }
    }
  }

  async handleRetryCommand(topicSession: TopicSession, nodeId?: string): Promise<void> {
    // Pre-DAG ship retry: re-trigger the current ship phase
    if (!topicSession.dagId && topicSession.autoAdvance) {
      const phase = topicSession.autoAdvance.phase
      if (phase === "think" || phase === "plan") {
        await this.ctx.telegram.sendMessage(
          `🔄 Retrying ship <b>${phase}</b> phase…`,
          topicSession.threadId,
        )
        const lastUserMessage = [...topicSession.conversation].reverse().find((m) => m.role === "user")
        const retryTask = lastUserMessage?.text ?? topicSession.autoAdvance.featureDescription
        await this.ctx.spawnTopicAgent(topicSession, retryTask)
        return
      }
      if (phase === "dag") {
        await this.ctx.telegram.sendMessage(
          `🔄 Retrying DAG extraction…`,
          topicSession.threadId,
        )
        await this.ctx.shipAdvanceToDag(topicSession)
        return
      }
    }

    if (!topicSession.dagId) {
      await this.ctx.telegram.sendMessage(
        "⚠️ /retry requires a ship pipeline or DAG parent thread.",
        topicSession.threadId,
      )
      return
    }

    const graph = this.ctx.dags.get(topicSession.dagId)
    if (!graph) {
      await this.ctx.telegram.sendMessage(
        "❌ DAG not found — it may have been lost. Use <code>/close</code> and re-create.",
        topicSession.threadId,
      )
      return
    }

    const failedNodes = nodeId
      ? graph.nodes.filter((n) => n.id === nodeId && (n.status === "failed" || n.status === "ci-failed"))
      : graph.nodes.filter((n) => n.status === "failed" || n.status === "ci-failed")

    if (failedNodes.length === 0) {
      await this.ctx.telegram.sendMessage("No failed nodes to retry.", topicSession.threadId)
      return
    }

    for (const node of failedNodes) {
      resetFailedNode(graph, node.id)
    }

    let deferred = 0
    for (const node of failedNodes) {
      const childSession = [...this.ctx.topicSessions.values()].find(
        (s) => s.dagId === graph.id && s.dagNodeId === node.id,
      )

      if (childSession) {
        const runningDagNodes = graph.nodes.filter(n => n.status === "running").length
        const dagSlots = this.ctx.config.workspace.maxDagConcurrency - runningDagNodes
        const globalSlots = this.ctx.config.workspace.maxConcurrentSessions - this.ctx.sessions.size
        if (Math.min(dagSlots, globalSlots) <= 0) {
          deferred++
          continue
        }

        const retryTask = [
          `## Retry task`,
          `Previous attempt failed: ${node.error ?? "unknown reason"}`,
          `\nOriginal task: "${node.title}"`,
          node.description ? `\nDescription: ${node.description}` : "",
          `\nCheck the workspace, fix any issues, and create a PR.`,
        ].join("\n")

        childSession.conversation = [{ role: "user", text: retryTask }]
        node.status = "running"
        const spawned = await this.ctx.spawnTopicAgent(childSession, retryTask, undefined, DEFAULT_RECOVERY_PROMPT)

        if (!spawned) {
          node.status = "ready"
          deferred++
          continue
        }

        await this.ctx.telegram.sendMessage(
          `🔄 Retrying <b>${esc(node.title)}</b> (<code>${esc(node.id)}</code>)`,
          topicSession.threadId,
        )
      } else {
        const isStack = !graph.nodes.some((n) => n.dependsOn.length > 1) &&
          graph.nodes.every((n, i) => i === 0 || n.dependsOn.length === 1)
        await this.scheduleDagNodes(topicSession, graph, isStack)
      }
    }

    if (deferred > 0) {
      await this.ctx.telegram.sendMessage(
        `⏳ ${deferred} node(s) deferred — will start when a session slot opens.`,
        topicSession.threadId,
      )
    }

    await this.updateDagPRDescriptions(graph, topicSession.cwd)
    await this.ctx.persistTopicSessions()
    await this.ctx.persistDags()
  }

  async handleForceCommand(topicSession: TopicSession, nodeId?: string): Promise<void> {
    if (!topicSession.dagId) {
      await this.ctx.telegram.sendMessage("⚠️ /force only works in DAG parent threads.", topicSession.threadId)
      return
    }

    const graph = this.ctx.dags.get(topicSession.dagId)
    if (!graph) {
      await this.ctx.telegram.sendMessage(
        "❌ DAG not found — it may have been lost. Use <code>/close</code> and re-create.",
        topicSession.threadId,
      )
      return
    }

    const ciFailedNodes = nodeId
      ? graph.nodes.filter((n) => n.id === nodeId && n.status === "ci-failed")
      : graph.nodes.filter((n) => n.status === "ci-failed")

    if (ciFailedNodes.length === 0) {
      await this.ctx.telegram.sendMessage("No CI-failed nodes to force-advance.", topicSession.threadId)
      return
    }

    for (const node of ciFailedNodes) {
      node.status = "done"
      node.error = undefined

      await this.ctx.telegram.sendMessage(
        formatDagForceAdvance(node.title, node.id),
        topicSession.threadId,
      )

      advanceDag(graph)
      if (readyNodes(graph).length > 0) {
        const isStack = !graph.nodes.some((n) => n.dependsOn.length > 1) &&
          graph.nodes.every((n, i) => i === 0 || n.dependsOn.length === 1)
        await this.scheduleDagNodes(topicSession, graph, isStack)
      }
    }

    this.ctx.broadcastDag(graph, "dag_updated")
    await this.ctx.updatePinnedDagStatus(topicSession, graph)
    await this.updateDagPRDescriptions(graph, topicSession.cwd)
    await this.ctx.persistTopicSessions()
    await this.ctx.persistDags()
  }

  // ── DAG review ────────────────────────────────────────────────────

  async handleReviewCommand(topicSession: TopicSession, directive?: string): Promise<void> {
    if (!topicSession.dagId) {
      await this.ctx.telegram.sendMessage(
        "⚠️ /review in a DAG thread requires an active DAG.",
        topicSession.threadId,
      )
      return
    }

    const graph = this.ctx.dags.get(topicSession.dagId)
    if (!graph) {
      await this.ctx.telegram.sendMessage(
        "❌ DAG not found — it may have been lost.",
        topicSession.threadId,
      )
      return
    }

    // Only review nodes that completed with a PR
    const reviewableNodes = graph.nodes.filter(
      (n) => n.status === "done" && n.prUrl,
    )

    if (reviewableNodes.length === 0) {
      const running = graph.nodes.filter((n) => n.status === "running").length
      const pending = graph.nodes.filter((n) => n.status === "pending" || n.status === "ready").length
      const parts: string[] = ["No PRs available to review."]
      if (running > 0) parts.push(`${running} node(s) still running.`)
      if (pending > 0) parts.push(`${pending} node(s) pending.`)
      await this.ctx.telegram.sendMessage(parts.join(" "), topicSession.threadId)
      return
    }

    // Check if a review is already in progress
    const existingReviewChildren = (topicSession.childThreadIds ?? []).filter((tid) => {
      const child = this.ctx.topicSessions.get(tid)
      return child?.mode === "dag-review" && child.activeSessionId
    })
    if (existingReviewChildren.length > 0) {
      await this.ctx.telegram.sendMessage(
        `⚠️ A DAG review is already in progress (${existingReviewChildren.length} active reviewer(s)). Wait for it to finish or <code>/close</code> first.`,
        topicSession.threadId,
      )
      return
    }

    const task = directive ?? `Review all ${reviewableNodes.length} DAG PRs`
    await this.ctx.telegram.sendMessage(
      formatDagReviewStart(topicSession.repo, topicSession.slug, task),
      topicSession.threadId,
    )

    if (!topicSession.childThreadIds) topicSession.childThreadIds = []

    let spawned = 0
    for (const node of reviewableNodes) {
      const runningDagNodes = graph.nodes.filter(n => n.status === "running").length
      const activeReviews = (topicSession.childThreadIds ?? []).filter((tid) => {
        const child = this.ctx.topicSessions.get(tid)
        return child?.mode === "dag-review" && child.activeSessionId
      }).length
      const dagSlots = this.ctx.config.workspace.maxDagConcurrency - runningDagNodes - activeReviews
      const globalSlots = this.ctx.config.workspace.maxConcurrentSessions - this.ctx.sessions.size
      const available = Math.min(dagSlots, globalSlots)
      if (available <= 0) {
        log.warn({ dagId: graph.id, nodeId: node.id }, "no session slots for DAG review child, skipping remaining")
        await this.ctx.telegram.sendMessage(
          `⏳ Session limit reached — reviewed ${spawned}/${reviewableNodes.length} PRs. Send <code>/review</code> again when slots free up.`,
          topicSession.threadId,
        )
        break
      }

      const threadId = await this.spawnDagReviewChild(topicSession, graph, node)
      if (threadId) {
        topicSession.childThreadIds.push(threadId)
        spawned++
      }
    }

    if (spawned === 0) {
      await this.ctx.telegram.sendMessage(
        "❌ Failed to spawn any review sessions.",
        topicSession.threadId,
      )
    }

    await this.ctx.persistTopicSessions()
  }

  async spawnDagReviewChild(
    parent: TopicSession,
    graph: DagGraph,
    node: DagNode,
  ): Promise<number | null> {
    const sessionId = crypto.randomUUID()
    const slug = generateSlug(sessionId)
    const repo = parent.repo
    const prNumber = node.prUrl!.match(/\/pull\/(\d+)/)?.[1]
    const topicName = `📋 ${repo} · ${slug}`

    let topic: { message_thread_id: number }
    try {
      topic = await this.ctx.telegram.createForumTopic(topicName)
    } catch (err) {
      log.error({ err }, "failed to create DAG review child topic")
      captureException(err, { operation: "createForumTopic", parentSlug: parent.slug, dagNode: node.id })
      return null
    }

    const threadId = topic.message_thread_id

    // Reuse the existing child's workspace if it still exists, otherwise prepare a fresh one
    const existingChild = [...this.ctx.topicSessions.values()].find(
      (s) => s.dagId === graph.id && s.dagNodeId === node.id && s.cwd,
    )
    let cwd: string | null = null
    if (existingChild?.cwd) {
      try {
        await execFile("git", ["status"], { cwd: existingChild.cwd, encoding: "utf-8", timeout: 5_000 })
        cwd = existingChild.cwd
      } catch {
        cwd = null
      }
    }
    if (!cwd) {
      cwd = await this.ctx.prepareWorkspace(slug, parent.repoUrl, node.branch)
      if (!cwd) {
        await this.ctx.telegram.sendMessage(`❌ Failed to prepare workspace.`, threadId)
        await this.ctx.telegram.deleteForumTopic(threadId)
        return null
      }
    }

    const upstreamNodes = graph.nodes.filter(
      (n) => node.dependsOn.includes(n.id) && n.status === "done" && n.prUrl,
    )
    const task = buildDagReviewChildPrompt(node, upstreamNodes, prNumber ? parseInt(prNumber, 10) : undefined)

    const childSession: TopicSession = {
      threadId,
      repo,
      repoUrl: parent.repoUrl,
      cwd,
      slug,
      conversation: [{ role: "user", text: task }],
      pendingFeedback: [],
      mode: "dag-review",
      lastActivityAt: Date.now(),
      profileId: parent.profileId,
      parentThreadId: parent.threadId,
      splitLabel: `Review: ${node.title}`,
      dagId: graph.id,
      dagNodeId: node.id,
    }

    this.ctx.topicSessions.set(threadId, childSession)
    this.ctx.broadcastSession(childSession, "session_created")

    await this.ctx.telegram.sendMessage(
      formatDagReviewChildStarting(slug, node.title, prNumber ? parseInt(prNumber, 10) : 0),
      parent.threadId,
    )

    await this.ctx.spawnTopicAgent(childSession, task, { browserEnabled: false }, DEFAULT_DAG_REVIEW_PROMPT)
    return threadId
  }

  async onDagReviewChildComplete(
    childSession: TopicSession,
  ): Promise<void> {
    if (!childSession.dagId || !childSession.dagNodeId) return

    const graph = this.ctx.dags.get(childSession.dagId)
    if (!graph) return

    const node = graph.nodes.find((n) => n.id === childSession.dagNodeId)
    if (!node) return

    const parent = this.ctx.topicSessions.get(graph.parentThreadId)
    if (!parent) return

    // Free conversation memory — review output is posted to GitHub, not needed here
    childSession.conversation = []

    await this.ctx.telegram.sendMessage(
      `📋 Review of <b>${esc(node.title)}</b> (${node.prUrl ? `<a href="${node.prUrl}">#${node.prUrl.match(/\/pull\/(\d+)/)?.[1] ?? ""}</a>` : "no PR"}) complete  ·  🏷 <code>${esc(childSession.slug)}</code>`,
      parent.threadId,
    )

    // Check if all review children are done
    const reviewChildren = (parent.childThreadIds ?? [])
      .map((tid) => this.ctx.topicSessions.get(tid))
      .filter((s): s is TopicSession => s?.mode === "dag-review")

    const allDone = reviewChildren.every((s) => !s.activeSessionId)

    if (allDone) {
      await this.ctx.telegram.sendMessage(
        formatDagReviewComplete(parent.slug),
        parent.threadId,
      )
    }

    await this.ctx.persistTopicSessions()
  }
}
