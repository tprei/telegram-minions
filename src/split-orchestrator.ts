import crypto from "node:crypto"
import type { TelegramClient } from "./telegram.js"
import { captureException } from "./sentry.js"
import type { TopicSession, TopicMessage } from "./types.js"
import { generateSlug } from "./slugs.js"
import type { MinionConfig } from "./config-types.js"
import {
  formatSplitAnalyzing,
  formatSplitStart,
  formatSplitChildComplete,
  formatSplitAllDone,
  formatPinnedSplitStatus,
} from "./format.js"
import { extractSplitItems, buildSplitChildPrompt, type SplitItem } from "./split.js"
import { loggers } from "./logger.js"

const log = loggers.dispatcher

/** Callbacks needed from the dispatcher for split orchestration */
export interface SplitOrchestratorDeps {
  telegram: TelegramClient
  config: MinionConfig
  /** Map of thread IDs to topic sessions */
  topicSessions: Map<number, TopicSession>
  /** Map of thread IDs to active session handles */
  sessions: Map<number, { handle: { kill: () => Promise<void> } }>
  /** Prepare a workspace for a new session */
  prepareWorkspace: (slug: string, repoUrl?: string) => Promise<string | null>
  /** Spawn an agent for a topic session */
  spawnTopicAgent: (session: TopicSession, task: string, opts?: { browserEnabled?: boolean }) => Promise<void>
  /** Close all child sessions of a parent */
  closeChildSessions: (parent: TopicSession) => Promise<void>
  /** Update the topic title */
  updateTopicTitle: (session: TopicSession, emoji: string) => Promise<void>
  /** Persist topic sessions to storage */
  persistTopicSessions: () => Promise<void>
  /** Handle /execute command */
  handleExecuteCommand: (session: TopicSession, task: string) => Promise<void>
  /** Extract PR URL from a session's conversation */
  extractPRFromConversation: (session: TopicSession) => string | null
  /** Run deferred CI babysitting */
  runDeferredBabysit: (threadId: number) => Promise<void>
  /** Pin a message in a thread */
  pinThreadMessage: (session: TopicSession, html: string) => Promise<void>
  /** Broadcast session creation/update */
  broadcastSession: (session: TopicSession, event: string) => void
}

export class SplitOrchestrator {
  constructor(private deps: SplitOrchestratorDeps) {}

  /**
   * Handle /split command - extract parallelizable work items and spawn child sessions.
   */
  async handleSplitCommand(topicSession: TopicSession, directive?: string): Promise<void> {
    if (topicSession.activeSessionId) {
      const activeSession = this.deps.sessions.get(topicSession.threadId)
      if (activeSession) await activeSession.handle.kill()
      this.deps.sessions.delete(topicSession.threadId)
      topicSession.activeSessionId = undefined
    }

    await this.deps.telegram.sendMessage(
      formatSplitAnalyzing(topicSession.slug),
      topicSession.threadId,
    )

    // Grace period: allow system resources to stabilize after session termination
    const GRACE_PERIOD_MS = 2000
    await new Promise((resolve) => setTimeout(resolve, GRACE_PERIOD_MS))

    const result = await extractSplitItems(topicSession.conversation, directive)

    if (result.error === "system") {
      await this.deps.telegram.sendMessage(
        `⚠️ <b>System error</b> during extraction: <code>${result.errorMessage ?? "Unknown error"}</code>\n\n` +
        `This is likely a transient resource issue. Try <code>/split</code> again in a few seconds, ` +
        `or use <code>/execute</code> to proceed with a single task.`,
        topicSession.threadId,
      )
      return
    }

    if (result.items.length === 0) {
      await this.deps.telegram.sendMessage(
        `⚠️ Could not extract discrete work items from the conversation. Try <code>/execute</code> instead.`,
        topicSession.threadId,
      )
      return
    }

    const items = result.items

    if (items.length === 1) {
      await this.deps.telegram.sendMessage(
        `Only 1 item found — using <code>/execute</code> instead of splitting.`,
        topicSession.threadId,
      )
      await this.deps.handleExecuteCommand(topicSession, items[0].description)
      return
    }

    const maxItems = this.deps.config.workspace.maxSplitItems
    if (items.length > maxItems) {
      items.splice(maxItems)
    }

    // Close existing children before spawning new ones (handles both tracked and orphaned)
    await this.deps.closeChildSessions(topicSession)
    topicSession.childThreadIds = []
    topicSession.allSplitItems = items.map(i => ({ title: i.title, description: i.description }))
    topicSession.pendingSplitItems = []

    // Spawn up to available slots; queue the rest
    const available = this.deps.config.workspace.maxConcurrentSessions - this.deps.sessions.size
    const toSpawnNow = items.slice(0, Math.max(1, available))
    const toQueue = items.slice(toSpawnNow.length)
    if (toQueue.length > 0) {
      topicSession.pendingSplitItems = toQueue.map(i => ({ title: i.title, description: i.description }))
    }

    const childSummaries: { repo: string; slug: string; title: string }[] = []

    for (const item of toSpawnNow) {
      const childThreadId = await this.spawnSplitChild(topicSession, item, items)
      if (childThreadId) {
        topicSession.childThreadIds!.push(childThreadId)
        const childSession = this.deps.topicSessions.get(childThreadId)!
        childSummaries.push({
          repo: childSession.repo,
          slug: childSession.slug,
          title: item.title,
        })
      }
    }

    if (childSummaries.length === 0) {
      await this.deps.telegram.sendMessage(
        `❌ Failed to spawn any sub-tasks. Try <code>/execute</code> instead.`,
        topicSession.threadId,
      )
      return
    }
    if (toQueue.length > 0) {
      await this.deps.telegram.sendMessage(
        `⏳ Spawned ${childSummaries.length}/${items.length} items — ${toQueue.length} queued, will start as slots free up.`,
        topicSession.threadId,
      )
    }

    await this.deps.telegram.sendMessage(
      formatSplitStart(topicSession.slug, childSummaries),
      topicSession.threadId,
    )

    await this.deps.updateTopicTitle(topicSession, "🔀")
    await this.deps.persistTopicSessions()
  }

  /**
   * Spawn a single split child session.
   */
  async spawnSplitChild(
    parent: TopicSession,
    item: SplitItem,
    allItems: SplitItem[],
  ): Promise<number | null> {
    const sessionId = crypto.randomUUID()
    const slug = generateSlug(sessionId)
    const repo = parent.repo
    const topicName = `⚡ ${repo} · ${slug}`

    let topic: { message_thread_id: number }
    try {
      topic = await this.deps.telegram.createForumTopic(topicName)
    } catch (err) {
      log.error({ err }, "failed to create child topic for split")
      captureException(err, { operation: "createForumTopic", parentSlug: parent.slug })
      return null
    }

    const threadId = topic.message_thread_id

    const cwd = await this.deps.prepareWorkspace(slug, parent.repoUrl)
    if (!cwd) {
      await this.deps.telegram.sendMessage(`❌ Failed to prepare workspace.`, threadId)
      await this.deps.telegram.deleteForumTopic(threadId)
      return null
    }

    const task = buildSplitChildPrompt(parent.conversation, item, allItems)

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
      splitLabel: item.title,
      branch: parent.repoUrl ? `minion/${slug}` : undefined,
    }

    this.deps.topicSessions.set(threadId, childSession)
    this.deps.broadcastSession(childSession, "session_created")

    await this.deps.spawnTopicAgent(childSession, task, { browserEnabled: false })
    return threadId
  }

  /**
   * Handle completion of a split child session.
   * Called from notifyParentOfChildComplete when the child is not part of a DAG.
   */
  async onSplitChildComplete(childSession: TopicSession, state: string): Promise<void> {
    const parent = this.deps.topicSessions.get(childSession.parentThreadId!)
    if (!parent) return

    const label = childSession.splitLabel ?? childSession.slug
    const prUrl = this.deps.extractPRFromConversation(childSession) ?? undefined
    if (prUrl) childSession.prUrl = prUrl

    // Free child conversation memory
    childSession.conversation = []

    await this.deps.telegram.sendMessage(
      formatSplitChildComplete(childSession.slug, state, label, prUrl),
      parent.threadId,
    )

    // Update pinned split status in parent thread
    await this.updatePinnedSplitStatus(parent)

    // Spawn next queued split item if any
    if (parent.pendingSplitItems && parent.pendingSplitItems.length > 0) {
      const nextItem = parent.pendingSplitItems.shift()!
      const allItems = parent.allSplitItems ?? [nextItem]
      const childThreadId = await this.spawnSplitChild(parent, nextItem, allItems)
      if (childThreadId) {
        parent.childThreadIds!.push(childThreadId)
      }
    }

    if (!parent.childThreadIds) return

    const allDone = parent.childThreadIds.every((id) => {
      const child = this.deps.topicSessions.get(id)
      return !child || !child.activeSessionId
    })
    const hasPending = parent.pendingSplitItems && parent.pendingSplitItems.length > 0

    if (allDone && !hasPending) {
      let succeeded = 0
      for (const id of parent.childThreadIds) {
        const child = this.deps.topicSessions.get(id)
        if (child) {
          const prFound = this.deps.extractPRFromConversation(child)
          if (prFound) succeeded++
        }
      }

      await this.deps.telegram.sendMessage(
        formatSplitAllDone(succeeded, parent.childThreadIds.length),
        parent.threadId,
      )
      await this.deps.updateTopicTitle(parent, succeeded === parent.childThreadIds.length ? "✅" : "⚠️")

      // Run deferred CI babysitting sequentially
      await this.deps.runDeferredBabysit(parent.threadId)
    }
  }

  /**
   * Update the pinned split status in a parent thread showing all children with PR links.
   */
  async updatePinnedSplitStatus(parent: TopicSession): Promise<void> {
    if (!parent.childThreadIds || parent.childThreadIds.length === 0) return

    const children: { slug: string; label: string; prUrl?: string; status: "running" | "done" | "failed" }[] = []

    for (const id of parent.childThreadIds) {
      const child = this.deps.topicSessions.get(id)
      if (!child) continue
      children.push({
        slug: child.slug,
        label: child.splitLabel ?? child.slug,
        prUrl: child.prUrl,
        status: child.activeSessionId ? "running" : child.prUrl ? "done" : "failed",
      })
    }

    if (children.length === 0) return

    const html = formatPinnedSplitStatus(parent.slug, parent.repo, children)
    await this.deps.pinThreadMessage(parent, html)
  }
}
