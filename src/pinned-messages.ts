import path from "node:path"
import fs from "node:fs"
import type { TelegramClient } from "./telegram.js"
import type { TopicSession } from "./types.js"
import type { DagNode } from "./dag.js"
import { formatPinnedSplitStatus, formatPinnedDagStatus } from "./format.js"
import { escapeHtml } from "./command-parser.js"
import { loggers } from "./logger.js"

const log = loggers.dispatcher

const PINNED_SUMMARY_FILE = ".pinned-summary.json"

export function getPinnedSummaryPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, PINNED_SUMMARY_FILE)
}

export function loadPinnedMessageId(workspaceRoot: string): number | null {
  try {
    const raw = fs.readFileSync(getPinnedSummaryPath(workspaceRoot), "utf-8")
    const data = JSON.parse(raw) as { messageId?: number | null }
    return data.messageId ?? null
  } catch {
    return null
  }
}

export function savePinnedMessageId(workspaceRoot: string, id: number | null): void {
  try {
    fs.writeFileSync(getPinnedSummaryPath(workspaceRoot), JSON.stringify({ messageId: id }))
  } catch { /* ignore */ }
}

export function formatPinnedSummary(sessions: Iterable<TopicSession>): string {
  const arr = [...sessions]
  if (arr.length === 0) return "No active minion sessions."
  const lines = arr.map((s) => {
    const taskText = s.conversation[0]?.text ?? ""
    const desc = taskText.length > 60 ? taskText.slice(0, 60).trimEnd() + "…" : taskText
    const icon = s.activeSessionId ? "⚡" : "💬"
    return `${icon} <b>${escapeHtml(s.slug)}</b>: ${escapeHtml(desc)} (${s.mode})`
  })
  return lines.join("\n")
}

export interface UpdatePinnedSummaryArgs {
  telegram: TelegramClient
  workspaceRoot: string
  topicSessions: Map<number, TopicSession>
  pinnedSummaryMessageId: number | null
  onMessageIdChange: (id: number | null) => void
}

export async function updatePinnedSummary(args: UpdatePinnedSummaryArgs): Promise<void> {
  const html = formatPinnedSummary(args.topicSessions.values())

  if (args.pinnedSummaryMessageId !== null) {
    const ok = await args.telegram.editMessage(args.pinnedSummaryMessageId, html)
    if (ok) return
    args.onMessageIdChange(null)
    savePinnedMessageId(args.workspaceRoot, null)
  }

  const { ok, messageId } = await args.telegram.sendMessage(html)
  if (ok && messageId !== null) {
    await args.telegram.pinChatMessage(messageId)
    args.onMessageIdChange(messageId)
    savePinnedMessageId(args.workspaceRoot, messageId)
  }
}

export function scheduleUpdatePinnedSummary(args: UpdatePinnedSummaryArgs): void {
  ;(async () => {
    await updatePinnedSummary(args)
  })().catch((err) => {
    log.error({ err }, "updatePinnedSummary error")
  })
}

export async function pinThreadMessage(
  telegram: TelegramClient,
  session: TopicSession,
  html: string,
): Promise<void> {
  const threadId = session.threadId
  try {
    if (session.pinnedMessageId != null) {
      const ok = await telegram.editMessage(session.pinnedMessageId, html, threadId)
      if (ok) return
      session.pinnedMessageId = undefined
    }
    const { ok, messageId } = await telegram.sendMessage(html, threadId)
    if (ok && messageId != null) {
      await telegram.pinChatMessage(messageId)
      session.pinnedMessageId = messageId
    }
  } catch (err) {
    log.warn({ err, slug: session.slug }, "pinThreadMessage error")
  }
}

export interface SplitChildInfo {
  slug: string
  label: string
  prUrl?: string
  status: "running" | "done" | "failed"
}

export async function updatePinnedSplitStatus(
  telegram: TelegramClient,
  parent: TopicSession,
  getChildSession: (threadId: number) => TopicSession | undefined,
): Promise<void> {
  if (!parent.childThreadIds || parent.childThreadIds.length === 0) return

  const children: SplitChildInfo[] = []

  for (const id of parent.childThreadIds) {
    const child = getChildSession(id)
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
  await pinThreadMessage(telegram, parent, html)
}

export async function updatePinnedDagStatus(
  telegram: TelegramClient,
  parent: TopicSession,
  nodes: DagNode[],
): Promise<void> {
  const isStack = !nodes.some((n) => n.dependsOn.length > 1) &&
    nodes.every((n, i) => i === 0 || n.dependsOn.length === 1)

  const formattedNodes = nodes.map((n) => ({
    id: n.id,
    title: n.title,
    prUrl: n.prUrl,
    status: n.status as "pending" | "ready" | "running" | "done" | "failed",
  }))

  const html = formatPinnedDagStatus(parent.slug, parent.repo, formattedNodes, isStack)
  await pinThreadMessage(telegram, parent, html)
}
