import { execSync } from "node:child_process"
import type { DispatcherContext } from "./dispatcher-context.js"
import type { TopicSession } from "../types.js"
import { escapeHtml } from "../commands/command-parser.js"
import { loggers } from "../logger.js"

const log = loggers.dispatcher

export class TopicManager {
  private readonly ctx: DispatcherContext

  constructor(ctx: DispatcherContext) {
    this.ctx = ctx
  }

  async closeChildSessions(parent: TopicSession): Promise<void> {
    const childrenToClose = new Map<number, TopicSession>()

    if (parent.childThreadIds) {
      for (const childId of parent.childThreadIds) {
        const child = this.ctx.topicSessions.get(childId)
        if (child) childrenToClose.set(childId, child)
      }
    }

    for (const [candidateId, candidate] of this.ctx.topicSessions) {
      if (candidate.parentThreadId !== undefined &&
          candidate.parentThreadId === parent.threadId &&
          !childrenToClose.has(candidateId)) {
        childrenToClose.set(candidateId, candidate)
      }
    }

    if (childrenToClose.size > 10) {
      log.warn(
        { count: childrenToClose.size, parentThreadId: parent.threadId, parentSlug: parent.slug },
        "Unusually high number of children to close - possible bug?",
      )
    }

    await Promise.all([...childrenToClose.values()].map((child) => this.closeSingleChild(child)))

    parent.childThreadIds = []
  }

  async closeSingleChild(child: TopicSession): Promise<void> {
    const childId = child.threadId

    if (child.activeSessionId) {
      const childActive = this.ctx.sessions.get(childId)
      this.ctx.sessions.delete(childId)
      if (childActive) await childActive.handle.kill().catch(() => {})
    }
    this.ctx.topicSessions.delete(childId)
    this.ctx.broadcastSessionDeleted(child.slug)
    await this.ctx.telegram.deleteForumTopic(childId).catch(() => {})
    await this.ctx.removeWorkspace(child).catch(() => {})
    log.info({ slug: child.slug, threadId: childId }, "closed child topic")
  }

  async handleCloseCommand(topicSession: TopicSession): Promise<void> {
    const threadId = topicSession.threadId

    await this.closeChildSessions(topicSession)

    if (topicSession.dagId) {
      this.ctx.broadcastDagDeleted(topicSession.dagId)
      this.ctx.dags.delete(topicSession.dagId)
    }

    this.ctx.topicSessions.delete(threadId)
    this.ctx.broadcastSessionDeleted(topicSession.slug)
    await this.ctx.persistTopicSessions()
    this.ctx.updatePinnedSummary()
    await this.ctx.telegram.deleteForumTopic(threadId)
    log.info({ slug: topicSession.slug, threadId }, "closed and deleted topic")

    if (topicSession.activeSessionId) {
      const activeSession = this.ctx.sessions.get(threadId)
      this.ctx.sessions.delete(threadId)
      if (activeSession) {
        activeSession.handle.kill().then(
          () => this.ctx.removeWorkspace(topicSession),
          () => this.ctx.removeWorkspace(topicSession),
        ).catch((err) => {
          log.error({ err, slug: topicSession.slug }, "background cleanup failed")
        })
        return
      }
    }

    this.ctx.removeWorkspace(topicSession).catch((err) => {
      log.error({ err, slug: topicSession.slug }, "background cleanup failed")
    })
  }

  async handleDoneCommand(topicSession: TopicSession): Promise<void> {
    const threadId = topicSession.threadId

    // Short-circuit: DAG/stack children should be managed from the parent
    if (topicSession.parentThreadId || topicSession.dagNodeId) {
      await this.ctx.telegram.sendMessage(
        `⚠️ <code>/done</code> is not available on child sessions. Use <code>/done</code> or <code>/land</code> from the parent thread.`,
        threadId,
      )
      return
    }

    // Short-circuit: no PR found
    const prUrl = topicSession.prUrl ?? this.ctx.extractPRFromConversation(topicSession)
    if (!prUrl) {
      await this.ctx.telegram.sendMessage(
        `⚠️ No PR found for this session. Nothing to merge.`,
        threadId,
      )
      return
    }

    // Short-circuit: CI not green
    await this.ctx.refreshGitToken()
    try {
      const checksJson = execSync(`gh pr checks "${prUrl}" --json name,state,bucket`, {
        cwd: topicSession.cwd,
        timeout: 30_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }).trim()

      if (checksJson && checksJson !== "[]") {
        const checks = JSON.parse(checksJson) as { name: string; state: string; bucket: string }[]
        const pending = checks.filter((c) => c.bucket === "pending")
        if (pending.length > 0) {
          await this.ctx.telegram.sendMessage(
            `⚠️ CI checks still running (${pending.length} pending). Wait for CI to finish before using <code>/done</code>.`,
            threadId,
          )
          return
        }
        const failed = checks.filter((c) => c.bucket === "fail")
        if (failed.length > 0) {
          const names = failed.map((c) => `<code>${escapeHtml(c.name)}</code>`).join(", ")
          await this.ctx.telegram.sendMessage(
            `⚠️ CI is not green — ${failed.length} failed check(s): ${names}. Fix CI before using <code>/done</code>.`,
            threadId,
          )
          return
        }
      }
    } catch (err) {
      const errMsg = String((err as Error).message ?? "")
      if (!errMsg.includes("no checks reported")) {
        await this.ctx.telegram.sendMessage(
          `⚠️ Could not verify CI status: <code>${escapeHtml(errMsg.slice(0, 200))}</code>`,
          threadId,
        )
        return
      }
      // "no checks reported" — treat as OK (no CI configured)
    }

    // Merge the PR
    try {
      execSync(`gh pr merge "${prUrl}" --squash --delete-branch`, {
        cwd: topicSession.cwd,
        timeout: 120_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      })
    } catch (err) {
      const errMsg = String((err as Error).message ?? "")
      await this.ctx.telegram.sendMessage(
        `⚠️ Failed to merge PR: <code>${escapeHtml(errMsg.slice(0, 300))}</code>`,
        threadId,
      )
      return
    }

    await this.ctx.telegram.sendMessage(`✅ Merged and closed: ${prUrl}`, threadId)
    log.info({ slug: topicSession.slug, threadId, prUrl }, "/done — merged PR")

    // Close children, delete topic, wipe workspace
    await this.closeChildSessions(topicSession)

    if (topicSession.dagId) {
      this.ctx.broadcastDagDeleted(topicSession.dagId)
      this.ctx.dags.delete(topicSession.dagId)
    }

    this.ctx.topicSessions.delete(threadId)
    this.ctx.broadcastSessionDeleted(topicSession.slug)
    await this.ctx.persistTopicSessions()
    this.ctx.updatePinnedSummary()
    await this.ctx.telegram.deleteForumTopic(threadId)
    log.info({ slug: topicSession.slug, threadId }, "/done — closed topic")

    if (topicSession.activeSessionId) {
      const activeSession = this.ctx.sessions.get(threadId)
      this.ctx.sessions.delete(threadId)
      if (activeSession) {
        activeSession.handle.kill().then(
          () => this.ctx.removeWorkspace(topicSession),
          () => this.ctx.removeWorkspace(topicSession),
        ).catch((err) => {
          log.error({ err, slug: topicSession.slug }, "/done background cleanup failed")
        })
        return
      }
    }

    this.ctx.removeWorkspace(topicSession).catch((err) => {
      log.error({ err, slug: topicSession.slug }, "/done background cleanup failed")
    })
  }
}
