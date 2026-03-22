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
  formatStatus,
  formatTaskComplete,
  formatFollowUpIteration,
} from "./format.js"

const POLL_TIMEOUT = 30
const TASK_PREFIX = "/task"
const PLAN_PREFIX = "/plan"
const EXECUTE_CMD = "/execute"
const STATUS_CMD = "/status"

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

  constructor(
    private readonly telegram: TelegramClient,
    private readonly observer: Observer,
  ) {
    this.store = new SessionStore(config.workspace.root)
  }

  loadPersistedSessions(): void {
    const persisted = this.store.load()
    for (const [threadId, session] of persisted) {
      this.topicSessions.set(threadId, session)
    }
    if (persisted.size > 0) {
      process.stderr.write(`dispatcher: loaded ${persisted.size} persisted session(s)\n`)
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

      if (session.cwd && fs.existsSync(session.cwd)) {
        try {
          fs.rmSync(session.cwd, { recursive: true, force: true })
          process.stderr.write(`dispatcher: removed workspace ${session.cwd}\n`)
        } catch (err) {
          process.stderr.write(`dispatcher: failed to remove workspace ${session.cwd}: ${err}\n`)
        }
      }

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

    if (text === STATUS_CMD && message.message_thread_id === undefined) {
      await this.handleStatusCommand()
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
        if (topicSession.mode === "plan" && text === EXECUTE_CMD) {
          await this.handleExecuteCommand(topicSession)
        } else {
          await this.handleTopicFeedback(topicSession, text ?? "", photos)
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
    if (!data?.startsWith("repo:") && !data?.startsWith("plan-repo:")) {
      await this.telegram.answerCallbackQuery(query.id)
      return
    }

    const isPlan = data.startsWith("plan-repo:")
    const repoSlug = isPlan ? data.slice("plan-repo:".length) : data.slice("repo:".length)
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
        if (isPlan) {
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

  private async startTopicSession(
    repoUrl: string | undefined,
    task: string,
    mode: "task" | "plan",
    photos?: TelegramPhotoSize[],
  ): Promise<void> {
    const sessionId = crypto.randomUUID()
    const slug = generateSlug(sessionId)
    const repo = repoUrl ? extractRepoName(repoUrl) : "local"
    const topicName = mode === "plan" ? `📋 ${repo} · ${slug}` : `${repo} · ${slug}`

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
      },
      (m, state) => {
        const durationMs = Date.now() - m.startedAt
        this.sessions.delete(topicSession.threadId)
        topicSession.activeSessionId = undefined
        topicSession.lastActivityAt = Date.now()

        if (topicSession.mode === "plan") {
          this.observer.onSessionComplete(m, state, durationMs).catch((err) => {
            process.stderr.write(`observer: onSessionComplete error: ${err}\n`)
          })
          this.telegram.sendMessage(
            formatPlanComplete(topicSession.slug),
            topicSession.threadId,
          ).catch(() => {})
        } else if (state === "errored") {
          this.observer.onSessionComplete(m, state, durationMs).catch((err) => {
            process.stderr.write(`observer: onSessionComplete error: ${err}\n`)
          })
        } else {
          // Task mode completed: flush text then send completion with follow-up hint
          this.observer.flushAndComplete(m, state, durationMs).then(() => {
            this.telegram.sendMessage(
              formatTaskComplete(topicSession.slug, durationMs, m.totalTokens),
              topicSession.threadId,
            ).catch(() => {})
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

  private async handleTopicFeedback(topicSession: TopicSession, feedback: string, photos?: TelegramPhotoSize[]): Promise<void> {
    if (topicSession.activeSessionId) {
      topicSession.pendingFeedback.push(feedback)
      await this.telegram.sendMessage(
        `📝 Feedback queued — will be applied when the current iteration finishes.`,
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

    if (topicSession.mode === "plan") {
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
      fs.mkdirSync(workDir, { recursive: true })

      if (repoUrl) {
        process.stderr.write(`dispatcher: cloning ${repoUrl} into ${workDir}\n`)
        execSync(`git clone --depth=1 ${JSON.stringify(repoUrl)} ${JSON.stringify(workDir)}`, {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120_000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        })
      }

      return workDir
    } catch (err) {
      process.stderr.write(`dispatcher: prepareWorkspace failed: ${err}\n`)
      return null
    }
  }

  activeSessions(): number {
    return this.sessions.size
  }
}

function parseTaskArgs(args: string): { repoUrl?: string; task: string } {
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

function buildRepoKeyboard(
  repoKeys: string[],
  prefix: "repo" | "plan" = "repo",
): { text: string; callback_data: string }[][] {
  const dataPrefix = prefix === "plan" ? "plan-repo" : "repo"
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

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function extractRepoName(url: string): string {
  try {
    const parts = url.replace(/\.git$/, "").split("/")
    return parts[parts.length - 1] ?? "repo"
  } catch {
    return "repo"
  }
}

function appendImageContext(task: string, imagePaths: string[]): string {
  if (imagePaths.length === 0) return task

  const imageRefs = imagePaths.map((p) => `- \`${p}\``).join("\n")
  return `${task}\n\n## Attached images\n\nThe user attached the following image(s). Read them with your file-reading tool to view their contents:\n${imageRefs}`
}

function buildContextPrompt(topicSession: TopicSession): string {
  const isPlan = topicSession.mode === "plan"
  const header = isPlan
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
  if (isPlan) {
    lines.push("Refine the plan based on the latest feedback. Present the updated plan clearly.")
  } else {
    lines.push("The workspace still has your previous changes (branch, commits, PR).")
    lines.push("Address the user's latest feedback. Push updates to the existing branch.")
  }

  return lines.join("\n")
}

function buildExecutionPrompt(topicSession: TopicSession): string {
  const planMessages = topicSession.conversation
    .filter((m) => m.role === "assistant")
  const lastPlan = planMessages.length > 0
    ? planMessages[planMessages.length - 1].text
    : ""

  const originalRequest = topicSession.conversation[0]?.text ?? ""

  const lines: string[] = [
    "## Task",
    "",
    originalRequest,
    "",
    "## Implementation plan",
    "",
    lastPlan,
    "",
    "---",
    "Implement the plan above. Follow the plan closely.",
  ]

  return lines.join("\n")
}
