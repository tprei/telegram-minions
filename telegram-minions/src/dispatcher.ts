import { execSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import crypto from "node:crypto"
import type { TelegramClient } from "./telegram.js"
import { SessionHandle } from "./session.js"
import { Observer } from "./observer.js"
import type { TelegramUpdate, SessionMeta } from "./types.js"
import { generateSlug } from "./slugs.js"
import { config } from "./config.js"

const POLL_TIMEOUT = 30
const TASK_PREFIX = "/task"

interface ActiveSession {
  handle: SessionHandle
  meta: SessionMeta
}

export class Dispatcher {
  private readonly sessions = new Map<number, ActiveSession>()
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
          `Usage: <code>/task https://github.com/org/repo description of the task</code>\n` +
          `Or: <code>/task description of the task</code> (no repo cloning)`,
          replyThreadId,
        )
      }
      return
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

  return { task: args.trim() }
}

function extractRepoName(url: string): string {
  try {
    const parts = url.replace(/\.git$/, "").split("/")
    return parts[parts.length - 1] ?? "repo"
  } catch {
    return "repo"
  }
}
