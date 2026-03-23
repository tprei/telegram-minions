import { execSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import crypto from "node:crypto"
import type { TelegramClient } from "./telegram.js"
import { SessionHandle } from "./session.js"
import { Observer } from "./observer.js"
import type { TelegramUpdate, TelegramCallbackQuery, TelegramPhotoSize, SessionMeta, TopicSession } from "./types.js"
import { generateSlug } from "./slugs.js"
import { config } from "./config.js"
import { SessionStore } from "./store.js"
import {
  formatPlanIteration,
  formatPlanExecuting,
  formatPlanComplete,
  formatThinkIteration,
  formatThinkComplete,
  formatStatus,
  formatTaskComplete,
  formatFollowUpIteration,
  formatHelp,
  formatQualityReport,
  formatBudgetWarning,
  formatStats,
  formatCIWatching,
  formatCIFailed,
  formatCIFixing,
  formatCIPassed,
  formatCIGaveUp,
} from "./format.js"
import { runQualityGates } from "./quality-gates.js"
import { StatsTracker } from "./stats.js"
import { writeSessionLog } from "./session-log.js"
import { extractPRUrl, waitForCI, getFailedCheckLogs, buildCIFixPrompt } from "./ci-babysit.js"
import { CI_FIX_SYSTEM_PROMPT } from "./session.js"

const POLL_TIMEOUT = 30
const TASK_PREFIX = "/task"
const PLAN_PREFIX = "/plan"
const THINK_PREFIX = "/think"
const EXECUTE_CMD = "/execute"
const STATUS_CMD = "/status"
const STATS_CMD = "/stats"
const REPLY_PREFIX = "/reply"
const REPLY_SHORT = "/r"
const CLOSE_CMD = "/close"
const HELP_CMD = "/help"
const CLEAN_CMD = "/clean"

interface ActiveSession {
  handle: SessionHandle
  meta: SessionMeta
  task: string
}

interface PendingTask {
  task: string
  threadId?: number
}

export class Dispatcher {
  private readonly sessions = new Map<number, ActiveSession>()
  private readonly topicSessions = new Map<number, TopicSession>()
  private readonly pendingTasks = new Map<number, PendingTask>()
  private readonly store: SessionStore
  private offset = 0
  private running = false
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  private readonly stats: StatsTracker

  constructor(
    private readonly telegram: TelegramClient,
    private readonly observer: Observer,
  ) {
    this.store = new SessionStore(config.workspace.root)
    this.stats = new StatsTracker(config.workspace.root)
  }

  async loadPersistedSessions(): Promise<void> {
    const { active, expired } = this.store.load()
    for (const [threadId, session] of active) {
      this.topicSessions.set(threadId, session)
    }
    if (active.size > 0) {
      process.stderr.write(`dispatcher: loaded ${active.size} persisted session(s)\n`)
    }
    if (expired.size > 0) {
      process.stderr.write(`dispatcher: cleaning ${expired.size} expired session(s)\n`)
      for (const [threadId, session] of expired) {
        await this.telegram.deleteForumTopic(threadId)
        this.removeWorkspace(session)
        process.stderr.write(`dispatcher: cleaned expired session ${session.slug} (topic ${threadId})\n`)
      }
    }
  }

  async start(): Promise<void> {
    this.running = true
    process.stderr.write("dispatcher: started, polling Telegram\n")

    while (this.running) {
      await this.poll()
    }
  }

  stop(): void {
    this.running = false
    this.stopCleanupTimer()
    for (const { handle } of this.sessions.values()) {
      handle.interrupt()
    }
    this.persistTopicSessions()
    process.stderr.write("dispatcher: stopped\n")
  }

  startCleanupTimer(): void {
    this.cleanupStaleSessions().catch((err) => {
      process.stderr.write(`dispatcher: startup cleanup error: ${err}\n`)
    })
    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleSessions().catch((err) => {
        process.stderr.write(`dispatcher: cleanup error: ${err}\n`)
      })
    }, config.workspace.cleanupIntervalMs)
    process.stderr.write(
      `dispatcher: cleanup timer started (interval=${Math.round(config.workspace.cleanupIntervalMs / 60000)}m, ttl=${Math.round(config.workspace.staleTtlMs / 86400000)}d)\n`,
    )
  }

  private stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  private async cleanupStaleSessions(): Promise<void> {
    const now = Date.now()
    const stale: [number, TopicSession][] = []

    for (const [threadId, session] of this.topicSessions) {
      if (session.activeSessionId) continue
      if (now - session.lastActivityAt > config.workspace.staleTtlMs) {
        stale.push([threadId, session])
      }
    }

    if (stale.length === 0) return

    process.stderr.write(`dispatcher: cleaning up ${stale.length} stale session(s)\n`)

    for (const [threadId, session] of stale) {
      await this.telegram.deleteForumTopic(threadId)
      this.removeWorkspace(session)
      this.topicSessions.delete(threadId)
      process.stderr.write(`dispatcher: cleaned up stale session ${session.slug} (topic ${threadId})\n`)
    }

    this.persistTopicSessions()
  }

  private persistTopicSessions(): void {
    // Only persist sessions that aren't actively running
    const toSave = new Map<number, TopicSession>()
    for (const [threadId, session] of this.topicSessions) {
      if (!session.activeSessionId) {
        toSave.set(threadId, session)
      }
    }
    this.store.save(toSave)
  }

  private async poll(): Promise<void> {
    const updates = await this.telegram.getUpdates(this.offset, POLL_TIMEOUT)

    for (const update of updates) {
      try {
        await this.handleUpdate(update)
      } catch (err) {
        process.stderr.write(`dispatcher: error handling update ${update.update_id}: ${err}\n`)
      }
    }

    if (updates.length > 0) {
      this.offset = Math.max(...updates.map((u) => u.update_id)) + 1
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query)
      return
    }

    const message = update.message
    if (!message) return

    if (message.chat.id.toString() !== config.telegram.chatId) return

    const userId = message.from?.id ?? -1
    if (!config.telegram.allowedUserIds.includes(userId)) return

    const text = (message.text ?? message.caption)?.trim()
    const photos = message.photo
    if (!text && !photos) return

    if (message.message_thread_id === undefined) {
      if (text === STATUS_CMD) {
        await this.handleStatusCommand()
        return
      }
      if (text === STATS_CMD) {
        await this.handleStatsCommand()
        return
      }
      if (text === CLEAN_CMD) {
        await this.handleCleanCommand()
        return
      }
      if (text === HELP_CMD) {
        await this.handleHelpCommand()
        return
      }
    }

    if (text?.startsWith(THINK_PREFIX)) {
      await this.handleThinkCommand(text.slice(THINK_PREFIX.length).trim(), message.message_thread_id, photos)
      return
    }

    if (text?.startsWith(PLAN_PREFIX)) {
      await this.handlePlanCommand(text.slice(PLAN_PREFIX.length).trim(), message.message_thread_id, photos)
      return
    }

    if (text?.startsWith(TASK_PREFIX)) {
      await this.handleTaskCommand(text.slice(TASK_PREFIX.length).trim(), message.message_thread_id, photos)
      return
    }

    if (message.message_thread_id !== undefined) {
      const topicSession = this.topicSessions.get(message.message_thread_id)
      if (topicSession) {
        if (text === CLOSE_CMD) {
          await this.handleCloseCommand(topicSession)
        } else if ((topicSession.mode === "plan" || topicSession.mode === "think") && text === EXECUTE_CMD) {
          await this.handleExecuteCommand(topicSession)
        } else if (text?.startsWith(REPLY_PREFIX + " ") || text?.startsWith(REPLY_SHORT + " ") || text === REPLY_PREFIX || text === REPLY_SHORT) {
          const stripped = text.startsWith(REPLY_PREFIX)
            ? text.slice(REPLY_PREFIX.length).trim()
            : text.slice(REPLY_SHORT.length).trim()
          await this.handleTopicFeedback(topicSession, stripped, photos)
        }
        return
      }

      const session = this.sessions.get(message.message_thread_id)
      if (session) {
        process.stderr.write(
          `dispatcher: received message in active topic ${message.message_thread_id}, session still initializing\n`,
        )
      }
    }
  }

  private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    if (!config.telegram.allowedUserIds.includes(query.from.id)) {
      await this.telegram.answerCallbackQuery(query.id, "Not authorized")
      return
    }

    const data = query.data
    if (!data?.startsWith("repo:") && !data?.startsWith("plan-repo:") && !data?.startsWith("think-repo:")) {
      await this.telegram.answerCallbackQuery(query.id)
      return
    }

    const isThink = data.startsWith("think-repo:")
    const isPlan = data.startsWith("plan-repo:")
    const repoSlug = isThink
      ? data.slice("think-repo:".length)
      : isPlan
      ? data.slice("plan-repo:".length)
      : data.slice("repo:".length)
    const repoUrl = config.repos[repoSlug]
    if (!repoUrl) {
      await this.telegram.answerCallbackQuery(query.id, "Unknown repo")
      return
    }

    const messageId = query.message?.message_id

    if (messageId) {
      const pending = this.pendingTasks.get(messageId)
      if (pending) {
        this.pendingTasks.delete(messageId)
        await this.telegram.answerCallbackQuery(query.id, `Selected: ${repoSlug}`)
        await this.telegram.deleteMessage(messageId)
        if (isThink) {
          await this.startTopicSession(repoUrl, pending.task, "think")
        } else if (isPlan) {
          await this.startTopicSession(repoUrl, pending.task, "plan")
        } else {
          const threadId = query.message?.message_thread_id
          await this.handleTaskCommand(`${repoUrl} ${pending.task}`, threadId)
        }
        return
      }
    }

    await this.telegram.answerCallbackQuery(query.id)
  }

  private async handleStatusCommand(): Promise<void> {
    const taskSessions = [...this.sessions.values()]
    const topicSessionList = [...this.topicSessions.values()]
    const msg = formatStatus(taskSessions, topicSessionList, config.workspace.maxConcurrentSessions)
    await this.telegram.sendMessage(msg)
  }

  private async handleStatsCommand(): Promise<void> {
    const agg = this.stats.aggregate(7)
    await this.telegram.sendMessage(formatStats(agg))
  }

  private async handleHelpCommand(): Promise<void> {
    await this.telegram.sendMessage(formatHelp())
  }

  private async handleCleanCommand(): Promise<void> {
    const idle: [number, TopicSession][] = []
    for (const [threadId, session] of this.topicSessions) {
      if (!session.activeSessionId) {
        idle.push([threadId, session])
      }
    }

    if (idle.length === 0) {
      await this.telegram.sendMessage("🧹 No idle sessions to clean.")
      return
    }

    for (const [threadId, session] of idle) {
      await this.telegram.deleteForumTopic(threadId)
      this.removeWorkspace(session)
      this.topicSessions.delete(threadId)
      process.stderr.write(`dispatcher: cleaned idle session ${session.slug} (topic ${threadId})\n`)
    }

    this.persistTopicSessions()
    await this.telegram.sendMessage(`🧹 Cleaned ${idle.length} idle session(s).`)
  }

  private async handleTaskCommand(args: string, replyThreadId?: number, photos?: TelegramPhotoSize[]): Promise<void> {
    if (this.sessions.size >= config.workspace.maxConcurrentSessions) {
      if (replyThreadId !== undefined) {
        await this.telegram.sendMessage(
          `⚠️ Max concurrent sessions (${config.workspace.maxConcurrentSessions}) reached. Wait for one to finish.`,
          replyThreadId,
        )
      }
      return
    }

    const { repoUrl, task } = parseTaskArgs(args)

    if (!task) {
      if (replyThreadId !== undefined) {
        await this.telegram.sendMessage(
          `Usage: <code>/task [repo] description of the task</code>\n` +
          `Repos: ${Object.keys(config.repos).map((s) => `<code>${s}</code>`).join(", ")}\n` +
          `Or use a full URL or omit repo entirely.`,
          replyThreadId,
        )
      }
      return
    }

    if (!repoUrl) {
      const repoKeys = Object.keys(config.repos)
      if (repoKeys.length > 0) {
        const keyboard = buildRepoKeyboard(repoKeys)
        const msgId = await this.telegram.sendMessageWithKeyboard(
          `Pick a repo for: <i>${escapeHtml(task)}</i>`,
          keyboard,
          replyThreadId,
        )
        if (msgId) {
          this.pendingTasks.set(msgId, { task, threadId: replyThreadId })
        }
        return
      }
    }

    await this.startTopicSession(repoUrl, task, "task", photos)
  }

  private async handlePlanCommand(args: string, replyThreadId?: number, photos?: TelegramPhotoSize[]): Promise<void> {
    const { repoUrl, task } = parseTaskArgs(args)

    if (!task) {
      if (replyThreadId !== undefined) {
        await this.telegram.sendMessage(
          `Usage: <code>/plan [repo] description of what to plan</code>`,
          replyThreadId,
        )
      }
      return
    }

    if (!repoUrl) {
      const repoKeys = Object.keys(config.repos)
      if (repoKeys.length > 0) {
        const keyboard = buildRepoKeyboard(repoKeys, "plan")
        const msgId = await this.telegram.sendMessageWithKeyboard(
          `Pick a repo for plan: <i>${escapeHtml(task)}</i>`,
          keyboard,
          replyThreadId,
        )
        if (msgId) {
          this.pendingTasks.set(msgId, { task, threadId: replyThreadId })
        }
        return
      }
    }

    await this.startTopicSession(repoUrl, task, "plan", photos)
  }

  private async handleThinkCommand(args: string, replyThreadId?: number, photos?: TelegramPhotoSize[]): Promise<void> {
    const { repoUrl, task } = parseTaskArgs(args)

    if (!task) {
      if (replyThreadId !== undefined) {
        await this.telegram.sendMessage(
          `Usage: <code>/think [repo] question or topic to research</code>`,
          replyThreadId,
        )
      }
      return
    }

    if (!repoUrl) {
      const repoKeys = Object.keys(config.repos)
      if (repoKeys.length > 0) {
        const keyboard = buildRepoKeyboard(repoKeys, "think")
        const msgId = await this.telegram.sendMessageWithKeyboard(
          `Pick a repo for research: <i>${escapeHtml(task)}</i>`,
          keyboard,
          replyThreadId,
        )
        if (msgId) {
          this.pendingTasks.set(msgId, { task, threadId: replyThreadId })
        }
        return
      }
    }

    await this.startTopicSession(repoUrl, task, "think", photos)
  }

  private async startTopicSession(
    repoUrl: string | undefined,
    task: string,
    mode: "task" | "plan" | "think",
    photos?: TelegramPhotoSize[],
  ): Promise<void> {
    const sessionId = crypto.randomUUID()
    const slug = generateSlug(sessionId)
    const repo = repoUrl ? extractRepoName(repoUrl) : "local"
    const topicName = mode === "think"
      ? `🧠 ${repo} · ${slug}`
      : mode === "plan"
      ? `📋 ${repo} · ${slug}`
      : `${repo} · ${slug}`

    let topic: { message_thread_id: number }
    try {
      topic = await this.telegram.createForumTopic(topicName)
    } catch (err) {
      process.stderr.write(`dispatcher: failed to create topic: ${err}\n`)
      return
    }

    const threadId = topic.message_thread_id

    const cwd = await this.prepareWorkspace(slug, repoUrl)
    if (!cwd) {
      await this.telegram.sendMessage(`❌ Failed to prepare workspace.`, threadId)
      await this.telegram.deleteForumTopic(threadId)
      return
    }

    const imagePaths = await this.downloadPhotos(photos, cwd)
    const fullTask = appendImageContext(task, imagePaths)

    const topicSession: TopicSession = {
      threadId,
      repo,
      repoUrl,
      cwd,
      slug,
      conversation: [{ role: "user", text: fullTask, images: imagePaths.length > 0 ? imagePaths : undefined }],
      pendingFeedback: [],
      mode,
      lastActivityAt: Date.now(),
    }

    this.topicSessions.set(threadId, topicSession)

    await this.spawnTopicAgent(topicSession, fullTask)
  }

  private async spawnTopicAgent(topicSession: TopicSession, task: string): Promise<void> {
    if (this.sessions.size >= config.workspace.maxConcurrentSessions) {
      await this.telegram.sendMessage(
        `⚠️ Max concurrent sessions reached. Try again later.`,
        topicSession.threadId,
      )
      return
    }

    const sessionId = crypto.randomUUID()
    topicSession.activeSessionId = sessionId

    const meta: SessionMeta = {
      sessionId,
      threadId: topicSession.threadId,
      topicName: topicSession.slug,
      repo: topicSession.repo,
      cwd: topicSession.cwd,
      startedAt: Date.now(),
      mode: topicSession.mode,
    }

    const onTextCapture = (_sid: string, text: string) => {
      topicSession.conversation.push({ role: "assistant", text })
    }

    const handle = new SessionHandle(
      meta,
      (event) => {
        this.observer.onEvent(meta, event).catch((err) => {
          process.stderr.write(`observer: onEvent error: ${err}\n`)
        })


        if (event.type === "complete" && meta.totalTokens != null && meta.totalTokens > config.workspace.sessionTokenBudget) {
          process.stderr.write(
            `dispatcher: session ${sessionId} exceeded token budget (${meta.totalTokens} > ${config.workspace.sessionTokenBudget})\n`,
          )
          this.telegram.sendMessage(
            formatBudgetWarning(topicSession.slug, meta.totalTokens, config.workspace.sessionTokenBudget),
            topicSession.threadId,
          ).catch(() => {})
          handle.interrupt()
        }
      },
      (m, state) => {
        const durationMs = Date.now() - m.startedAt
        this.sessions.delete(topicSession.threadId)
        topicSession.activeSessionId = undefined
        topicSession.lastActivityAt = Date.now()

        this.stats.record({
          slug: topicSession.slug,
          repo: topicSession.repo,
          mode: topicSession.mode,
          state,
          durationMs,
          totalTokens: m.totalTokens ?? 0,
          timestamp: Date.now(),
        })

        if (topicSession.mode === "think") {
          this.observer.onSessionComplete(m, state, durationMs).catch((err) => {
            process.stderr.write(`observer: onSessionComplete error: ${err}\n`)
          })
          this.telegram.sendMessage(
            formatThinkComplete(topicSession.slug),
            topicSession.threadId,
          ).catch(() => {})
          writeSessionLog(topicSession, m, state, durationMs)
        } else if (topicSession.mode === "plan") {
          this.observer.onSessionComplete(m, state, durationMs).catch((err) => {
            process.stderr.write(`observer: onSessionComplete error: ${err}\n`)
          })
          this.telegram.sendMessage(
            formatPlanComplete(topicSession.slug),
            topicSession.threadId,
          ).catch(() => {})
          writeSessionLog(topicSession, m, state, durationMs)
        } else if (state === "errored") {
          this.observer.onSessionComplete(m, state, durationMs).catch((err) => {
            process.stderr.write(`observer: onSessionComplete error: ${err}\n`)
          })
          writeSessionLog(topicSession, m, state, durationMs)
        } else {
          this.observer.flushAndComplete(m, state, durationMs).then(async () => {
            await this.telegram.sendMessage(
              formatTaskComplete(topicSession.slug, durationMs, m.totalTokens),
              topicSession.threadId,
            )

            let qualityReport
            try {
              qualityReport = runQualityGates(topicSession.cwd)
              if (qualityReport.results.length > 0) {
                await this.telegram.sendMessage(
                  formatQualityReport(qualityReport.results),
                  topicSession.threadId,
                )
              }
            } catch (err) {
              process.stderr.write(`dispatcher: quality gates error: ${err}\n`)
            }

            writeSessionLog(topicSession, m, state, durationMs, qualityReport)

            if (config.ci.babysitEnabled && topicSession.mode === "task") {
              const prUrl = this.extractPRFromConversation(topicSession)
              if (prUrl) {
                this.babysitPR(topicSession, prUrl).catch((err) => {
                  process.stderr.write(`dispatcher: babysitPR error: ${err}\n`)
                })
              }
            }
          }).catch((err) => {
            process.stderr.write(`observer: flushAndComplete error: ${err}\n`)
          })
        }

        this.persistTopicSessions()

        if (topicSession.pendingFeedback.length > 0) {
          const feedback = topicSession.pendingFeedback.join("\n\n")
          topicSession.pendingFeedback = []
          this.handleTopicFeedback(topicSession, feedback).catch((err) => {
            process.stderr.write(`dispatcher: queued feedback error: ${err}\n`)
          })
        }
      },
      config.workspace.sessionTimeoutMs,
    )

    this.sessions.set(topicSession.threadId, { handle, meta, task })

    await this.observer.onSessionStart(meta, task, onTextCapture)
    handle.start(task)
  }

  private extractPRFromConversation(topicSession: TopicSession): string | null {
    for (let i = topicSession.conversation.length - 1; i >= 0; i--) {
      const msg = topicSession.conversation[i]
      if (msg.role === "assistant") {
        const url = extractPRUrl(msg.text)
        if (url) return url
      }
    }
    return null
  }

  private async babysitPR(topicSession: TopicSession, prUrl: string): Promise<void> {
    const maxRetries = config.ci.maxRetries

    await this.telegram.sendMessage(
      formatCIWatching(topicSession.slug, prUrl),
      topicSession.threadId,
    )

    process.stderr.write(`dispatcher: watching CI for PR ${prUrl} (max ${maxRetries} retries)\n`)

    const result = await waitForCI(prUrl, topicSession.cwd)

    if (result.passed) {
      await this.telegram.sendMessage(
        formatCIPassed(topicSession.slug, prUrl),
        topicSession.threadId,
      )
      process.stderr.write(`dispatcher: CI passed for PR ${prUrl}\n`)
      return
    }

    if (result.timedOut && result.checks.length === 0) {
      process.stderr.write(`dispatcher: no CI checks found for PR ${prUrl}, skipping babysit\n`)
      return
    }

    const failedChecks = result.checks.filter((c) => c.state !== "success")

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await this.telegram.sendMessage(
        formatCIFailed(topicSession.slug, failedChecks.map((c) => c.name), attempt, maxRetries),
        topicSession.threadId,
      )

      const failureDetails = getFailedCheckLogs(prUrl, topicSession.cwd)
      const fixPrompt = buildCIFixPrompt(prUrl, failedChecks, failureDetails, attempt, maxRetries)

      await this.telegram.sendMessage(
        formatCIFixing(topicSession.slug, attempt, maxRetries),
        topicSession.threadId,
      )

      process.stderr.write(`dispatcher: spawning CI fix session (attempt ${attempt}/${maxRetries}) for PR ${prUrl}\n`)

      topicSession.mode = "ci-fix"
      topicSession.conversation.push({ role: "user", text: fixPrompt })

      await new Promise<void>((resolve) => {
        this.spawnCIFixAgent(topicSession, fixPrompt, () => resolve())
      })

      process.stderr.write(`dispatcher: CI fix session completed (attempt ${attempt}/${maxRetries})\n`)

      const recheck = await waitForCI(prUrl, topicSession.cwd)

      if (recheck.passed) {
        await this.telegram.sendMessage(
          formatCIPassed(topicSession.slug, prUrl),
          topicSession.threadId,
        )
        process.stderr.write(`dispatcher: CI passed after fix attempt ${attempt}\n`)
        topicSession.mode = "task"
        return
      }

      const newFailed = recheck.checks.filter((c) => c.state !== "success")
      if (newFailed.length > failedChecks.length) {
        process.stderr.write(`dispatcher: CI failures grew from ${failedChecks.length} to ${newFailed.length}, aborting\n`)
        break
      }
    }

    await this.telegram.sendMessage(
      formatCIGaveUp(topicSession.slug, maxRetries),
      topicSession.threadId,
    )
    topicSession.mode = "task"
  }

  private async spawnCIFixAgent(
    topicSession: TopicSession,
    task: string,
    onComplete: () => void,
  ): Promise<void> {
    if (this.sessions.size >= config.workspace.maxConcurrentSessions) {
      process.stderr.write(`dispatcher: no session slots for CI fix, skipping\n`)
      onComplete()
      return
    }

    const sessionId = crypto.randomUUID()
    topicSession.activeSessionId = sessionId

    const meta: SessionMeta = {
      sessionId,
      threadId: topicSession.threadId,
      topicName: topicSession.slug,
      repo: topicSession.repo,
      cwd: topicSession.cwd,
      startedAt: Date.now(),
      mode: "ci-fix",
    }

    const handle = new SessionHandle(
      meta,
      (event) => {
        this.observer.onEvent(meta, event).catch((err) => {
          process.stderr.write(`observer: CI fix onEvent error: ${err}\n`)
        })
      },
      (m, state) => {
        const durationMs = Date.now() - m.startedAt
        this.sessions.delete(topicSession.threadId)
        topicSession.activeSessionId = undefined
        topicSession.lastActivityAt = Date.now()

        this.stats.record({
          slug: topicSession.slug,
          repo: topicSession.repo,
          mode: "ci-fix",
          state,
          durationMs,
          totalTokens: m.totalTokens ?? 0,
          timestamp: Date.now(),
        })

        this.observer.flushAndComplete(m, state, durationMs).then(() => {
          writeSessionLog(topicSession, m, state, durationMs)
          onComplete()
        }).catch(() => {
          onComplete()
        })
      },
      config.workspace.sessionTimeoutMs,
    )

    this.sessions.set(topicSession.threadId, { handle, meta, task })

    await this.observer.onSessionStart(meta, task)
    handle.start(task, CI_FIX_SYSTEM_PROMPT)
  }

  private async handleTopicFeedback(topicSession: TopicSession, feedback: string, photos?: TelegramPhotoSize[]): Promise<void> {
    if (topicSession.activeSessionId) {
      topicSession.pendingFeedback.push(feedback)
      await this.telegram.sendMessage(
        `📝 Reply queued — will be applied when the current iteration finishes.`,
        topicSession.threadId,
      )
      return
    }

    const imagePaths = await this.downloadPhotos(photos, topicSession.cwd)
    const fullFeedback = appendImageContext(feedback, imagePaths)

    topicSession.conversation.push({
      role: "user",
      text: fullFeedback,
      images: imagePaths.length > 0 ? imagePaths : undefined,
    })

    const iteration = Math.floor(topicSession.conversation.filter((m) => m.role === "user").length)

    if (topicSession.mode === "think") {
      await this.telegram.sendMessage(
        formatThinkIteration(topicSession.slug, iteration),
        topicSession.threadId,
      )
    } else if (topicSession.mode === "plan") {
      await this.telegram.sendMessage(
        formatPlanIteration(topicSession.slug, iteration),
        topicSession.threadId,
      )
    } else {
      await this.telegram.sendMessage(
        formatFollowUpIteration(topicSession.slug, iteration),
        topicSession.threadId,
      )
    }

    const contextTask = buildContextPrompt(topicSession)
    await this.spawnTopicAgent(topicSession, contextTask)
  }

  private async handleExecuteCommand(topicSession: TopicSession): Promise<void> {
    // If agent is still running, interrupt it first
    if (topicSession.activeSessionId) {
      const activeSession = this.sessions.get(topicSession.threadId)
      if (activeSession) {
        activeSession.handle.interrupt()
      }
      // Wait briefly for the process to exit so the session slot frees up
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    const executionTask = buildExecutionPrompt(topicSession)

    await this.telegram.sendMessage(
      formatPlanExecuting(topicSession.slug, "starting…"),
      topicSession.threadId,
    )

    // Switch mode from plan to task in the same topic
    topicSession.mode = "task"
    topicSession.activeSessionId = undefined
    topicSession.pendingFeedback = []

    await this.spawnTopicAgent(topicSession, executionTask)
  }

  private async handleCloseCommand(topicSession: TopicSession): Promise<void> {
    const threadId = topicSession.threadId

    if (topicSession.activeSessionId) {
      const activeSession = this.sessions.get(threadId)
      if (activeSession) {
        activeSession.handle.interrupt()
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
      this.sessions.delete(threadId)
    }

    this.removeWorkspace(topicSession)
    this.topicSessions.delete(threadId)
    this.persistTopicSessions()
    await this.telegram.deleteForumTopic(threadId)
    process.stderr.write(`dispatcher: closed and deleted topic ${topicSession.slug} (thread ${threadId})\n`)
  }

  private async downloadPhotos(photos: TelegramPhotoSize[] | undefined, _cwd: string): Promise<string[]> {
    if (!photos || photos.length === 0) return []

    const imagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "minion-images-"))

    // Telegram sends multiple sizes; pick the largest (last in the array)
    const largest = photos[photos.length - 1]
    const filename = `${largest.file_unique_id}.jpg`
    const destPath = path.join(imagesDir, filename)

    const ok = await this.telegram.downloadFile(largest.file_id, destPath)
    if (!ok) return []

    return [destPath]
  }

  private async prepareWorkspace(slug: string, repoUrl?: string): Promise<string | null> {
    const workDir = path.join(config.workspace.root, slug)

    try {
      if (repoUrl) {
        const reposDir = path.join(config.workspace.root, ".repos")
        fs.mkdirSync(reposDir, { recursive: true })

        const repoName = extractRepoName(repoUrl)
        const bareDir = path.join(reposDir, `${repoName}.git`)
        const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
        const stdio: import("node:child_process").StdioOptions = ["ignore", "pipe", "pipe"]
        const gitOpts = { stdio, timeout: 120_000, env: gitEnv }

        if (fs.existsSync(bareDir)) {
          process.stderr.write(`dispatcher: fetching ${repoUrl} in ${bareDir}\n`)
          execSync(`git fetch --prune origin`, { ...gitOpts, cwd: bareDir })
        } else {
          process.stderr.write(`dispatcher: cloning bare ${repoUrl} into ${bareDir}\n`)
          execSync(`git clone --bare ${JSON.stringify(repoUrl)} ${JSON.stringify(bareDir)}`, gitOpts)
        }

        const branch = `minion/${slug}`
        const startRef = resolveDefaultBranch(bareDir, gitOpts)
        process.stderr.write(`dispatcher: adding worktree ${workDir} (branch ${branch}) from ${startRef}\n`)
        execSync(
          `git worktree add ${JSON.stringify(workDir)} -b ${JSON.stringify(branch)} ${startRef}`,
          { ...gitOpts, cwd: bareDir },
        )

        execSync(`git remote set-url origin ${JSON.stringify(repoUrl)}`, { ...gitOpts, cwd: workDir })
      } else {
        fs.mkdirSync(workDir, { recursive: true })
      }

      return workDir
    } catch (err) {
      process.stderr.write(`dispatcher: prepareWorkspace failed: ${err}\n`)
      return null
    }
  }

  private removeWorkspace(topicSession: TopicSession): void {
    if (!topicSession.cwd || !fs.existsSync(topicSession.cwd)) return

    try {
      if (topicSession.repoUrl) {
        const repoName = extractRepoName(topicSession.repoUrl)
        const bareDir = path.join(config.workspace.root, ".repos", `${repoName}.git`)
        if (fs.existsSync(bareDir)) {
          execSync(`git worktree remove --force ${JSON.stringify(topicSession.cwd)}`, {
            cwd: bareDir,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30_000,
          })
          process.stderr.write(`dispatcher: removed worktree ${topicSession.cwd}\n`)
          return
        }
      }

      fs.rmSync(topicSession.cwd, { recursive: true, force: true })
      process.stderr.write(`dispatcher: removed workspace ${topicSession.cwd}\n`)
    } catch (err) {
      process.stderr.write(`dispatcher: failed to remove workspace ${topicSession.cwd}: ${err}\n`)
      try {
        fs.rmSync(topicSession.cwd, { recursive: true, force: true })
      } catch { /* best effort */ }
    }
  }

  activeSessions(): number {
    return this.sessions.size
  }
}

export function resolveDefaultBranch(bareDir: string, gitOpts: object): string {
  try {
    const ref = execSync("git symbolic-ref HEAD", { ...gitOpts, cwd: bareDir })
      .toString().trim()
    const branch = ref.replace("refs/heads/", "")
    execSync(`git rev-parse --verify refs/heads/${branch}`, { ...gitOpts, cwd: bareDir })
    return branch
  } catch { /* detached HEAD, unborn branch, or not set */ }

  for (const name of ["main", "master"]) {
    try {
      execSync(`git rev-parse --verify refs/heads/${name}`, { ...gitOpts, cwd: bareDir })
      return name
    } catch { /* doesn't exist */ }
  }

  throw new Error("cannot determine default branch")
}

export function parseTaskArgs(args: string): { repoUrl?: string; task: string } {
  const urlPattern = /^(https?:\/\/[^\s]+)\s+([\s\S]+)$/
  const match = urlPattern.exec(args)

  if (match) {
    return { repoUrl: match[1], task: match[2].trim() }
  }

  // Check for repo alias as first word
  const spaceIdx = args.indexOf(" ")
  if (spaceIdx > 0) {
    const firstWord = args.slice(0, spaceIdx)
    const aliasUrl = config.repos[firstWord]
    if (aliasUrl) {
      return { repoUrl: aliasUrl, task: args.slice(spaceIdx + 1).trim() }
    }
  }

  return { task: args.trim() }
}

export function buildRepoKeyboard(
  repoKeys: string[],
  prefix: "repo" | "plan" | "think" = "repo",
): { text: string; callback_data: string }[][] {
  const dataPrefix = prefix === "think" ? "think-repo" : prefix === "plan" ? "plan-repo" : "repo"
  const rows: { text: string; callback_data: string }[][] = []
  for (let i = 0; i < repoKeys.length; i += 2) {
    const row = [{ text: repoKeys[i], callback_data: `${dataPrefix}:${repoKeys[i]}` }]
    if (i + 1 < repoKeys.length) {
      row.push({ text: repoKeys[i + 1], callback_data: `${dataPrefix}:${repoKeys[i + 1]}` })
    }
    rows.push(row)
  }
  return rows
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function extractRepoName(url: string): string {
  try {
    const parts = url.replace(/\.git$/, "").split("/")
    return parts[parts.length - 1] ?? "repo"
  } catch {
    return "repo"
  }
}

export function appendImageContext(task: string, imagePaths: string[]): string {
  if (imagePaths.length === 0) return task

  const imageRefs = imagePaths.map((p) => `- \`${p}\``).join("\n")
  return `${task}\n\n## Attached images\n\nThe user attached the following image(s). Read them with your file-reading tool to view their contents:\n${imageRefs}`
}

export function buildContextPrompt(topicSession: TopicSession): string {
  const isThink = topicSession.mode === "think"
  const isPlan = topicSession.mode === "plan"
  const header = isThink
    ? "## Research context\n\nYou are continuing a deep-research conversation. Here is the history:"
    : isPlan
    ? "## Planning context\n\nYou are continuing a planning conversation. Here is the history:"
    : "## Follow-up context\n\nYou previously worked on this task. Here is the conversation history:"

  const MAX_ASSISTANT_CHARS = 4000
  const lines: string[] = [header, ""]

  for (const msg of topicSession.conversation) {
    const label = msg.role === "user" ? "**User**" : "**Agent**"
    lines.push(`${label}:`)
    if (msg.role === "assistant" && msg.text.length > MAX_ASSISTANT_CHARS) {
      lines.push(`[earlier output truncated]\n…${msg.text.slice(-MAX_ASSISTANT_CHARS)}`)
    } else {
      lines.push(msg.text)
    }
    lines.push("")
  }

  lines.push("---")
  if (isThink) {
    lines.push("Dig deeper based on the latest question. Search the web for additional context. Be thorough.")
  } else if (isPlan) {
    lines.push("Refine the plan based on the latest feedback. Present the updated plan clearly.")
  } else {
    lines.push("The workspace still has your previous changes (branch, commits, PR).")
    lines.push("Address the user's latest feedback. Push updates to the existing branch.")
  }

  return lines.join("\n")
}

export function buildExecutionPrompt(topicSession: TopicSession): string {
  const MAX_ASSISTANT_CHARS = 4000
  const conversation = topicSession.conversation

  const originalRequest = conversation[0]?.text ?? ""

  const lines: string[] = [
    "## Task",
    "",
    originalRequest,
    "",
  ]

  if (conversation.length > 1) {
    const isThink = topicSession.mode === "think"
    lines.push(isThink ? "## Research thread" : "## Planning thread")
    lines.push("")
    for (const msg of conversation.slice(1)) {
      const label = msg.role === "user" ? "**User**" : "**Agent**"
      lines.push(`${label}:`)
      if (msg.role === "assistant" && msg.text.length > MAX_ASSISTANT_CHARS) {
        lines.push(`[earlier output truncated]\n…${msg.text.slice(-MAX_ASSISTANT_CHARS)}`)
      } else {
        lines.push(msg.text)
      }
      lines.push("")
    }
  }

  lines.push("---")
  lines.push("Implement the plan above. Follow the plan closely.")

  return lines.join("\n")
}
