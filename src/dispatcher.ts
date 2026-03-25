import { execSync, execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import crypto from "node:crypto"
import type { TelegramClient } from "./telegram.js"
import { captureException } from "./sentry.js"
import { SessionHandle, type SessionConfig } from "./session.js"
import { Observer } from "./observer.js"
import type { TelegramUpdate, TelegramCallbackQuery, TelegramPhotoSize, SessionMeta, TopicSession } from "./types.js"
import { generateSlug } from "./slugs.js"
import type { MinionConfig } from "./config-types.js"
import { DEFAULT_PROMPTS } from "./prompts.js"
import { SessionStore } from "./store.js"
import { ProfileStore } from "./profile-store.js"
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
  formatQualityReportForContext,
  formatBudgetWarning,
  formatStats,
  formatCIWatching,
  formatCIFailed,
  formatCIFixing,
  formatCIPassed,
  formatCIGaveUp,
  formatProfileList,
  formatConfigHelp,
} from "./format.js"
import { runQualityGates, type QualityReport } from "./quality-gates.js"
import { StatsTracker } from "./stats.js"
import { writeSessionLog } from "./session-log.js"
import { extractPRUrl, waitForCI, getFailedCheckLogs, buildCIFixPrompt, buildQualityGateFixPrompt } from "./ci-babysit.js"
import { DEFAULT_CI_FIX_PROMPT } from "./prompts.js"

const POLL_TIMEOUT = 30
const TASK_PREFIX = "/task"
const TASK_SHORT = "/w"
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
const CONFIG_CMD = "/config"

interface ActiveSession {
  handle: SessionHandle
  meta: SessionMeta
  task: string
}

interface PendingTask {
  task: string
  threadId?: number
  repoSlug?: string
  repoUrl?: string
  mode: "task" | "plan" | "think"
}

export class Dispatcher {
  private readonly sessions = new Map<number, ActiveSession>()
  private readonly topicSessions = new Map<number, TopicSession>()
  private readonly pendingTasks = new Map<number, PendingTask>()
  private readonly pendingProfiles = new Map<number, PendingTask>()
  private readonly store: SessionStore
  private readonly profileStore: ProfileStore
  private offset = 0
  private running = false
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  private readonly stats: StatsTracker

  constructor(
    private readonly telegram: TelegramClient,
    private readonly observer: Observer,
    private readonly config: MinionConfig,
  ) {
    this.store = new SessionStore(this.config.workspace.root)
    this.profileStore = new ProfileStore(this.config.workspace.root)
    this.stats = new StatsTracker(this.config.workspace.root)
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
        await this.removeWorkspace(session)
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
    }, this.config.workspace.cleanupIntervalMs)
    process.stderr.write(
      `dispatcher: cleanup timer started (interval=${Math.round(this.config.workspace.cleanupIntervalMs / 60000)}m, ttl=${Math.round(this.config.workspace.staleTtlMs / 86400000)}d)\n`,
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
      if (now - session.lastActivityAt > this.config.workspace.staleTtlMs) {
        stale.push([threadId, session])
      }
    }

    if (stale.length === 0) return

    process.stderr.write(`dispatcher: cleaning up ${stale.length} stale session(s)\n`)

    for (const [threadId, session] of stale) {
      await this.telegram.deleteForumTopic(threadId)
      await this.removeWorkspace(session)
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
        captureException(err, { updateId: update.update_id })
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

    if (message.chat.id.toString() !== this.config.telegram.chatId) return

    const userId = message.from?.id ?? -1
    if (!this.config.telegram.allowedUserIds.includes(userId)) return

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
      if (text === CONFIG_CMD || text?.startsWith(CONFIG_CMD + " ")) {
        await this.handleConfigCommand(text.slice(CONFIG_CMD.length).trim())
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

    if (text?.startsWith(TASK_PREFIX) || text?.startsWith(TASK_SHORT + " ") || text === TASK_SHORT) {
      const body = text.startsWith(TASK_PREFIX)
        ? text.slice(TASK_PREFIX.length).trim()
        : text.slice(TASK_SHORT.length).trim()
      await this.handleTaskCommand(body, message.message_thread_id, photos)
      return
    }

    if (message.message_thread_id !== undefined) {
      const topicSession = this.topicSessions.get(message.message_thread_id)
      if (topicSession) {
        if (text === CLOSE_CMD) {
          await this.handleCloseCommand(topicSession)
        } else if ((topicSession.mode === "plan" || topicSession.mode === "think") && (text === EXECUTE_CMD || text?.startsWith(EXECUTE_CMD + " "))) {
          const directive = text!.slice(EXECUTE_CMD.length).trim() || undefined
          await this.handleExecuteCommand(topicSession, directive)
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
    if (!this.config.telegram.allowedUserIds.includes(query.from.id)) {
      await this.telegram.answerCallbackQuery(query.id, "Not authorized")
      return
    }

    const data = query.data
    if (!data) {
      await this.telegram.answerCallbackQuery(query.id)
      return
    }

    if (data.startsWith("profile:")) {
      await this.handleProfileCallback(query, data.slice("profile:".length))
      return
    }

    if (!data.startsWith("repo:") && !data.startsWith("plan-repo:") && !data.startsWith("think-repo:")) {
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
    const repoUrl = this.config.repos[repoSlug]
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

        pending.repoSlug = repoSlug
        pending.repoUrl = repoUrl

        const defaultProfileId = this.profileStore.getDefaultId()
        if (defaultProfileId) {
          await this.startTopicSessionWithProfile(repoUrl, pending.task, pending.mode, defaultProfileId)
        } else {
          const profiles = this.profileStore.list()
          if (profiles.length > 1) {
            const keyboard = buildProfileKeyboard(profiles)
            const msgId = await this.telegram.sendMessageWithKeyboard(
              `Pick a profile for: <i>${escapeHtml(pending.task)}</i>`,
              keyboard,
              pending.threadId,
            )
            if (msgId) {
              this.pendingProfiles.set(msgId, pending)
            }
          } else {
            await this.startTopicSessionWithProfile(repoUrl, pending.task, pending.mode, undefined)
          }
        }
        return
      }
    }

    await this.telegram.answerCallbackQuery(query.id)
  }

  private async handleProfileCallback(query: TelegramCallbackQuery, profileId: string): Promise<void> {
    const profile = this.profileStore.get(profileId)
    if (!profile) {
      await this.telegram.answerCallbackQuery(query.id, "Unknown profile")
      return
    }

    const messageId = query.message?.message_id
    if (messageId) {
      const pending = this.pendingProfiles.get(messageId)
      if (pending) {
        this.pendingProfiles.delete(messageId)
        await this.telegram.answerCallbackQuery(query.id, `Selected: ${profile.name}`)
        await this.telegram.deleteMessage(messageId)
        await this.startTopicSessionWithProfile(pending.repoUrl, pending.task, pending.mode, profileId)
        return
      }
    }

    await this.telegram.answerCallbackQuery(query.id)
  }

  private async handleStatusCommand(): Promise<void> {
    const taskSessions = [...this.sessions.values()]
    const topicSessionList = [...this.topicSessions.values()]
    const msg = formatStatus(taskSessions, topicSessionList, this.config.workspace.maxConcurrentSessions)
    await this.telegram.sendMessage(msg)
  }

  private async handleStatsCommand(): Promise<void> {
    const agg = this.stats.aggregate(7)
    await this.telegram.sendMessage(formatStats(agg))
  }

  private async handleHelpCommand(): Promise<void> {
    await this.telegram.sendMessage(formatHelp())
  }

  private async handleConfigCommand(args: string): Promise<void> {
    if (!args) {
      const profiles = this.profileStore.list()
      const defaultId = this.profileStore.getDefaultId()
      await this.telegram.sendMessage(formatProfileList(profiles, defaultId))
      return
    }

    const parts = args.split(/\s+/)
    const subcommand = parts[0]

    if (subcommand === "add" && parts.length >= 3) {
      const id = parts[1]
      const name = parts.slice(2).join(" ")
      const added = this.profileStore.add({ id, name })
      if (added) {
        await this.telegram.sendMessage(`✅ Added profile <code>${escapeHtml(id)}</code>`)
      } else {
        await this.telegram.sendMessage(`❌ Profile <code>${escapeHtml(id)}</code> already exists`)
      }
      return
    }

    if (subcommand === "set" && parts.length >= 4) {
      const id = parts[1]
      const field = parts[2]
      const value = parts.slice(3).join(" ")
      const validFields = ["name", "baseUrl", "authToken", "opusModel", "sonnetModel", "haikuModel"]
      if (!validFields.includes(field)) {
        await this.telegram.sendMessage(`❌ Invalid field. Valid: ${validFields.join(", ")}`)
        return
      }
      const updated = this.profileStore.update(id, { [field]: value })
      if (updated) {
        await this.telegram.sendMessage(`✅ Updated <code>${escapeHtml(id)}.${escapeHtml(field)}</code>`)
      } else {
        await this.telegram.sendMessage(`❌ Profile <code>${escapeHtml(id)}</code> not found`)
      }
      return
    }

    if (subcommand === "remove" && parts.length >= 2) {
      const id = parts[1]
      const removed = this.profileStore.remove(id)
      if (removed) {
        await this.telegram.sendMessage(`✅ Removed profile <code>${escapeHtml(id)}</code>`)
      } else {
        await this.telegram.sendMessage(`❌ Cannot remove <code>${escapeHtml(id)}</code> (not found or is default)`)
      }
      return
    }

    if (subcommand === "default") {
      if (parts.length === 1) {
        // /config default - clear the default
        this.profileStore.clearDefault()
        await this.telegram.sendMessage(`✅ Cleared default profile`)
        return
      }
      const id = parts[1]
      if (id === "clear") {
        this.profileStore.clearDefault()
        await this.telegram.sendMessage(`✅ Cleared default profile`)
        return
      }
      const set = this.profileStore.setDefaultId(id)
      if (set) {
        const profile = this.profileStore.get(id)
        await this.telegram.sendMessage(`✅ Default profile set to <code>${escapeHtml(id)}</code> (${escapeHtml(profile?.name ?? id)})`)
      } else {
        await this.telegram.sendMessage(`❌ Profile <code>${escapeHtml(id)}</code> not found`)
      }
      return
    }

    await this.telegram.sendMessage(formatConfigHelp())
  }

  private async handleCleanCommand(): Promise<void> {
    const root = this.config.workspace.root
    let freedBytes = 0
    let removedSessions = 0
    let removedOrphans = 0
    let removedRepos = 0

    const idle: [number, TopicSession][] = []
    for (const [threadId, session] of this.topicSessions) {
      if (!session.activeSessionId) {
        idle.push([threadId, session])
      }
    }

    for (const [threadId, session] of idle) {
      if (session.cwd && fs.existsSync(session.cwd)) {
        freedBytes += dirSizeBytes(session.cwd)
      }
      await this.telegram.deleteForumTopic(threadId)
      await this.removeWorkspace(session)
      this.topicSessions.delete(threadId)
      removedSessions++
    }

    const activeCwds = new Set<string>()
    for (const session of this.topicSessions.values()) {
      if (session.cwd) activeCwds.add(session.cwd)
    }

    const parentHome = process.env["HOME"] ?? ""
    const entries = fs.readdirSync(root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith(".")) continue
      const entryPath = path.join(root, entry.name)
      if (entryPath === parentHome) continue
      if (activeCwds.has(entryPath)) continue
      if (this.sessions.has(Number(entry.name))) continue

      freedBytes += dirSizeBytes(entryPath)
      try {
        fs.rmSync(entryPath, { recursive: true, force: true })
        removedOrphans++
        process.stderr.write(`dispatcher: removed orphan workspace ${entryPath}\n`)
      } catch (err) {
        process.stderr.write(`dispatcher: failed to remove orphan ${entryPath}: ${err}\n`)
      }
    }

    const activeRepos = new Set<string>()
    for (const session of this.topicSessions.values()) {
      if (session.repoUrl) {
        activeRepos.add(extractRepoName(session.repoUrl))
      }
    }

    const reposDir = path.join(root, ".repos")
    if (fs.existsSync(reposDir)) {
      const repos = fs.readdirSync(reposDir, { withFileTypes: true })
      for (const repo of repos) {
        if (!repo.isDirectory()) continue
        const repoName = repo.name.replace(/\.git$/, "")
        if (activeRepos.has(repoName)) continue
        const repoPath = path.join(reposDir, repo.name)
        freedBytes += dirSizeBytes(repoPath)
        try {
          fs.rmSync(repoPath, { recursive: true, force: true })
          removedRepos++
          process.stderr.write(`dispatcher: removed bare repo ${repoPath}\n`)
        } catch (err) {
          process.stderr.write(`dispatcher: failed to remove bare repo ${repoPath}: ${err}\n`)
        }
      }
    }

    this.persistTopicSessions()

    const totalItems = removedSessions + removedOrphans + removedRepos
    if (totalItems === 0) {
      await this.telegram.sendMessage("🧹 Nothing to clean up — disk is tidy.")
      return
    }

    const parts: string[] = []
    if (removedSessions > 0) parts.push(`${removedSessions} idle session(s)`)
    if (removedOrphans > 0) parts.push(`${removedOrphans} orphaned workspace(s)`)
    if (removedRepos > 0) parts.push(`${removedRepos} cached repo(s)`)

    const freedMB = (freedBytes / (1024 * 1024)).toFixed(1)
    await this.telegram.sendMessage(`🧹 Cleaned ${parts.join(", ")} — freed ~${freedMB} MB.`)
  }

  private async handleTaskCommand(args: string, replyThreadId?: number, photos?: TelegramPhotoSize[]): Promise<void> {
    if (this.sessions.size >= this.config.workspace.maxConcurrentSessions) {
      if (replyThreadId !== undefined) {
        await this.telegram.sendMessage(
          `⚠️ Max concurrent sessions (${this.config.workspace.maxConcurrentSessions}) reached. Wait for one to finish.`,
          replyThreadId,
        )
      }
      return
    }

    const { repoUrl, task } = parseTaskArgs(this.config.repos, args)

    if (!task) {
      if (replyThreadId !== undefined) {
        await this.telegram.sendMessage(
          `Usage: <code>/task [repo] description of the task</code> (alias: <code>/w</code>)\n` +
          `Repos: ${Object.keys(this.config.repos).map((s) => `<code>${s}</code>`).join(", ")}\n` +
          `Or use a full URL or omit repo entirely.`,
          replyThreadId,
        )
      }
      return
    }

    if (!repoUrl) {
      const repoKeys = Object.keys(this.config.repos)
      if (repoKeys.length > 0) {
        const keyboard = buildRepoKeyboard(repoKeys)
        const msgId = await this.telegram.sendMessageWithKeyboard(
          `Pick a repo for: <i>${escapeHtml(task)}</i>`,
          keyboard,
          replyThreadId,
        )
        if (msgId) {
          this.pendingTasks.set(msgId, { task, threadId: replyThreadId, mode: "task" })
        }
        return
      }
    }

    const defaultProfileId = this.profileStore.getDefaultId()
    if (defaultProfileId) {
      await this.startTopicSession(repoUrl, task, "task", photos, defaultProfileId)
      return
    }

    const profiles = this.profileStore.list()
    if (profiles.length > 1) {
      const keyboard = buildProfileKeyboard(profiles)
      const msgId = await this.telegram.sendMessageWithKeyboard(
        `Pick a profile for: <i>${escapeHtml(task)}</i>`,
        keyboard,
        replyThreadId,
      )
      if (msgId) {
        this.pendingProfiles.set(msgId, { task, threadId: replyThreadId, repoUrl, mode: "task" })
      }
      return
    }

    await this.startTopicSession(repoUrl, task, "task", photos)
  }

  private async handlePlanCommand(args: string, replyThreadId?: number, photos?: TelegramPhotoSize[]): Promise<void> {
    const { repoUrl, task } = parseTaskArgs(this.config.repos, args)

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
      const repoKeys = Object.keys(this.config.repos)
      if (repoKeys.length > 0) {
        const keyboard = buildRepoKeyboard(repoKeys, "plan")
        const msgId = await this.telegram.sendMessageWithKeyboard(
          `Pick a repo for plan: <i>${escapeHtml(task)}</i>`,
          keyboard,
          replyThreadId,
        )
        if (msgId) {
          this.pendingTasks.set(msgId, { task, threadId: replyThreadId, mode: "plan" })
        }
        return
      }
    }

    const defaultProfileId = this.profileStore.getDefaultId()
    if (defaultProfileId) {
      await this.startTopicSession(repoUrl, task, "plan", photos, defaultProfileId)
      return
    }

    const profiles = this.profileStore.list()
    if (profiles.length > 1) {
      const keyboard = buildProfileKeyboard(profiles)
      const msgId = await this.telegram.sendMessageWithKeyboard(
        `Pick a profile for plan: <i>${escapeHtml(task)}</i>`,
        keyboard,
        replyThreadId,
      )
      if (msgId) {
        this.pendingProfiles.set(msgId, { task, threadId: replyThreadId, repoUrl, mode: "plan" })
      }
      return
    }

    await this.startTopicSession(repoUrl, task, "plan", photos)
  }

  private async handleThinkCommand(args: string, replyThreadId?: number, photos?: TelegramPhotoSize[]): Promise<void> {
    const { repoUrl, task } = parseTaskArgs(this.config.repos, args)

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
      const repoKeys = Object.keys(this.config.repos)
      if (repoKeys.length > 0) {
        const keyboard = buildRepoKeyboard(repoKeys, "think")
        const msgId = await this.telegram.sendMessageWithKeyboard(
          `Pick a repo for research: <i>${escapeHtml(task)}</i>`,
          keyboard,
          replyThreadId,
        )
        if (msgId) {
          this.pendingTasks.set(msgId, { task, threadId: replyThreadId, mode: "think" })
        }
        return
      }
    }

    const defaultProfileId = this.profileStore.getDefaultId()
    if (defaultProfileId) {
      await this.startTopicSession(repoUrl, task, "think", photos, defaultProfileId)
      return
    }

    const profiles = this.profileStore.list()
    if (profiles.length > 1) {
      const keyboard = buildProfileKeyboard(profiles)
      const msgId = await this.telegram.sendMessageWithKeyboard(
        `Pick a profile for research: <i>${escapeHtml(task)}</i>`,
        keyboard,
        replyThreadId,
      )
      if (msgId) {
        this.pendingProfiles.set(msgId, { task, threadId: replyThreadId, repoUrl, mode: "think" })
      }
      return
    }

    await this.startTopicSession(repoUrl, task, "think", photos)
  }

  private async startTopicSession(
    repoUrl: string | undefined,
    task: string,
    mode: "task" | "plan" | "think",
    photos?: TelegramPhotoSize[],
    profileId?: string,
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
      captureException(err, { operation: "createForumTopic" })
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
      profileId,
    }

    this.topicSessions.set(threadId, topicSession)

    await this.spawnTopicAgent(topicSession, fullTask)
  }

  private async startTopicSessionWithProfile(
    repoUrl: string | undefined,
    task: string,
    mode: "task" | "plan" | "think",
    profileId?: string,
  ): Promise<void> {
    return this.startTopicSession(repoUrl, task, mode, undefined, profileId)
  }

  private async updateTopicTitle(topicSession: TopicSession, stateEmoji: string): Promise<void> {
    const name = `${stateEmoji} ${topicSession.repo} · ${topicSession.slug}`
    await this.telegram.editForumTopic(topicSession.threadId, name).catch(() => {})
  }

  private async spawnTopicAgent(topicSession: TopicSession, task: string): Promise<void> {
    if (this.sessions.size >= this.config.workspace.maxConcurrentSessions) {
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

    const prompts = { ...DEFAULT_PROMPTS, ...this.config.prompts }
    const profile = topicSession.profileId ? this.profileStore.get(topicSession.profileId) : undefined
    const sessionConfig: SessionConfig = {
      goose: this.config.goose,
      claude: this.config.claude,
      mcp: this.config.mcp,
      profile,
      sessionEnvPassthrough: this.config.sessionEnvPassthrough,
    }

    const handle = new SessionHandle(
      meta,
      (event) => {
        this.observer.onEvent(meta, event).catch((err) => {
          process.stderr.write(`observer: onEvent error: ${err}\n`)
        })

        if (event.type === "complete" && meta.totalTokens != null && meta.totalTokens > this.config.workspace.sessionTokenBudget) {
          process.stderr.write(
            `dispatcher: session ${sessionId} exceeded token budget (${meta.totalTokens} > ${this.config.workspace.sessionTokenBudget})\n`,
          )
          this.telegram.sendMessage(
            formatBudgetWarning(topicSession.slug, meta.totalTokens, this.config.workspace.sessionTokenBudget),
            topicSession.threadId,
          ).catch(() => {})
          handle.interrupt()
        }
      },
      (m, state) => {
        if (topicSession.activeSessionId !== m.sessionId) return

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
          this.updateTopicTitle(topicSession, "💬").catch(() => {})
          this.observer.onSessionComplete(m, state, durationMs).catch((err) => {
            process.stderr.write(`observer: onSessionComplete error: ${err}\n`)
          })
          this.telegram.sendMessage(
            formatThinkComplete(topicSession.slug),
            topicSession.threadId,
          ).catch(() => {})
          writeSessionLog(topicSession, m, state, durationMs)
        } else if (topicSession.mode === "plan") {
          this.updateTopicTitle(topicSession, "💬").catch(() => {})
          this.observer.onSessionComplete(m, state, durationMs).catch((err) => {
            process.stderr.write(`observer: onSessionComplete error: ${err}\n`)
          })
          this.telegram.sendMessage(
            formatPlanComplete(topicSession.slug),
            topicSession.threadId,
          ).catch(() => {})
          writeSessionLog(topicSession, m, state, durationMs)
        } else if (state === "errored") {
          this.updateTopicTitle(topicSession, "❌").catch(() => {})
          this.observer.onSessionComplete(m, state, durationMs).catch((err) => {
            process.stderr.write(`observer: onSessionComplete error: ${err}\n`)
          })
          writeSessionLog(topicSession, m, state, durationMs)
        } else {
          this.updateTopicTitle(topicSession, "✅").catch(() => {})
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
              if (qualityReport && !qualityReport.allPassed) {
                topicSession.conversation.push({
                  role: "user",
                  text: formatQualityReportForContext(qualityReport.results),
                })
              }
            } catch (err) {
              process.stderr.write(`dispatcher: quality gates error: ${err}\n`)
              captureException(err, { operation: "qualityGates" })
            }

            writeSessionLog(topicSession, m, state, durationMs, qualityReport)

            if (this.config.ci.babysitEnabled && topicSession.mode === "task") {
              const prUrl = this.extractPRFromConversation(topicSession)
              if (prUrl) {
                this.babysitPR(topicSession, prUrl, qualityReport).catch((err) => {
                  process.stderr.write(`dispatcher: babysitPR error: ${err}\n`)
                  captureException(err, { operation: "babysitPR", prUrl })
                })
              }
            }
          }).catch((err) => {
            process.stderr.write(`observer: flushAndComplete error: ${err}\n`)
          })
        }

        this.persistTopicSessions()
        this.cleanBuildArtifacts(topicSession.cwd)

        if (topicSession.pendingFeedback.length > 0) {
          const feedback = topicSession.pendingFeedback.join("\n\n")
          topicSession.pendingFeedback = []
          this.handleTopicFeedback(topicSession, feedback).catch((err) => {
            process.stderr.write(`dispatcher: queued feedback error: ${err}\n`)
          })
        }
      },
      this.config.workspace.sessionTimeoutMs,
      sessionConfig,
    )

    this.sessions.set(topicSession.threadId, { handle, meta, task })

    await this.updateTopicTitle(topicSession, "⚡")
    await this.observer.onSessionStart(meta, task, onTextCapture)
    handle.start(task, topicSession.mode === "task" ? prompts.task : undefined)
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

  private async babysitPR(topicSession: TopicSession, prUrl: string, initialQualityReport?: QualityReport): Promise<void> {
    const maxRetries = this.config.ci.maxRetries
    let localReport: QualityReport | undefined = initialQualityReport && !initialQualityReport.allPassed
      ? initialQualityReport
      : undefined

    await this.telegram.sendMessage(
      formatCIWatching(topicSession.slug, prUrl),
      topicSession.threadId,
    )

    process.stderr.write(`dispatcher: watching CI for PR ${prUrl} (max ${maxRetries} retries)\n`)

    const result = await waitForCI(prUrl, topicSession.cwd, this.config.ci)

    if (result.passed && localReport == null) {
      await this.telegram.sendMessage(
        formatCIPassed(topicSession.slug, prUrl),
        topicSession.threadId,
      )
      process.stderr.write(`dispatcher: CI passed for PR ${prUrl}\n`)
      return
    }

    if (result.timedOut && result.checks.length === 0 && localReport == null) {
      process.stderr.write(`dispatcher: no CI checks found for PR ${prUrl}, skipping babysit\n`)
      return
    }

    const failedChecks = result.checks.filter((c) => c.bucket === "fail")
    const hasRemoteFailures = failedChecks.length > 0

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const failedGateNames = localReport != null
        ? localReport.results.filter((r) => !r.passed).map((r) => r.gate)
        : []
      const allFailedNames = [
        ...failedChecks.map((c) => c.name),
        ...failedGateNames.map((g) => `local:${g}`),
      ]

      await this.telegram.sendMessage(
        formatCIFailed(topicSession.slug, allFailedNames, attempt, maxRetries),
        topicSession.threadId,
      )

      let fixPrompt: string
      if (hasRemoteFailures) {
        const failureDetails = getFailedCheckLogs(prUrl, topicSession.cwd)
        fixPrompt = buildCIFixPrompt(prUrl, failedChecks, failureDetails, attempt, maxRetries)
        if (localReport != null) {
          fixPrompt += "\n\n" + buildQualityGateFixPrompt(prUrl, localReport, attempt, maxRetries)
        }
      } else {
        fixPrompt = buildQualityGateFixPrompt(prUrl, localReport!, attempt, maxRetries)
      }

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

      // Re-run local quality gates after fix attempt
      let localFixed = true
      if (localReport != null) {
        try {
          localReport = runQualityGates(topicSession.cwd)
          localFixed = localReport.allPassed
          if (!localFixed) {
            process.stderr.write(`dispatcher: local quality gates still failing after fix attempt ${attempt}\n`)
          } else {
            localReport = undefined
          }
        } catch (err) {
          process.stderr.write(`dispatcher: quality gates re-check error: ${err}\n`)
        }
      }

      const recheck = await waitForCI(prUrl, topicSession.cwd, this.config.ci)

      if (recheck.passed && localFixed) {
        await this.telegram.sendMessage(
          formatCIPassed(topicSession.slug, prUrl),
          topicSession.threadId,
        )
        process.stderr.write(`dispatcher: CI passed after fix attempt ${attempt}\n`)
        topicSession.mode = "task"
        return
      }

      const newFailed = recheck.checks.filter((c) => c.bucket === "fail")
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
    if (this.sessions.size >= this.config.workspace.maxConcurrentSessions) {
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

    const sessionConfig: SessionConfig = {
      goose: this.config.goose,
      claude: this.config.claude,
      mcp: this.config.mcp,
      sessionEnvPassthrough: this.config.sessionEnvPassthrough,
    }

    const handle = new SessionHandle(
      meta,
      (event) => {
        this.observer.onEvent(meta, event).catch((err) => {
          process.stderr.write(`observer: CI fix onEvent error: ${err}\n`)
        })
      },
      (m, state) => {
        if (topicSession.activeSessionId !== m.sessionId) return

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
      this.config.workspace.sessionTimeoutMs,
      sessionConfig,
    )

    this.sessions.set(topicSession.threadId, { handle, meta, task })

    await this.observer.onSessionStart(meta, task)
    handle.start(task, DEFAULT_CI_FIX_PROMPT)
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

  private async handleExecuteCommand(topicSession: TopicSession, directive?: string): Promise<void> {
    // If agent is still running, kill it and wait for exit before spawning the new session
    if (topicSession.activeSessionId) {
      const activeSession = this.sessions.get(topicSession.threadId)
      if (activeSession) {
        await activeSession.handle.kill()
      }
      this.sessions.delete(topicSession.threadId)
    }

    const executionTask = buildExecutionPrompt(topicSession, directive)

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

    // Remove from tracking and delete the topic first for instant user feedback
    this.topicSessions.delete(threadId)
    this.persistTopicSessions()
    await this.telegram.deleteForumTopic(threadId)
    process.stderr.write(`dispatcher: closed and deleted topic ${topicSession.slug} (thread ${threadId})\n`)

    // Kill process and clean up workspace in background (non-blocking)
    if (topicSession.activeSessionId) {
      const activeSession = this.sessions.get(threadId)
      this.sessions.delete(threadId)
      if (activeSession) {
        activeSession.handle.kill().then(
          () => this.removeWorkspace(topicSession),
          () => this.removeWorkspace(topicSession),
        ).catch((err) => {
          process.stderr.write(`dispatcher: background cleanup failed for ${topicSession.slug}: ${err}\n`)
        })
        return
      }
    }

    this.removeWorkspace(topicSession).catch((err) => {
      process.stderr.write(`dispatcher: background cleanup failed for ${topicSession.slug}: ${err}\n`)
    })
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
    const workDir = path.join(this.config.workspace.root, slug)

    try {
      if (repoUrl) {
        const reposDir = path.join(this.config.workspace.root, ".repos")
        fs.mkdirSync(reposDir, { recursive: true })

        const repoName = extractRepoName(repoUrl)
        const bareDir = path.join(reposDir, `${repoName}.git`)
        const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
        const stdio: import("node:child_process").StdioOptions = ["ignore", "pipe", "pipe"]
        const gitOpts = { stdio, timeout: 120_000, env: gitEnv }

        if (fs.existsSync(bareDir)) {
          process.stderr.write(`dispatcher: fetching ${repoUrl} in ${bareDir}\n`)
          execSync(`git fetch --prune origin`, { ...gitOpts, cwd: bareDir })
          updateLocalHead(bareDir, gitOpts)
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
      captureException(err, { operation: "prepareWorkspace" })
      return null
    }
  }

  private cleanBuildArtifacts(cwd: string): void {
    cleanBuildArtifacts(cwd)
  }

  private async removeWorkspace(topicSession: TopicSession): Promise<void> {
    if (!topicSession.cwd || !fs.existsSync(topicSession.cwd)) return

    try {
      if (topicSession.repoUrl) {
        const repoName = extractRepoName(topicSession.repoUrl)
        const bareDir = path.join(this.config.workspace.root, ".repos", `${repoName}.git`)
        if (fs.existsSync(bareDir)) {
          await execFileAsync(
            "git", ["worktree", "remove", "--force", topicSession.cwd],
            { cwd: bareDir, timeout: 30_000 },
          )
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

export function updateLocalHead(bareDir: string, gitOpts: object): void {
  const defaultBranch = resolveDefaultBranch(bareDir, gitOpts)
  try {
    execSync(
      `git update-ref refs/heads/${defaultBranch} refs/remotes/origin/${defaultBranch}`,
      { ...gitOpts, cwd: bareDir },
    )
  } catch { /* remote ref may not exist yet */ }
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

export function parseTaskArgs(repos: Record<string, string>, args: string): { repoUrl?: string; task: string } {
  const urlPattern = /^(https?:\/\/[^\s]+)\s+([\s\S]+)$/
  const match = urlPattern.exec(args)

  if (match) {
    return { repoUrl: match[1], task: match[2].trim() }
  }

  // Check for repo alias as first word
  const spaceIdx = args.indexOf(" ")
  if (spaceIdx > 0) {
    const firstWord = args.slice(0, spaceIdx)
    const aliasUrl = repos[firstWord]
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

export function buildProfileKeyboard(
  profiles: { id: string; name: string }[],
): { text: string; callback_data: string }[][] {
  const rows: { text: string; callback_data: string }[][] = []
  for (let i = 0; i < profiles.length; i += 2) {
    const row = [{ text: profiles[i].name, callback_data: `profile:${profiles[i].id}` }]
    if (i + 1 < profiles.length) {
      row.push({ text: profiles[i + 1].name, callback_data: `profile:${profiles[i + 1].id}` })
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

export function cleanBuildArtifacts(cwd: string): void {
  const artifacts = ["node_modules", ".next", ".turbo", ".cache", "dist", ".npm"]
  for (const name of artifacts) {
    const target = path.join(cwd, name)
    try {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true })
        process.stderr.write(`dispatcher: cleaned ${name} from ${cwd}\n`)
      }
    } catch (err) {
      process.stderr.write(`dispatcher: failed to clean ${name} from ${cwd}: ${err}\n`)
    }
  }
  const homeCacheDir = path.join(cwd, ".home", ".npm")
  try {
    if (fs.existsSync(homeCacheDir)) {
      fs.rmSync(homeCacheDir, { recursive: true, force: true })
      process.stderr.write(`dispatcher: cleaned .home/.npm from ${cwd}\n`)
    }
  } catch { /* best effort */ }
}

export function dirSizeBytes(dirPath: string): number {
  try {
    const output = execSync(`du -sb ${JSON.stringify(dirPath)}`, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).toString()
    return parseInt(output.split("\t")[0] ?? "0", 10) || 0
  } catch {
    return 0
  }
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

export function buildExecutionPrompt(topicSession: TopicSession, directive?: string): string {
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
  if (directive) {
    lines.push(directive)
  } else {
    lines.push("Implement the plan above. Follow the plan closely.")
  }

  return lines.join("\n")
}
