import path from "node:path"
import fs from "node:fs"
import type { TelegramClient } from "./telegram.js"
import type { TopicSession } from "./types.js"
import type { DagGraph } from "./dag.js"
import {
  formatPinnedSplitStatus,
  formatPinnedDagStatus,
  threadLink,
  esc,
  truncate,
} from "./format.js"
import { loggers } from "./logger.js"

const log = loggers.dispatcher

export interface PinnedMessageDeps {
  readonly telegram: TelegramClient
  readonly topicSessions: Map<number, TopicSession>
  readonly workspaceRoot: string
  readonly chatId?: number | string
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

    const chatId = this.deps.chatId
    const childSet = new Set<number>()
    for (const s of sessions) {
      if (s.parentThreadId != null) childSet.add(s.threadId)
    }

    const topLevel = sessions.filter((s) => !childSet.has(s.threadId))
    const lines: string[] = [`🤖 <b>Minion Sessions</b> (${sessions.length} total)`, ``]

    for (const s of topLevel) {
      const icon = s.activeSessionId ? "⚡" : s.lastState === "errored" ? "❌" : s.prUrl ? "✅" : "💬"
      const link = threadLink(chatId, s.threadId)
      const slugPart = link
        ? `<a href="${esc(link)}">${esc(s.slug)}</a>`
        : `<code>${esc(s.slug)}</code>`
      const desc = truncate(s.conversation[0]?.text ?? "", 50)
      const prPart = s.prUrl ? ` · <a href="${esc(s.prUrl)}">PR</a>` : ""

      const children = (s.childThreadIds ?? [])
        .map((id) => this.deps.topicSessions.get(id))
        .filter((c): c is TopicSession => c != null)

      if (children.length === 0) {
        lines.push(`${icon} ${slugPart}: ${esc(desc)}${prPart}`)
      } else {
        const doneCount = children.filter((c) => c.prUrl && !c.activeSessionId).length
        lines.push(`${icon} ${slugPart}: ${esc(desc)} (${doneCount}/${children.length} done)`)
        for (let i = 0; i < children.length; i++) {
          const child = children[i]
          const isLast = i === children.length - 1
          const branch = isLast ? "└── " : "├── "
          const childIcon = child.activeSessionId ? "⚡" : child.lastState === "errored" ? "❌" : child.prUrl ? "✅" : "⏳"
          const childLink = threadLink(chatId, child.threadId)
          const childSlug = childLink
            ? `<a href="${esc(childLink)}">${esc(child.slug)}</a>`
            : `<code>${esc(child.slug)}</code>`
          const label = child.splitLabel ? `: ${esc(truncate(child.splitLabel, 40))}` : ""
          const childPr = child.prUrl ? ` · <a href="${esc(child.prUrl)}">PR</a>` : ""
          lines.push(`${branch}${childIcon} ${childSlug}${label}${childPr}`)
        }
      }
    }

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

    const children: { slug: string; label: string; prUrl?: string; threadId?: number; status: "running" | "done" | "failed" }[] = []

    for (const id of parent.childThreadIds) {
      const child = this.deps.topicSessions.get(id)
      if (!child) continue
      children.push({
        slug: child.slug,
        label: child.splitLabel ?? child.slug,
        prUrl: child.prUrl,
        threadId: child.threadId,
        status: child.activeSessionId ? "running" : child.prUrl ? "done" : "failed",
      })
    }

    if (children.length === 0) return

    const html = formatPinnedSplitStatus(parent.slug, parent.repo, children, this.deps.chatId)
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

    const html = formatPinnedDagStatus(parent.slug, parent.repo, nodes, isStack, this.deps.chatId)
    await this.pinThreadMessage(parent, html)
  }

  async updateTopicTitle(topicSession: TopicSession, stateEmoji: string): Promise<void> {
    const name = `${stateEmoji} ${topicSession.repo} · ${topicSession.slug}`
    await this.deps.telegram.editForumTopic(topicSession.threadId, name).catch(() => {})
  }
}
