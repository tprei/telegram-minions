import type { DispatcherContext } from "./dispatcher-context.js"
import type { TopicSession } from "../types.js"
import { extractSplitItems } from "./split.js"
import { extractStackItems } from "../dag/dag-extract.js"
import {
  formatSplitAnalyzing,
  formatSplitStart,
  formatSplitChildComplete,
  formatSplitAllDone,
  formatStackAnalyzing,
} from "../telegram/format.js"

export class SplitOrchestrator {
  private readonly ctx: DispatcherContext

  constructor(ctx: DispatcherContext) {
    this.ctx = ctx
  }

  async handleSplitCommand(topicSession: TopicSession, directive?: string): Promise<void> {
    if (topicSession.activeSessionId) {
      const activeSession = this.ctx.sessions.get(topicSession.threadId)
      if (activeSession) await activeSession.handle.kill()
      this.ctx.sessions.delete(topicSession.threadId)
      topicSession.activeSessionId = undefined
    }

    await this.ctx.telegram.sendMessage(
      formatSplitAnalyzing(topicSession.slug),
      topicSession.threadId,
    )

    const GRACE_PERIOD_MS = 2000
    await new Promise((resolve) => setTimeout(resolve, GRACE_PERIOD_MS))

    const result = await extractSplitItems(topicSession.conversation, directive)

    if (result.error === "system") {
      await this.ctx.telegram.sendMessage(
        `⚠️ <b>System error</b> during extraction: <code>${result.errorMessage ?? "Unknown error"}</code>\n\n` +
        `This is likely a transient resource issue. Try <code>/split</code> again in a few seconds, ` +
        `or use <code>/execute</code> to proceed with a single task.`,
        topicSession.threadId,
      )
      return
    }

    if (result.items.length === 0) {
      await this.ctx.telegram.sendMessage(
        `⚠️ Could not extract discrete work items from the conversation. Try <code>/execute</code> instead.`,
        topicSession.threadId,
      )
      return
    }

    const items = result.items

    if (items.length === 1) {
      await this.ctx.telegram.sendMessage(
        `Only 1 item found — using <code>/execute</code> instead of splitting.`,
        topicSession.threadId,
      )
      await this.ctx.handleExecuteCommand(topicSession, items[0].description)
      return
    }

    const maxItems = this.ctx.config.workspace.maxSplitItems
    if (items.length > maxItems) {
      items.splice(maxItems)
    }

    await this.ctx.closeChildSessions(topicSession)
    topicSession.childThreadIds = []
    topicSession.allSplitItems = items.map(i => ({ title: i.title, description: i.description }))
    topicSession.pendingSplitItems = []

    const available = this.ctx.config.workspace.maxConcurrentSessions - this.ctx.sessions.size
    const toSpawnNow = items.slice(0, Math.max(1, available))
    const toQueue = items.slice(toSpawnNow.length)
    if (toQueue.length > 0) {
      topicSession.pendingSplitItems = toQueue.map(i => ({ title: i.title, description: i.description }))
    }

    const childSummaries: { repo: string; slug: string; title: string }[] = []

    for (const item of toSpawnNow) {
      const childThreadId = await this.ctx.spawnSplitChild(topicSession, item, items)
      if (childThreadId) {
        topicSession.childThreadIds!.push(childThreadId)
        const childSession = this.ctx.topicSessions.get(childThreadId)!
        childSummaries.push({
          repo: childSession.repo,
          slug: childSession.slug,
          title: item.title,
        })
      }
    }

    if (childSummaries.length === 0) {
      await this.ctx.telegram.sendMessage(
        `❌ Failed to spawn any sub-tasks. Try <code>/execute</code> instead.`,
        topicSession.threadId,
      )
      return
    }
    if (toQueue.length > 0) {
      await this.ctx.telegram.sendMessage(
        `⏳ Spawned ${childSummaries.length}/${items.length} items — ${toQueue.length} queued, will start as slots free up.`,
        topicSession.threadId,
      )
    }

    await this.ctx.telegram.sendMessage(
      formatSplitStart(topicSession.slug, childSummaries),
      topicSession.threadId,
    )

    await this.ctx.updateTopicTitle(topicSession, "🔀")
    await this.ctx.persistTopicSessions()
  }

  async handleStackCommand(topicSession: TopicSession, directive?: string): Promise<void> {
    if (topicSession.activeSessionId) {
      const activeSession = this.ctx.sessions.get(topicSession.threadId)
      if (activeSession) await activeSession.handle.kill()
      this.ctx.sessions.delete(topicSession.threadId)
      topicSession.activeSessionId = undefined
    }

    await this.ctx.telegram.sendMessage(
      formatStackAnalyzing(topicSession.slug),
      topicSession.threadId,
    )

    const GRACE_PERIOD_MS = 2000
    await new Promise((resolve) => setTimeout(resolve, GRACE_PERIOD_MS))

    const profile = topicSession.profileId ? this.ctx.profileStore.get(topicSession.profileId) : undefined
    const result = await extractStackItems(topicSession.conversation, directive, profile)

    if (result.error === "system") {
      await this.ctx.telegram.sendMessage(
        `⚠️ <b>System error</b> during extraction: <code>${result.errorMessage ?? "Unknown error"}</code>\n\n` +
        `Try <code>/stack</code> again, or use <code>/execute</code> for a single task.`,
        topicSession.threadId,
      )
      return
    }

    if (result.items.length === 0) {
      await this.ctx.telegram.sendMessage(
        `⚠️ Could not extract sequential work items. Try <code>/execute</code> instead.`,
        topicSession.threadId,
      )
      return
    }

    if (result.items.length === 1) {
      await this.ctx.telegram.sendMessage(
        `Only 1 item found — using <code>/execute</code> instead.`,
        topicSession.threadId,
      )
      await this.ctx.handleExecuteCommand(topicSession, result.items[0].description)
      return
    }

    await this.ctx.startDag(topicSession, result.items, true)
  }

  async notifyParentOfChildComplete(
    childSession: TopicSession,
    state: string,
  ): Promise<void> {
    if (!childSession.parentThreadId) return

    // DAG children are handled by DagOrchestrator — skip here
    if (childSession.dagId && childSession.dagNodeId) return

    const parent = this.ctx.topicSessions.get(childSession.parentThreadId)
    if (!parent) return

    const label = childSession.splitLabel ?? childSession.slug
    const prUrl = this.ctx.extractPRFromConversation(childSession) ?? undefined
    if (prUrl) childSession.prUrl = prUrl

    childSession.conversation = []

    await this.ctx.telegram.sendMessage(
      formatSplitChildComplete(childSession.slug, state, label, prUrl, childSession.threadId, this.ctx.config.telegram.chatId),
      parent.threadId,
    )

    await this.ctx.updatePinnedSplitStatus(parent)

    if (parent.pendingSplitItems && parent.pendingSplitItems.length > 0) {
      const nextItem = parent.pendingSplitItems.shift()!
      const allItems = parent.allSplitItems ?? [nextItem]
      const childThreadId = await this.ctx.spawnSplitChild(parent, nextItem, allItems)
      if (childThreadId) {
        parent.childThreadIds!.push(childThreadId)
      }
    }

    if (!parent.childThreadIds) return

    const allDone = parent.childThreadIds.every((id) => {
      const child = this.ctx.topicSessions.get(id)
      return !child || !child.activeSessionId
    })
    const hasPending = parent.pendingSplitItems && parent.pendingSplitItems.length > 0

    if (allDone && !hasPending) {
      let succeeded = 0
      for (const id of parent.childThreadIds) {
        const child = this.ctx.topicSessions.get(id)
        if (child) {
          const prFound = this.ctx.extractPRFromConversation(child)
          if (prFound) succeeded++
        }
      }

      await this.ctx.telegram.sendMessage(
        formatSplitAllDone(succeeded, parent.childThreadIds.length),
        parent.threadId,
      )
      await this.ctx.updateTopicTitle(parent, succeeded === parent.childThreadIds.length ? "✅" : "⚠️")

      await this.ctx.runDeferredBabysit(parent.threadId)
    }
  }
}
