import { execSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import crypto from "node:crypto"
import type { TelegramClient } from "./telegram.js"
import { SessionHandle } from "./session.js"
import { Observer } from "./observer.js"
import type { TelegramUpdate, TelegramCallbackQuery, TelegramPhotoSize, SessionMeta, PlanSession } from "./types.js"
import { generateSlug } from "./slugs.js"
import { config } from "./config.js"
import {
  formatPlanStart,
  formatPlanIteration,
  formatPlanExecuting,
  formatPlanComplete,
  formatStatus,
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
  private readonly planSessions = new Map<number, PlanSession>()
  private readonly pendingTasks = new Map<number, PendingTask>()
  private offset = 0
  private running = false

  constructor(
    private readonly telegram: TelegramClient,
    private readonly observer: Observer,
  ) {}

  async start(): Promise<void> {
    this.running = true
    process.stderr.write("dispatcher: started, polling Telegram\n")

    while (this.running) {
      await this.poll()
    }
  }

  stop(): void {
    this.running = false
    for (const { handle } of this.sessions.values()) {
      handle.interrupt()
    }
    this.planSessions.clear()
    process.stderr.write("dispatcher: stopped\n")
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
      const planSession = this.planSessions.get(message.message_thread_id)
      if (planSession) {
        if (text === EXECUTE_CMD) {
          await this.handleExecuteCommand(planSession)
        } else {
          await this.handlePlanFeedback(planSession, text ?? "", photos)
        }
        return
      }

      const session = this.sessions.get(message.message_thread_id)
      if (session) {
        process.stderr.write(
          `dispatcher: received message in active topic ${message.message_thread_id}, follow-ups not yet supported\n`,
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
          await this.startPlanSession(repoUrl, pending.task)
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
    const planSessionList = [...this.planSessions.values()]
    const msg = formatStatus(taskSessions, planSessionList, config.workspace.maxConcurrentSessions)
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

    const sessionId = crypto.randomUUID()
    const slug = generateSlug(sessionId)
    const repo = repoUrl ? extractRepoName(repoUrl) : "local"
    const topicName = `${repo} · ${slug}`

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
      await this.telegram.sendMessage(
        `❌ Failed to prepare workspace for task.`,
        threadId,
      )
      await this.telegram.deleteForumTopic(threadId)
      return
    }

    const imagePaths = await this.downloadPhotos(photos, cwd)
    const fullTask = appendImageContext(task, imagePaths)

    const meta: SessionMeta = {
      sessionId,
      threadId,
      topicName: slug,
      repo,
      cwd,
      startedAt: Date.now(),
      mode: "task",
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
        this.observer.onSessionComplete(m, state, durationMs).catch((err) => {
          process.stderr.write(`observer: onSessionComplete error: ${err}\n`)
        })
        this.sessions.delete(threadId)
        this.telegram.closeForumTopic(threadId).catch((err) => {
          process.stderr.write(`telegram: closeForumTopic error: ${err}\n`)
        })
      },
      config.workspace.sessionTimeoutMs,
    )

    this.sessions.set(threadId, { handle, meta, task: fullTask })

    await this.observer.onSessionStart(meta, fullTask)
    handle.start(fullTask)
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

    await this.startPlanSession(repoUrl, task, photos)
  }

  private async startPlanSession(repoUrl: string | undefined, task: string, photos?: TelegramPhotoSize[]): Promise<void> {
    const sessionId = crypto.randomUUID()
    const slug = generateSlug(sessionId)
    const repo = repoUrl ? extractRepoName(repoUrl) : "local"
    const topicName = `📋 ${repo} · ${slug}`

    let topic: { message_thread_id: number }
    try {
      topic = await this.telegram.createForumTopic(topicName)
    } catch (err) {
      process.stderr.write(`dispatcher: failed to create plan topic: ${err}\n`)
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

    const planSession: PlanSession = {
      threadId,
      repo,
      repoUrl,
      cwd,
      slug,
      conversation: [{ role: "user", text: fullTask, images: imagePaths.length > 0 ? imagePaths : undefined }],
      pendingFeedback: [],
    }

    this.planSessions.set(threadId, planSession)

    await this.telegram.sendMessage(
      formatPlanStart(repo, slug, task),
      threadId,
    )

    await this.spawnPlanAgent(planSession, fullTask)
  }

  private async spawnPlanAgent(planSession: PlanSession, task: string): Promise<void> {
    if (this.sessions.size >= config.workspace.maxConcurrentSessions) {
      await this.telegram.sendMessage(
        `⚠️ Max concurrent sessions reached. Try again later.`,
        planSession.threadId,
      )
      return
    }

    const sessionId = crypto.randomUUID()
    planSession.activeSessionId = sessionId

    const meta: SessionMeta = {
      sessionId,
      threadId: planSession.threadId,
      topicName: planSession.slug,
      repo: planSession.repo,
      cwd: planSession.cwd,
      startedAt: Date.now(),
      mode: "plan",
    }

    const onTextCapture = (_sid: string, text: string) => {
      planSession.conversation.push({ role: "assistant", text })
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
        this.observer.onSessionComplete(m, state, durationMs).catch((err) => {
          process.stderr.write(`observer: onSessionComplete error: ${err}\n`)
        })
        this.sessions.delete(planSession.threadId)
        planSession.activeSessionId = undefined

        // After plan agent completes, send guidance and process queued feedback
        this.telegram.sendMessage(
          formatPlanComplete(planSession.slug),
          planSession.threadId,
        ).catch(() => {})

        if (planSession.pendingFeedback.length > 0) {
          const feedback = planSession.pendingFeedback.join("\n\n")
          planSession.pendingFeedback = []
          this.handlePlanFeedback(planSession, feedback).catch((err) => {
            process.stderr.write(`dispatcher: queued feedback error: ${err}\n`)
          })
        }
      },
      config.workspace.sessionTimeoutMs,
    )

    this.sessions.set(planSession.threadId, { handle, meta, task })

    await this.observer.onSessionStart(meta, task, onTextCapture)
    handle.start(task)
  }

  private async handlePlanFeedback(planSession: PlanSession, feedback: string, photos?: TelegramPhotoSize[]): Promise<void> {
    // If the plan agent is still running, queue the feedback
    if (planSession.activeSessionId) {
      planSession.pendingFeedback.push(feedback)
      await this.telegram.sendMessage(
        `📝 Feedback queued — will be applied when the current iteration finishes.`,
        planSession.threadId,
      )
      return
    }

    const imagePaths = await this.downloadPhotos(photos, planSession.cwd)
    const fullFeedback = appendImageContext(feedback, imagePaths)

    planSession.conversation.push({
      role: "user",
      text: fullFeedback,
      images: imagePaths.length > 0 ? imagePaths : undefined,
    })

    const iteration = Math.floor(planSession.conversation.filter((m) => m.role === "user").length)

    await this.telegram.sendMessage(
      formatPlanIteration(planSession.slug, iteration),
      planSession.threadId,
    )

    const contextTask = buildPlanContextPrompt(planSession)
    await this.spawnPlanAgent(planSession, contextTask)
  }

  private async handleExecuteCommand(planSession: PlanSession): Promise<void> {
    // If agent is still running, interrupt it first
    if (planSession.activeSessionId) {
      const activeSession = this.sessions.get(planSession.threadId)
      if (activeSession) {
        activeSession.handle.interrupt()
      }
    }

    const plan = buildExecutionPrompt(planSession)

    await this.telegram.sendMessage(
      formatPlanExecuting(planSession.slug, "starting…"),
      planSession.threadId,
    )

    await this.telegram.closeForumTopic(planSession.threadId)
    this.planSessions.delete(planSession.threadId)

    // Spawn execution as a regular /task with the accumulated plan
    await this.handleTaskCommand(
      planSession.repoUrl ? `${planSession.repoUrl} ${plan}` : plan,
      undefined,
    )
  }

  private async downloadPhotos(photos: TelegramPhotoSize[] | undefined, cwd: string): Promise<string[]> {
    if (!photos || photos.length === 0) return []

    const imagesDir = path.join(cwd, ".minion-images")
    fs.mkdirSync(imagesDir, { recursive: true })

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

function buildPlanContextPrompt(planSession: PlanSession): string {
  const lines: string[] = [
    "## Planning context",
    "",
    "You are continuing a planning conversation. Here is the history:",
    "",
  ]

  for (const msg of planSession.conversation) {
    const label = msg.role === "user" ? "**User**" : "**Agent**"
    lines.push(`${label}:`)
    lines.push(msg.text)
    lines.push("")
  }

  lines.push("---")
  lines.push("Refine the plan based on the latest feedback. Present the updated plan clearly.")

  return lines.join("\n")
}

function buildExecutionPrompt(planSession: PlanSession): string {
  const planMessages = planSession.conversation
    .filter((m) => m.role === "assistant")
  const lastPlan = planMessages.length > 0
    ? planMessages[planMessages.length - 1].text
    : ""

  const originalRequest = planSession.conversation[0]?.text ?? ""

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
