import { execSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import crypto from "node:crypto"
import type { TelegramClient } from "./telegram.js"
import { SessionHandle } from "./session.js"
import { Observer } from "./observer.js"
import type { TelegramUpdate, TelegramCallbackQuery, SessionMeta } from "./types.js"
import { generateSlug } from "./slugs.js"
import { config } from "./config.js"

const POLL_TIMEOUT = 30
const TASK_PREFIX = "/task"

interface ActiveSession {
  handle: SessionHandle
  meta: SessionMeta
}

interface PendingTask {
  task: string
  threadId?: number
}

export class Dispatcher {
  private readonly sessions = new Map<number, ActiveSession>()
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

    const text = message.text?.trim()
    if (!text) return

    if (text.startsWith(TASK_PREFIX)) {
      await this.handleTaskCommand(text.slice(TASK_PREFIX.length).trim(), message.message_thread_id)
      return
    }

    if (message.message_thread_id !== undefined) {
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
    if (!data?.startsWith("repo:")) {
      await this.telegram.answerCallbackQuery(query.id)
      return
    }

    const repoSlug = data.slice("repo:".length)
    const repoUrl = config.repos[repoSlug]
    if (!repoUrl) {
      await this.telegram.answerCallbackQuery(query.id, "Unknown repo")
      return
    }

    const messageId = query.message?.message_id
    const threadId = query.message?.message_thread_id

    if (messageId) {
      const pending = this.pendingTasks.get(messageId)
      if (pending) {
        this.pendingTasks.delete(messageId)
        await this.telegram.answerCallbackQuery(query.id, `Selected: ${repoSlug}`)
        await this.telegram.deleteMessage(messageId)
        await this.handleTaskCommand(`${repoUrl} ${pending.task}`, threadId)
        return
      }
    }

    await this.telegram.answerCallbackQuery(query.id)
  }

  private async handleTaskCommand(args: string, replyThreadId?: number): Promise<void> {
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

    const meta: SessionMeta = {
      sessionId,
      threadId,
      topicName: slug,
      repo,
      cwd,
      startedAt: Date.now(),
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

    this.sessions.set(threadId, { handle, meta })

    await this.observer.onSessionStart(meta, task)
    handle.start(task)
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

function buildRepoKeyboard(repoKeys: string[]): { text: string; callback_data: string }[][] {
  const rows: { text: string; callback_data: string }[][] = []
  for (let i = 0; i < repoKeys.length; i += 2) {
    const row = [{ text: repoKeys[i], callback_data: `repo:${repoKeys[i]}` }]
    if (i + 1 < repoKeys.length) {
      row.push({ text: repoKeys[i + 1], callback_data: `repo:${repoKeys[i + 1]}` })
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
