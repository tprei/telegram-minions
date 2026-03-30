import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import type { DispatcherContext } from "./dispatcher-context.js"
import type { TopicSession } from "./types.js"
import { generateSlug } from "./slugs.js"
import { DEFAULT_RECOVERY_PROMPT } from "./prompts.js"
import { findPRByBranch } from "./ci-babysit.js"
import { captureException } from "./sentry.js"
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
} from "./format.js"
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
import { loggers } from "./logger.js"

const log = loggers.dispatcher

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
          await this.ctx.removeWorkspace({ cwd, repoUrl: parent.repoUrl } as TopicSession).catch(() => {})
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
      node.mergeBase = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8", timeout: 10_000 }).trim()
    } catch {
      log.warn({ dagId: graph.id, nodeId: node.id }, "failed to record mergeBase")
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
      formatDagNodeStarting(node.title, node.id, slug),
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
          }),
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
          await this.ctx.spawnTopicAgent(childSession, recoveryTask, undefined, DEFAULT_RECOVERY_PROMPT)
          await this.ctx.persistTopicSessions()
          return
        }

        if (!resolvedPrUrl) {
          const skipped = failNode(graph, node.id)
          node.error = "Completed without opening a PR"

          const progress = dagProgress(graph)
          await this.ctx.telegram.sendMessage(
            formatDagNodeComplete(childSession.slug, "failed", node.title, undefined, {
              done: progress.done,
              total: progress.total,
              running: progress.running,
            }),
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

          const ciPolicy = this.ctx.config.ci.dagCiPolicy
          if (ciPolicy !== "skip" && this.ctx.config.ci.babysitEnabled && resolvedPrUrl) {
            node.status = "ci-pending"

            const progress = dagProgress(graph)
            await this.ctx.telegram.sendMessage(
              formatDagNodeComplete(childSession.slug, state, node.title, resolvedPrUrl, {
                done: progress.done,
                total: progress.total,
                running: progress.running,
              }),
              parent.threadId,
            )

            await this.ctx.telegram.sendMessage(
              formatDagCIWaiting(childSession.slug, node.title, resolvedPrUrl),
              parent.threadId,
            )

            const ciBabysitResult = await this.ctx.babysitDagChildCI(childSession, resolvedPrUrl)

            if (ciBabysitResult) {
              node.status = "done"
            } else if (ciPolicy === "warn") {
              node.status = "done"
              await this.ctx.telegram.sendMessage(
                formatDagCIFailed(childSession.slug, node.title, resolvedPrUrl, ciPolicy),
                parent.threadId,
              )
            } else {
              node.status = "ci-failed"
              node.error = "CI checks failed"
              await this.ctx.telegram.sendMessage(
                formatDagCIFailed(childSession.slug, node.title, resolvedPrUrl, ciPolicy),
                parent.threadId,
              )
            }
          } else {
            node.status = "done"

            const progress = dagProgress(graph)
            await this.ctx.telegram.sendMessage(
              formatDagNodeComplete(childSession.slug, state, node.title, resolvedPrUrl, {
                done: progress.done,
                total: progress.total,
                running: progress.running,
              }),
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

    if (node.status === "done") {
      try {
        const newlyReady = advanceDag(graph)
        if (newlyReady.length > 0) {
          const isStack = !graph.nodes.some((n) => n.dependsOn.length > 1) &&
            graph.nodes.every((n, i) => i === 0 || n.dependsOn.length === 1)
          await this.scheduleDagNodes(parent, graph, isStack)
        }
      } catch (err) {
        log.error({ err, dagId: graph.id }, "DAG advancement failed")
      }
    }

    this.ctx.broadcastDag(graph, "dag_updated")

    try { await this.ctx.updatePinnedDagStatus(parent, graph) } catch { /* non-critical */ }
    try { await this.updateDagPRDescriptions(graph, childSession.cwd) } catch { /* non-critical */ }

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
            parent.autoAdvance.phase = "done"
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
  }

  async updateDagPRDescriptions(graph: DagGraph, cwd: string): Promise<void> {
    const nodesWithPRs = graph.nodes.filter((n) => n.prUrl)
    if (nodesWithPRs.length === 0) return

    for (const node of nodesWithPRs) {
      try {
        const dagSection = renderDagForGitHub(graph, node.id)
        const prNumber = node.prUrl!.match(/\/pull\/(\d+)/)?.[1]
        if (!prNumber) continue

        const repoMatch = node.prUrl!.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)
        const repoFlag = repoMatch ? ["--repo", repoMatch[1]] : []

        const currentBody = execFileSync(
          "gh",
          ["pr", "view", prNumber, ...repoFlag, "--json", "body", "--jq", ".body"],
          { cwd, stdio: ["pipe", "pipe", "pipe"], timeout: 30_000, encoding: "utf-8", env: { ...process.env } },
        )

        const newBody = upsertDagSection(currentBody, dagSection)

        execFileSync(
          "gh",
          ["pr", "edit", prNumber, ...repoFlag, "--body-file", "-"],
          { input: newBody, cwd, stdio: ["pipe", "pipe", "pipe"], timeout: 30_000, env: { ...process.env } },
        )
      } catch (err) {
        log.error({ err, prUrl: node.prUrl }, "failed to update DAG section in PR")
      }
    }
  }

  async handleRetryCommand(topicSession: TopicSession, nodeId?: string): Promise<void> {
    if (!topicSession.dagId) {
      await this.ctx.telegram.sendMessage("⚠️ /retry only works in DAG parent threads.", topicSession.threadId)
      return
    }

    const graph = this.ctx.dags.get(topicSession.dagId)
    if (!graph) return

    const failedNodes = nodeId
      ? graph.nodes.filter((n) => n.id === nodeId && (n.status === "failed" || n.status === "ci-failed"))
      : graph.nodes.filter((n) => n.status === "failed" || n.status === "ci-failed")

    if (failedNodes.length === 0) {
      await this.ctx.telegram.sendMessage("No failed nodes to retry.", topicSession.threadId)
      return
    }

    for (const node of failedNodes) {
      resetFailedNode(graph, node.id)

      const childSession = [...this.ctx.topicSessions.values()].find(
        (s) => s.dagId === graph.id && s.dagNodeId === node.id,
      )

      if (childSession) {
        const retryTask = [
          `## Retry task`,
          `Previous attempt failed: ${node.error ?? "unknown reason"}`,
          `\nOriginal task: "${node.title}"`,
          node.description ? `\nDescription: ${node.description}` : "",
          `\nCheck the workspace, fix any issues, and create a PR.`,
        ].join("\n")

        childSession.conversation = [{ role: "user", text: retryTask }]
        node.status = "running"
        await this.ctx.spawnTopicAgent(childSession, retryTask, undefined, DEFAULT_RECOVERY_PROMPT)

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

    await this.updateDagPRDescriptions(graph, topicSession.cwd)
    await this.ctx.persistTopicSessions()
  }

  async handleForceCommand(topicSession: TopicSession, nodeId?: string): Promise<void> {
    if (!topicSession.dagId) {
      await this.ctx.telegram.sendMessage("⚠️ /force only works in DAG parent threads.", topicSession.threadId)
      return
    }

    const graph = this.ctx.dags.get(topicSession.dagId)
    if (!graph) return

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

      const newlyReady = advanceDag(graph)
      if (newlyReady.length > 0) {
        const isStack = !graph.nodes.some((n) => n.dependsOn.length > 1) &&
          graph.nodes.every((n, i) => i === 0 || n.dependsOn.length === 1)
        await this.scheduleDagNodes(topicSession, graph, isStack)
      }
    }

    this.ctx.broadcastDag(graph, "dag_updated")
    await this.ctx.updatePinnedDagStatus(topicSession, graph)
    await this.updateDagPRDescriptions(graph, topicSession.cwd)
    await this.ctx.persistTopicSessions()
  }
}
