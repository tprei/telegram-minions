import path from "node:path"
import fs from "node:fs"
import type { TelegramClient } from "./telegram.js"
import type { TopicSession } from "./types.js"
import type { DagGraph } from "./dag.js"
import {
  formatPinnedSplitStatus,
  formatPinnedDagStatus,
} from "./format.js"
import { escapeHtml } from "./command-parser.js"
import { loggers } from "./logger.js"

const log = loggers.dispatcher

export interface PinnedMessageDeps {
  readonly telegram: TelegramClient
  readonly topicSessions: Map<number, TopicSession>
  readonly workspaceRoot: string
}

export class PinnedMessageManager {
  private pinnedSummaryMessageId: number | null = null
  private readonly deps: PinnedMessageDeps

  constructor(deps: PinnedMessageDeps) {
    this.deps = deps
    this.loadPinnedMessageId()
  }

  private get pinnedSummaryPath(): string {
    return path.join(this.deps.workspaceRoot, ".pinned-summary.json")
  }

  private loadPinnedMessageId(): void {
    try {
      const raw = fs.readFileSync(this.pinnedSummaryPath, "utf-8")
      const data = JSON.parse(raw) as { messageId?: number | null }
      this.pinnedSummaryMessageId = data.messageId ?? null
    } catch { /* file doesn't exist yet */ }
  }

  private savePinnedMessageId(id: number | null): void {
    try {
      fs.writeFileSync(this.pinnedSummaryPath, JSON.stringify({ messageId: id }))
    } catch { /* ignore */ }
  }

  private formatPinnedSummary(): string {
    const sessions = [...this.deps.topicSessions.values()]
    if (sessions.length === 0) return "No active minion sessions."
    const lines = sessions.map((s) => {
      const taskText = s.conversation[0]?.text ?? ""
      const desc = taskText.length > 60 ? taskText.slice(0, 60).trimEnd() + "…" : taskText
      const icon = s.activeSessionId ? "⚡" : "💬"
      return `${icon} <b>${escapeHtml(s.slug)}</b>: ${escapeHtml(desc)} (${s.mode})`
    })
    return lines.join("\n")
  }

  updatePinnedSummary(): void {
    const html = this.formatPinnedSummary()
    ;(async () => {
      if (this.pinnedSummaryMessageId !== null) {
        const ok = await this.deps.telegram.editMessage(this.pinnedSummaryMessageId, html)
        if (ok) return
        this.pinnedSummaryMessageId = null
        this.savePinnedMessageId(null)
      }
      const { ok, messageId } = await this.deps.telegram.sendMessage(html)
      if (ok && messageId !== null) {
        await this.deps.telegram.pinChatMessage(messageId)
        this.pinnedSummaryMessageId = messageId
        this.savePinnedMessageId(messageId)
      }
    })().catch((err) => {
      log.error({ err }, "updatePinnedSummary error")
    })
  }

  async pinThreadMessage(session: TopicSession, html: string): Promise<void> {
    const threadId = session.threadId
    try {
      if (session.pinnedMessageId != null) {
        const ok = await this.deps.telegram.editMessage(session.pinnedMessageId, html, threadId)
        if (ok) return
        session.pinnedMessageId = undefined
      }
      const { ok, messageId } = await this.deps.telegram.sendMessage(html, threadId)
      if (ok && messageId != null) {
        await this.deps.telegram.pinChatMessage(messageId)
        session.pinnedMessageId = messageId
      }
    } catch (err) {
      log.warn({ err, slug: session.slug }, "pinThreadMessage error")
    }
  }

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
    await this.pinThreadMessage(parent, html)
  }

  async updatePinnedDagStatus(parent: TopicSession, graph: DagGraph): Promise<void> {
    const isStack = !graph.nodes.some((n) => n.dependsOn.length > 1) &&
      graph.nodes.every((n, i) => i === 0 || n.dependsOn.length === 1)

    const nodes = graph.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      dependsOn: n.dependsOn,
      prUrl: n.prUrl,
      threadId: n.threadId,
      status: n.status as "pending" | "ready" | "running" | "done" | "failed",
    }))

    const html = formatPinnedDagStatus(parent.slug, parent.repo, nodes, isStack)
    await this.pinThreadMessage(parent, html)
  }

  async updateTopicTitle(topicSession: TopicSession, stateEmoji: string): Promise<void> {
    const name = `${stateEmoji} ${topicSession.repo} · ${topicSession.slug}`
    await this.deps.telegram.editForumTopic(topicSession.threadId, name).catch(() => {})
  }
}
