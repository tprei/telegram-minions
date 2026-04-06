import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import fs from "node:fs"
import type { DispatcherContext } from "../orchestration/dispatcher-context.js"
import type { TopicSession } from "../domain/session-types.js"
import type { TelegramPhotoSize } from "../domain/telegram-types.js"
import { dirSizeBytes } from "../session/session-manager.js"
import {
  parseTaskArgs, parseReviewArgs, buildReviewAllTask,
  buildRepoKeyboard, escapeHtml, extractRepoName,
} from "./command-parser.js"
import { extractDagItems } from "../dag/dag-extract.js"
import {
  formatStatus,
  formatStats,
  formatUsage,
  formatHelp,
  formatProfileList,
  formatConfigHelp,
  formatDagAnalyzing,
  formatPlanExecuting,
  formatDoctorAnalyzing,
} from "../telegram/format.js"
import { gatherDiagnosticEvidence, buildDoctorPrompt } from "./doctor.js"
import { fetchClaudeUsage } from "../claude-usage.js"
import { buildExecutionPrompt } from "../session/session-manager.js"
import { loggers } from "../logger.js"

const log = loggers.dispatcher
const execFile = promisify(execFileCb)

/**
 * CommandHandler — extracted from Dispatcher.
 *
 * Owns global commands (status, stats, usage, help, config, clean),
 * session-creating commands (task, review),
 * and topic-scoped commands (dag, done, execute).
 */
export class CommandHandler {
  private readonly ctx: DispatcherContext

  constructor(ctx: DispatcherContext) {
    this.ctx = ctx
  }

  // ── Global commands ───────────────────────────────────────────────────

  async handleStatusCommand(): Promise<void> {
    const taskSessions = [...this.ctx.sessions.values()]
    const topicSessionList = [...this.ctx.topicSessions.values()]
    const msg = formatStatus(taskSessions, topicSessionList, this.ctx.config.workspace.maxConcurrentSessions, this.ctx.config.telegram.chatId)
    await this.ctx.telegram.sendMessage(msg)
  }

  async handleStatsCommand(): Promise<void> {
    const agg = await this.ctx.stats.aggregate(7)
    await this.ctx.telegram.sendMessage(formatStats(agg))
  }

  async handleUsageCommand(): Promise<void> {
    const [acpUsage, agg, breakdown, recent] = await Promise.all([
      fetchClaudeUsage(),
      this.ctx.stats.aggregate(7),
      this.ctx.stats.breakdownByMode(7),
      this.ctx.stats.recentSessions(5),
    ])
    await this.ctx.telegram.sendMessage(formatUsage(acpUsage, agg, breakdown, recent))
  }

  async handleHelpCommand(): Promise<void> {
    await this.ctx.telegram.sendMessage(formatHelp())
  }

  async handleConfigCommand(args: string): Promise<void> {
    if (!args) {
      const profiles = this.ctx.profileStore.list()
      const defaultId = this.ctx.profileStore.getDefaultId()
      await this.ctx.telegram.sendMessage(formatProfileList(profiles, defaultId))
      return
    }

    const parts = args.split(/\s+/)
    const subcommand = parts[0]

    if (subcommand === "add" && parts.length >= 3) {
      const id = parts[1]
      const name = parts.slice(2).join(" ")
      const added = this.ctx.profileStore.add({ id, name })
      if (added) {
        await this.ctx.telegram.sendMessage(`✅ Added profile <code>${escapeHtml(id)}</code>`)
      } else {
        await this.ctx.telegram.sendMessage(`❌ Profile <code>${escapeHtml(id)}</code> already exists`)
      }
      return
    }

    if (subcommand === "set" && parts.length >= 4) {
      const id = parts[1]
      const field = parts[2]
      const value = parts.slice(3).join(" ")
      const validFields = ["name", "baseUrl", "authToken", "opusModel", "sonnetModel", "haikuModel"]
      if (!validFields.includes(field)) {
        await this.ctx.telegram.sendMessage(`❌ Invalid field. Valid: ${validFields.join(", ")}`)
        return
      }
      const updated = this.ctx.profileStore.update(id, { [field]: value })
      if (updated) {
        await this.ctx.telegram.sendMessage(`✅ Updated <code>${escapeHtml(id)}.${escapeHtml(field)}</code>`)
      } else {
        await this.ctx.telegram.sendMessage(`❌ Profile <code>${escapeHtml(id)}</code> not found`)
      }
      return
    }

    if (subcommand === "remove" && parts.length >= 2) {
      const id = parts[1]
      const removed = this.ctx.profileStore.remove(id)
      if (removed) {
        await this.ctx.telegram.sendMessage(`✅ Removed profile <code>${escapeHtml(id)}</code>`)
      } else {
        await this.ctx.telegram.sendMessage(`❌ Cannot remove <code>${escapeHtml(id)}</code> (not found or is default)`)
      }
      return
    }

    if (subcommand === "default") {
      if (parts.length === 1) {
        this.ctx.profileStore.clearDefault()
        await this.ctx.telegram.sendMessage(`✅ Cleared default profile`)
        return
      }
      const id = parts[1]
      if (id === "clear") {
        this.ctx.profileStore.clearDefault()
        await this.ctx.telegram.sendMessage(`✅ Cleared default profile`)
        return
      }
      const set = this.ctx.profileStore.setDefaultId(id)
      if (set) {
        const p = this.ctx.profileStore.get(id)
        await this.ctx.telegram.sendMessage(`✅ Default profile set to <code>${escapeHtml(id)}</code> (${escapeHtml(p?.name ?? id)})`)
      } else {
        await this.ctx.telegram.sendMessage(`❌ Profile <code>${escapeHtml(id)}</code> not found`)
      }
      return
    }

    await this.ctx.telegram.sendMessage(formatConfigHelp())
  }

  async handleCleanCommand(): Promise<void> {
    const root = this.ctx.config.workspace.root
    let freedBytes = 0
    let removedSessions = 0
    let removedOrphans = 0
    let removedRepos = 0

    const now = Date.now()
    const staleTtlMs = this.ctx.config.workspace.staleTtlMs
    const idle: [string, TopicSession][] = []
    for (const [threadId, session] of this.ctx.topicSessions) {
      if (session.activeSessionId) continue
      const staleTime = session.interruptedAt ?? session.lastActivityAt
      if (now - staleTime > staleTtlMs) {
        idle.push([threadId, session])
      }
    }

    for (const [threadId, session] of idle) {
      if (session.cwd && fs.existsSync(session.cwd)) {
        freedBytes += dirSizeBytes(session.cwd)
      }
      await this.ctx.telegram.deleteForumTopic(threadId)
      await this.ctx.removeWorkspace(session)
      this.ctx.topicSessions.delete(threadId)
      removedSessions++
    }

    const activeCwds = new Set<string>()
    for (const session of this.ctx.topicSessions.values()) {
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
      if (this.ctx.sessions.has(entry.name)) continue

      freedBytes += dirSizeBytes(entryPath)
      try {
        fs.rmSync(entryPath, { recursive: true, force: true })
        removedOrphans++
        log.info({ path: entryPath }, "removed orphan workspace")
      } catch (err) {
        log.warn({ err, path: entryPath }, "failed to remove orphan")
      }
    }

    const activeRepos = new Set<string>()
    for (const session of this.ctx.topicSessions.values()) {
      if (session.repoUrl) {
        activeRepos.add(extractRepoName(session.repoUrl))
      }
    }

    const isActiveCache = (key: string) =>
      [...activeRepos].some((r) => key === r || key.startsWith(`${r}-`))

    const reposDir = path.join(root, ".repos")
    if (fs.existsSync(reposDir)) {
      const repoEntries = fs.readdirSync(reposDir, { withFileTypes: true })
      for (const entry of repoEntries) {
        const entryPath = path.join(reposDir, entry.name)

        if (entry.isDirectory() && entry.name.endsWith(".git")) {
          const repoName = entry.name.replace(/\.git$/, "")
          if (activeRepos.has(repoName)) continue
          freedBytes += dirSizeBytes(entryPath)
          try {
            fs.rmSync(entryPath, { recursive: true, force: true })
            removedRepos++
            log.info({ path: entryPath }, "removed bare repo")
          } catch (err) {
            log.warn({ err, path: entryPath }, "failed to remove bare repo")
          }
        } else if (entry.isDirectory() && entry.name.endsWith("-node_modules")) {
          const cacheKey = entry.name.replace(/-node_modules$/, "")
          if (isActiveCache(cacheKey)) continue
          freedBytes += dirSizeBytes(entryPath)
          try {
            fs.rmSync(entryPath, { recursive: true, force: true })
            removedRepos++
            log.info({ path: entryPath }, "removed cached node_modules")
          } catch (err) {
            log.warn({ err, path: entryPath }, "failed to remove cached node_modules")
          }
        } else if (!entry.isDirectory() && entry.name.endsWith("-lock.hash")) {
          const cacheKey = entry.name.replace(/-lock\.hash$/, "")
          if (isActiveCache(cacheKey)) continue
          try {
            fs.rmSync(entryPath)
            log.info({ path: entryPath }, "removed cached lock hash")
          } catch (err) {
            log.warn({ err, path: entryPath }, "failed to remove cached lock hash")
          }
        }
      }
    }

    await this.ctx.persistTopicSessions()
    this.ctx.updatePinnedSummary()

    const totalItems = removedSessions + removedOrphans + removedRepos
    if (totalItems === 0) {
      await this.ctx.telegram.sendMessage("🧹 Nothing to clean up — disk is tidy.")
      return
    }

    const itemParts: string[] = []
    if (removedSessions > 0) itemParts.push(`${removedSessions} idle session(s)`)
    if (removedOrphans > 0) itemParts.push(`${removedOrphans} orphaned workspace(s)`)
    if (removedRepos > 0) itemParts.push(`${removedRepos} cached repo(s)`)

    const freedMB = (freedBytes / (1024 * 1024)).toFixed(1)
    await this.ctx.telegram.sendMessage(`🧹 Cleaned ${itemParts.join(", ")} — freed ~${freedMB} MB.`)
  }

  // ── Session-creating commands ─────────────────────────────────────────

  async handleTaskCommand(args: string, replyThreadId?: string, photos?: TelegramPhotoSize[]): Promise<void> {
    if (this.ctx.sessions.size >= this.ctx.config.workspace.maxConcurrentSessions) {
      if (replyThreadId !== undefined) {
        await this.ctx.telegram.sendMessage(
          `⚠️ Max concurrent sessions (${this.ctx.config.workspace.maxConcurrentSessions}) reached. Wait for one to finish.`,
          replyThreadId,
        )
      }
      return
    }

    const { repoUrl, task } = parseTaskArgs(this.ctx.config.repos, args)

    if (!task) {
      if (replyThreadId !== undefined) {
        await this.ctx.telegram.sendMessage(
          `Usage: <code>/task [repo] description of the task</code> (alias: <code>/w</code>)\n` +
          `Repos: ${Object.keys(this.ctx.config.repos).map((s) => `<code>${s}</code>`).join(", ")}\n` +
          `Or use a full URL or omit repo entirely.`,
          replyThreadId,
        )
      }
      return
    }

    if (!repoUrl) {
      const repoKeys = Object.keys(this.ctx.config.repos)
      if (repoKeys.length > 0) {
        const keyboard = buildRepoKeyboard(repoKeys)
        const msgId = await this.ctx.telegram.sendMessageWithKeyboard(
          `Pick a repo for: <i>${escapeHtml(task)}</i>`,
          keyboard,
          replyThreadId,
        )
        if (msgId) {
          this.ctx.pendingTasks.set(String(msgId), { task, threadId: replyThreadId, mode: "task" })
        }
        return
      }
    }

    await this.ctx.startWithProfileSelection(repoUrl, task, "task", replyThreadId, photos)
  }

  async handleReviewCommand(args: string, replyThreadId?: string): Promise<void> {
    const parsed = parseReviewArgs(this.ctx.config.repos, args)

    if (!parsed.repoUrl && !parsed.task) {
      const repoKeys = Object.keys(this.ctx.config.repos)
      if (repoKeys.length === 0) {
        if (replyThreadId !== undefined) {
          await this.ctx.telegram.sendMessage(
            `Usage: <code>/review [repo] [PR#]</code>\nNo repos configured.`,
            replyThreadId,
          )
        }
        return
      }
      if (repoKeys.length === 1) {
        const repoUrl = this.ctx.config.repos[repoKeys[0]]
        const task = buildReviewAllTask(repoUrl)
        await this.ctx.startWithProfileSelection(repoUrl, task, "review", replyThreadId)
        return
      }
      const keyboard = buildRepoKeyboard(repoKeys, "review")
      const msgId = await this.ctx.telegram.sendMessageWithKeyboard(
        `Pick a repo to review all unreviewed PRs:`,
        keyboard,
        replyThreadId,
      )
      if (msgId) {
        this.ctx.pendingTasks.set(String(msgId), { task: "", threadId: replyThreadId, mode: "review" })
      }
      return
    }

    if (parsed.repoUrl && !parsed.task) {
      const task = buildReviewAllTask(parsed.repoUrl)
      await this.ctx.startWithProfileSelection(parsed.repoUrl, task, "review", replyThreadId)
      return
    }

    if (!parsed.repoUrl && parsed.task) {
      const repoKeys = Object.keys(this.ctx.config.repos)
      if (repoKeys.length > 0) {
        const keyboard = buildRepoKeyboard(repoKeys, "review")
        const msgId = await this.ctx.telegram.sendMessageWithKeyboard(
          `Pick a repo for review: <i>${escapeHtml(parsed.task)}</i>`,
          keyboard,
          replyThreadId,
        )
        if (msgId) {
          this.ctx.pendingTasks.set(String(msgId), { task: parsed.task, threadId: replyThreadId, mode: "review" })
        }
        return
      }
    }

    if (parsed.repoUrl && parsed.task) {
      await this.ctx.startWithProfileSelection(parsed.repoUrl, parsed.task, "review", replyThreadId)
      return
    }
  }

  // ── Topic-scoped commands ─────────────────────────────────────────────

  async handleExecuteCommand(topicSession: TopicSession, directive?: string): Promise<void> {
    if (topicSession.activeSessionId) {
      const activeSession = this.ctx.sessions.get(topicSession.threadId)
      if (activeSession) {
        await activeSession.handle.kill()
      }
      this.ctx.sessions.delete(topicSession.threadId)
    }

    const executionTask = buildExecutionPrompt(topicSession, directive)

    await this.ctx.telegram.sendMessage(
      formatPlanExecuting(topicSession.slug, "starting…"),
      topicSession.threadId,
    )

    topicSession.mode = "task"
    topicSession.activeSessionId = undefined
    topicSession.pendingFeedback = []
    topicSession.autoAdvance = undefined

    await this.ctx.spawnTopicAgent(topicSession, executionTask)
  }

  async handleDagCommand(topicSession: TopicSession, directive?: string): Promise<void> {
    if (topicSession.activeSessionId) {
      const activeSession = this.ctx.sessions.get(topicSession.threadId)
      if (activeSession) await activeSession.handle.kill()
      this.ctx.sessions.delete(topicSession.threadId)
      topicSession.activeSessionId = undefined
    }

    await this.ctx.telegram.sendMessage(
      formatDagAnalyzing(topicSession.slug),
      topicSession.threadId,
    )

    const GRACE_PERIOD_MS = 2000
    await new Promise((resolve) => setTimeout(resolve, GRACE_PERIOD_MS))

    const profile = topicSession.profileId ? this.ctx.profileStore.get(topicSession.profileId) : undefined
    const result = await extractDagItems(topicSession.conversation, directive, profile)

    if (result.error === "system") {
      await this.ctx.telegram.sendMessage(
        `⚠️ <b>System error</b> during extraction: <code>${result.errorMessage ?? "Unknown error"}</code>\n\n` +
        `Try <code>/dag</code> again, or use <code>/split</code> for parallel tasks.`,
        topicSession.threadId,
      )
      return
    }

    if (result.items.length === 0) {
      await this.ctx.telegram.sendMessage(
        `⚠️ Could not extract work items with dependencies. Try <code>/split</code> or <code>/execute</code> instead.`,
        topicSession.threadId,
      )
      return
    }

    if (result.items.length === 1) {
      await this.ctx.telegram.sendMessage(
        `Only 1 item found — using <code>/execute</code> instead.`,
        topicSession.threadId,
      )
      await this.handleExecuteCommand(topicSession, result.items[0].description)
      return
    }

    await this.ctx.startDag(topicSession, result.items, false)
  }

  async handleDoctorCommand(topicSession: TopicSession, directive?: string): Promise<void> {
    // Kill any active session in this thread — doctor replaces it
    if (topicSession.activeSessionId) {
      const activeSession = this.ctx.sessions.get(topicSession.threadId)
      if (activeSession) await activeSession.handle.kill()
      this.ctx.sessions.delete(topicSession.threadId)
      topicSession.activeSessionId = undefined
    }

    await this.ctx.telegram.sendMessage(
      formatDoctorAnalyzing(topicSession.slug),
      topicSession.threadId,
    )

    const evidence = gatherDiagnosticEvidence({
      currentSession: topicSession,
      isCurrentActive: false, // we just killed it above
      getSession: (threadId) => this.ctx.topicSessions.get(threadId),
      isSessionActive: (threadId) => this.ctx.sessions.has(threadId),
      getDag: (dagId) => this.ctx.dags.get(dagId),
      chatId: this.ctx.config.telegram.chatId,
    })

    let prompt = buildDoctorPrompt(evidence)
    if (directive) {
      prompt += `\n## User note\n\n${directive}\n`
    }

    // Start a new plan-mode session with the diagnostic prompt
    await this.ctx.startWithProfileSelection(
      topicSession.repoUrl,
      prompt,
      "plan",
      topicSession.threadId,
    )
  }

  async handleDoneCommand(topicSession: TopicSession): Promise<void> {
    const threadId = topicSession.threadId

    if (topicSession.parentThreadId || topicSession.dagNodeId) {
      await this.ctx.telegram.sendMessage(
        `⚠️ <code>/done</code> is not available on child sessions. Use <code>/done</code> or <code>/land</code> from the parent thread.`,
        threadId,
      )
      return
    }

    const prUrl = topicSession.prUrl ?? this.ctx.extractPRFromConversation(topicSession)
    if (!prUrl) {
      await this.ctx.telegram.sendMessage(
        `⚠️ No PR found for this session. Nothing to merge.`,
        threadId,
      )
      return
    }

    const repoMatch = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/)
    const repo = repoMatch?.[1]
    const prNumber = prNumberMatch?.[1]

    if (!repo || !prNumber) {
      await this.ctx.telegram.sendMessage(
        `⚠️ Could not parse PR URL: <code>${escapeHtml(prUrl)}</code>`,
        threadId,
      )
      return
    }

    const execOpts = {
      cwd: topicSession.cwd,
      timeout: 30_000,
      encoding: "utf-8" as const,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }

    await this.ctx.refreshGitToken()
    try {
      const { stdout: checksJson } = await execFile("gh", ["pr", "checks", prNumber, "--repo", repo, "--json", "name,state,bucket"], execOpts)

      if (checksJson.trim() && checksJson.trim() !== "[]") {
        const checks = JSON.parse(checksJson.trim()) as { name: string; state: string; bucket: string }[]
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
    }

    try {
      await execFile("gh", ["pr", "merge", prNumber, "--repo", repo, "--squash", "--delete-branch"], {
        ...execOpts,
        timeout: 120_000,
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

    await this.ctx.closeChildSessions(topicSession)

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
