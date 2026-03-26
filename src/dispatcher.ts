import { execSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import crypto from "node:crypto"
import type { TelegramClient } from "./telegram.js"
import { captureException } from "./sentry.js"
import { SessionHandle, type SessionConfig } from "./session.js"
import { Observer } from "./observer.js"
import type { TelegramUpdate, TelegramCallbackQuery, TelegramPhotoSize, SessionMeta, TopicSession, SessionState, TopicMessage } from "./types.js"
import { generateSlug } from "./slugs.js"
import type { MinionConfig, McpConfig } from "./config-types.js"
import { DEFAULT_PROMPTS } from "./prompts.js"
import { SessionStore } from "./store.js"
import { ProfileStore } from "./profile-store.js"
import {
  esc,
  formatPlanIteration,
  formatPlanExecuting,
  formatPlanComplete,
  formatThinkIteration,
  formatThinkComplete,
  formatReviewIteration,
  formatReviewComplete,
  formatStatus,
  formatTaskComplete,
  formatFollowUpIteration,
  formatHelp,
  formatQualityReport,
  formatQualityReportForContext,
  formatBudgetWarning,
  formatStats,
  formatUsage,
  formatCIWatching,
  formatCIFailed,
  formatCIFixing,
  formatCIPassed,
  formatCIGaveUp,
  formatCIConflicts,
  formatCIResolvingConflicts,
  formatCINoChecks,
  formatProfileList,
  formatConfigHelp,
  formatSplitAnalyzing,
  formatSplitStart,
  formatSplitChildComplete,
  formatSplitAllDone,
  formatStackAnalyzing,
  formatDagAnalyzing,
  formatDagStart,
  formatDagNodeStarting,
  formatDagNodeComplete,
  formatDagNodeSkipped,
  formatDagAllDone,
  formatLandStart,
  formatLandProgress,
  formatLandComplete,
  formatLandError,
} from "./format.js"
import { extractSplitItems, buildSplitChildPrompt } from "./split.js"
import { extractStackItems, extractDagItems, buildDagChildPrompt } from "./dag-extract.js"
import {
  buildDag, advanceDag, failNode, resetFailedNode, isDagComplete,
  readyNodes, dagProgress, getUpstreamBranches, topologicalSort,
  renderDagForGitHub, upsertDagSection,
  type DagGraph, type DagNode, type DagInput,
} from "./dag.js"
import { runQualityGates, type QualityReport } from "./quality-gates.js"
import { StatsTracker } from "./stats.js"
import { fetchClaudeUsage } from "./claude-usage.js"
import { writeSessionLog } from "./session-log.js"
import { extractPRUrl, findPRByBranch, waitForCI, getFailedCheckLogs, buildCIFixPrompt, buildQualityGateFixPrompt, buildMergeConflictPrompt, checkPRMergeability } from "./ci-babysit.js"
import { buildConversationDigest } from "./conversation-digest.js"
import { truncateConversation } from "./conversation-limits.js"
import { DEFAULT_CI_FIX_PROMPT, DEFAULT_RECOVERY_PROMPT } from "./prompts.js"
import { StateBroadcaster, topicSessionToApi, dagToApi } from "./api-server.js"
import { loggers } from "./logger.js"
import { SessionNotFoundError } from "./errors.js"
import {
  TASK_PREFIX, TASK_SHORT, PLAN_PREFIX, THINK_PREFIX, REVIEW_PREFIX,
  EXECUTE_CMD, STATUS_CMD, STATS_CMD, REPLY_PREFIX, REPLY_SHORT,
  CLOSE_CMD, STOP_CMD, HELP_CMD, CLEAN_CMD, USAGE_CMD, CONFIG_CMD,
  SPLIT_CMD, STACK_CMD, DAG_CMD, LAND_CMD, RETRY_CMD,
  parseTaskArgs, parseReviewArgs, buildReviewAllTask,
  buildRepoKeyboard, buildProfileKeyboard,
  escapeHtml, extractRepoName, appendImageContext,
} from "./command-parser.js"
import {
  type ActiveSession, type PendingTask,
  buildContextPrompt, buildExecutionPrompt,
  prepareWorkspace, removeWorkspace, cleanBuildArtifacts, dirSizeBytes,
  downloadPhotos, prepareFanInBranch, mergeUpstreamBranches,
} from "./session-manager.js"

const log = loggers.dispatcher

const POLL_TIMEOUT = 30

export class Dispatcher {
  private readonly sessions = new Map<number, ActiveSession>()
  private readonly topicSessions = new Map<number, TopicSession>()
  private readonly pendingTasks = new Map<number, PendingTask>()
  private readonly pendingProfiles = new Map<number, PendingTask>()
  private readonly store: SessionStore
  private readonly profileStore: ProfileStore
  private readonly dags = new Map<string, DagGraph>()
  private readonly pendingBabysitPRs = new Map<number, Array<{ childSession: TopicSession; prUrl: string; qualityReport?: QualityReport }>>()
  private readonly broadcaster?: StateBroadcaster
  private offset = 0
  private running = false
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  private readonly stats: StatsTracker
  private pinnedSummaryMessageId: number | null = null

  constructor(
    private readonly telegram: TelegramClient,
    private readonly observer: Observer,
    private readonly config: MinionConfig,
    broadcaster?: StateBroadcaster,
  ) {
    this.broadcaster = broadcaster
    this.store = new SessionStore(this.config.workspace.root)
    this.profileStore = new ProfileStore(this.config.workspace.root)
    this.stats = new StatsTracker(this.config.workspace.root)
    this.loadPinnedMessageId()
  }

  private pushToConversation(session: TopicSession, message: TopicMessage): void {
    session.conversation.push(message)
    const { conversation, truncated, truncatedCount } = truncateConversation(
      session.conversation,
      this.config.workspace.maxConversationLength,
    )
    if (truncated) {
      session.conversation = conversation
      log.info({ slug: session.slug, truncatedCount }, "truncated conversation")
    }
  }

  private broadcastSession(session: TopicSession, eventType: "session_created" | "session_updated", sessionState?: "completed" | "errored"): void {
    if (!this.broadcaster) return
    const apiSession = topicSessionToApi(session, this.config.telegram.chatId, session.activeSessionId, sessionState)
    this.broadcaster.broadcast({ type: eventType, session: apiSession })
  }

  private broadcastSessionDeleted(slug: string): void {
    if (!this.broadcaster) return
    this.broadcaster.broadcast({ type: "session_deleted", sessionId: slug })
  }

  private broadcastDag(graph: DagGraph, eventType: "dag_created" | "dag_updated"): void {
    if (!this.broadcaster) return
    const apiDag = dagToApi(graph, this.topicSessions, this.sessions, this.config.telegram.chatId)
    this.broadcaster.broadcast({ type: eventType, dag: apiDag })
  }

  private broadcastDagDeleted(dagId: string): void {
    if (!this.broadcaster) return
    this.broadcaster.broadcast({ type: "dag_deleted", dagId })
  }

  async loadPersistedSessions(): Promise<void> {
    const { active, expired, offset } = await this.store.load()
    this.offset = offset

    for (const [threadId, session] of active) {
      this.topicSessions.set(threadId, session)

      // Notify about interrupted sessions
      if (session.interruptedAt) {
        log.info({ slug: session.slug, threadId }, "session was interrupted, notifying")
        this.telegram.sendMessage(
          `⚡ This session was interrupted by a deploy. Send <b>/reply</b> to continue.`,
          threadId,
        ).catch((err) => {
          log.warn({ err, slug: session.slug }, "failed to notify interrupted session")
        })
        // Clear the interruption flag
        session.interruptedAt = undefined
      }
    }

    if (active.size > 0) {
      log.info({ count: active.size, offset }, "loaded persisted sessions")
    }
    if (expired.size > 0) {
      log.info({ count: expired.size }, "cleaning expired sessions")
      for (const [threadId, session] of expired) {
        await this.telegram.deleteForumTopic(threadId)
        await this.removeWorkspace(session)
        log.info({ slug: session.slug, threadId }, "cleaned expired session")
      }
    }
    this.updatePinnedSummary()
  }

  async start(): Promise<void> {
    this.running = true
    log.info("started, polling Telegram")

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
    // Mark active sessions as interrupted before persisting for restart
    this.persistTopicSessions(true).catch(() => {}) // best effort on shutdown
    log.info("stopped")
  }

  async handleReplyCommand(threadId: number, text: string, _photos?: string[]): Promise<void> {
    const topicSession = this.topicSessions.get(threadId)
    if (!topicSession) {
      await this.telegram.sendMessage(
        `❌ Thread ${threadId} not found or no active session`,
        threadId,
      )
      return
    }
    if (!topicSession.activeSessionId) {
      await this.telegram.sendMessage(
        `❌ No active session in thread ${threadId}`,
        threadId
      )
      return
    }
    await this.handleTopicFeedback(topicSession, text)
  }

  async handleStopCommand(threadId: number): Promise<void> {
    const topicSession = this.topicSessions.get(threadId)
    if (!topicSession) {
      await this.telegram.sendMessage(
        `❌ Thread ${threadId} not found or no active session`,
        threadId
      )
      return
    }
    await this.handleStopCommandInternal(topicSession)
  }

  async handleCloseCommand(threadId: number): Promise<void> {
    const topicSession = this.topicSessions.get(threadId)
    if (!topicSession) {
      await this.telegram.sendMessage(
        `❌ Thread ${threadId} not found or no active session`,
        threadId
      )
      return
    }
    await this.handleCloseCommandInternal(topicSession)
  }

  startCleanupTimer(): void {
    this.cleanupStaleSessions().catch((err) => {
      log.error({ err }, "startup cleanup error")
    })
    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleSessions().catch((err) => {
        log.error({ err }, "cleanup error")
      })
    }, this.config.workspace.cleanupIntervalMs)
    log.info({
      intervalMinutes: Math.round(this.config.workspace.cleanupIntervalMs / 60000),
      ttlDays: Math.round(this.config.workspace.staleTtlMs / 86400000),
    }, "cleanup timer started")
  }

  private stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  private async cleanupStaleSessions(): Promise<void> {
    const now = Date.now()
    const staleTtlMs = this.config.workspace.staleTtlMs
    const stale: [number, TopicSession][] = []

    for (const [threadId, session] of this.topicSessions) {
      if (session.activeSessionId) continue
      // Consider both lastActivityAt and interruptedAt for staleness
      const staleTime = session.interruptedAt ?? session.lastActivityAt
      if (now - staleTime > staleTtlMs) {
        stale.push([threadId, session])
      }
    }

    if (stale.length === 0) return

    log.info({ count: stale.length }, "cleaning up stale sessions")

    for (const [threadId, session] of stale) {
      // Cascade cleanup to children first (handles both tracked and orphaned)
      await this.closeChildSessions(session)

      await this.telegram.deleteForumTopic(threadId)
      await this.removeWorkspace(session)
      this.topicSessions.delete(threadId)
      log.info({ slug: session.slug, threadId }, "cleaned up stale session")
    }

    await this.persistTopicSessions()
    this.updatePinnedSummary()
  }

  private async persistTopicSessions(markInterrupted = false): Promise<void> {
    const toSave = new Map<number, TopicSession>()
    const now = Date.now()
    for (const [threadId, session] of this.topicSessions) {
      if (markInterrupted && session.activeSessionId) {
        // Mark as interrupted so we can notify on restart
        toSave.set(threadId, {
          ...session,
          activeSessionId: undefined,
          interruptedAt: now,
        })
      } else {
        toSave.set(threadId, session)
      }
    }
    await this.store.save(toSave, this.offset)
  }

  private get pinnedSummaryPath(): string {
    return path.join(this.config.workspace.root, ".pinned-summary.json")
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
    const sessions = [...this.topicSessions.values()]
    if (sessions.length === 0) return "No active minion sessions."
    const lines = sessions.map((s) => {
      const taskText = s.conversation[0]?.text ?? ""
      const desc = taskText.length > 60 ? taskText.slice(0, 60).trimEnd() + "…" : taskText
      const icon = s.activeSessionId ? "⚡" : "💬"
      return `${icon} <b>${escapeHtml(s.slug)}</b>: ${escapeHtml(desc)} (${s.mode})`
    })
    return lines.join("\n")
  }

  private updatePinnedSummary(): void {
    const html = this.formatPinnedSummary()
    ;(async () => {
      if (this.pinnedSummaryMessageId !== null) {
        const ok = await this.telegram.editMessage(this.pinnedSummaryMessageId, html)
        if (ok) return
        this.pinnedSummaryMessageId = null
        this.savePinnedMessageId(null)
      }
      const { ok, messageId } = await this.telegram.sendMessage(html)
      if (ok && messageId !== null) {
        await this.telegram.pinChatMessage(messageId)
        this.pinnedSummaryMessageId = messageId
        this.savePinnedMessageId(messageId)
      }
    })().catch((err) => {
      log.error({ err }, "updatePinnedSummary error")
    })
  }

  private async poll(): Promise<void> {
    const updates = await this.telegram.getUpdates(this.offset, POLL_TIMEOUT)

    for (const update of updates) {
      try {
        await this.handleUpdate(update)
      } catch (err) {
        log.error({ err, updateId: update.update_id }, "error handling update")
        captureException(err, { updateId: update.update_id })
      }
    }

    if (updates.length > 0) {
      this.offset = Math.max(...updates.map((u) => u.update_id)) + 1
      // Persist offset after each batch so we don't lose messages on crash/deploy
      await this.persistTopicSessions()
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
      if (text === USAGE_CMD) {
        await this.handleUsageCommand()
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

    if (text?.startsWith(REVIEW_PREFIX)) {
      await this.handleReviewCommand(text.slice(REVIEW_PREFIX.length).trim(), message.message_thread_id)
      return
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
          await this.handleCloseCommandInternal(topicSession)
        } else if (text === STOP_CMD) {
          await this.handleStopCommandInternal(topicSession)
        } else if ((topicSession.mode === "plan" || topicSession.mode === "think" || topicSession.mode === "review") && (text === EXECUTE_CMD || text?.startsWith(EXECUTE_CMD + " "))) {
          const directive = text!.slice(EXECUTE_CMD.length).trim() || undefined
          await this.handleExecuteCommand(topicSession, directive)
        } else if ((topicSession.mode === "plan" || topicSession.mode === "think") && (text === SPLIT_CMD || text?.startsWith(SPLIT_CMD + " "))) {
          const directive = text!.slice(SPLIT_CMD.length).trim() || undefined
          await this.handleSplitCommand(topicSession, directive)
        } else if ((topicSession.mode === "plan" || topicSession.mode === "think") && (text === STACK_CMD || text?.startsWith(STACK_CMD + " "))) {
          const directive = text!.slice(STACK_CMD.length).trim() || undefined
          await this.handleStackCommand(topicSession, directive)
        } else if ((topicSession.mode === "plan" || topicSession.mode === "think") && (text === DAG_CMD || text?.startsWith(DAG_CMD + " "))) {
          const directive = text!.slice(DAG_CMD.length).trim() || undefined
          await this.handleDagCommand(topicSession, directive)
        } else if (text === LAND_CMD) {
          await this.handleLandCommand(topicSession)
        } else if (text === RETRY_CMD || text?.startsWith(RETRY_CMD + " ")) {
          const nodeId = text!.slice(RETRY_CMD.length).trim() || undefined
          await this.handleRetryCommand(topicSession, nodeId)
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
        log.debug({ threadId: message.message_thread_id }, "received message in active topic, session still initializing")
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

    if (!data.startsWith("repo:") && !data.startsWith("plan-repo:") && !data.startsWith("think-repo:") && !data.startsWith("review-repo:")) {
      await this.telegram.answerCallbackQuery(query.id)
      return
    }

    const isThink = data.startsWith("think-repo:")
    const isPlan = data.startsWith("plan-repo:")
    const isReview = data.startsWith("review-repo:")
    const repoSlug = isThink
      ? data.slice("think-repo:".length)
      : isPlan
      ? data.slice("plan-repo:".length)
      : isReview
      ? data.slice("review-repo:".length)
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
        if (pending.mode === "review" && !pending.task) {
          pending.task = buildReviewAllTask(repoUrl)
        }

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
    const agg = await this.stats.aggregate(7)
    await this.telegram.sendMessage(formatStats(agg))
  }

  private async handleUsageCommand(): Promise<void> {
    const [acpUsage, agg, breakdown, recent] = await Promise.all([
      fetchClaudeUsage(),
      this.stats.aggregate(7),
      this.stats.breakdownByMode(7),
      this.stats.recentSessions(5),
    ])
    await this.telegram.sendMessage(formatUsage(acpUsage, agg, breakdown, recent))
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

    const now = Date.now()
    const staleTtlMs = this.config.workspace.staleTtlMs
    const idle: [number, TopicSession][] = []
    for (const [threadId, session] of this.topicSessions) {
      // Clean up idle sessions OR sessions that have been interrupted too long
      const isIdle = !session.activeSessionId
      const isStaleInterrupted =
        session.interruptedAt && now - session.interruptedAt >= staleTtlMs
      if (isIdle || isStaleInterrupted) {
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
        log.info({ path: entryPath }, "removed orphan workspace")
      } catch (err) {
        log.warn({ err, path: entryPath }, "failed to remove orphan")
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
          log.info({ path: repoPath }, "removed bare repo")
        } catch (err) {
          log.warn({ err, path: repoPath }, "failed to remove bare repo")
        }
      }
    }

    await this.persistTopicSessions()
    this.updatePinnedSummary()

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

  private async handleReviewCommand(args: string, replyThreadId?: number): Promise<void> {
    const parsed = parseReviewArgs(this.config.repos, args)

    if (!parsed.repoUrl && !parsed.task) {
      const repoKeys = Object.keys(this.config.repos)
      if (repoKeys.length === 0) {
        if (replyThreadId !== undefined) {
          await this.telegram.sendMessage(
            `Usage: <code>/review [repo] [PR#]</code>\nNo repos configured.`,
            replyThreadId,
          )
        }
        return
      }
      if (repoKeys.length === 1) {
        const repoUrl = this.config.repos[repoKeys[0]]
        const task = buildReviewAllTask(repoUrl)
        await this.startReviewSession(repoUrl, task, replyThreadId)
        return
      }
      const keyboard = buildRepoKeyboard(repoKeys, "review")
      const msgId = await this.telegram.sendMessageWithKeyboard(
        `Pick a repo to review all unreviewed PRs:`,
        keyboard,
        replyThreadId,
      )
      if (msgId) {
        this.pendingTasks.set(msgId, { task: "", threadId: replyThreadId, mode: "review" })
      }
      return
    }

    if (parsed.repoUrl && !parsed.task) {
      const task = buildReviewAllTask(parsed.repoUrl)
      await this.startReviewSession(parsed.repoUrl, task, replyThreadId)
      return
    }

    if (!parsed.repoUrl && parsed.task) {
      const repoKeys = Object.keys(this.config.repos)
      if (repoKeys.length > 0) {
        const keyboard = buildRepoKeyboard(repoKeys, "review")
        const msgId = await this.telegram.sendMessageWithKeyboard(
          `Pick a repo for review: <i>${escapeHtml(parsed.task)}</i>`,
          keyboard,
          replyThreadId,
        )
        if (msgId) {
          this.pendingTasks.set(msgId, { task: parsed.task, threadId: replyThreadId, mode: "review" })
        }
        return
      }
    }

    if (parsed.repoUrl && parsed.task) {
      await this.startReviewSession(parsed.repoUrl, parsed.task, replyThreadId)
      return
    }
  }

  private async startReviewSession(repoUrl: string, task: string, replyThreadId?: number): Promise<void> {
    const defaultProfileId = this.profileStore.getDefaultId()
    if (defaultProfileId) {
      await this.startTopicSession(repoUrl, task, "review", undefined, defaultProfileId)
      return
    }

    const profiles = this.profileStore.list()
    if (profiles.length > 1) {
      const keyboard = buildProfileKeyboard(profiles)
      const msgId = await this.telegram.sendMessageWithKeyboard(
        `Pick a profile for review: <i>${escapeHtml(task)}</i>`,
        keyboard,
        replyThreadId,
      )
      if (msgId) {
        this.pendingProfiles.set(msgId, { task, threadId: replyThreadId, repoUrl, mode: "review" })
      }
      return
    }

    await this.startTopicSession(repoUrl, task, "review")
  }

  private async startTopicSession(
    repoUrl: string | undefined,
    task: string,
    mode: "task" | "plan" | "think" | "review",
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
      : mode === "review"
      ? `👀 ${repo} · ${slug}`
      : `${repo} · ${slug}`

    let topic: { message_thread_id: number }
    try {
      topic = await this.telegram.createForumTopic(topicName)
    } catch (err) {
      log.error({ err, topicName }, "failed to create topic")
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
      branch: repoUrl ? `minion/${slug}` : undefined,
    }

    this.topicSessions.set(threadId, topicSession)
    this.broadcastSession(topicSession, "session_created")
    this.updatePinnedSummary()

    await this.spawnTopicAgent(topicSession, fullTask)
  }

  private async startTopicSessionWithProfile(
    repoUrl: string | undefined,
    task: string,
    mode: "task" | "plan" | "think" | "review",
    profileId?: string,
  ): Promise<void> {
    return this.startTopicSession(repoUrl, task, mode, undefined, profileId)
  }

  private async updateTopicTitle(topicSession: TopicSession, stateEmoji: string): Promise<void> {
    const name = `${stateEmoji} ${topicSession.repo} · ${topicSession.slug}`
    await this.telegram.editForumTopic(topicSession.threadId, name).catch(() => {})
  }

  private async spawnTopicAgent(topicSession: TopicSession, task: string, mcpOverrides?: Partial<McpConfig>, systemPromptOverride?: string): Promise<void> {
    if (this.sessions.size >= this.config.workspace.maxConcurrentSessions) {
      await this.telegram.sendMessage(
        `⚠️ Max concurrent sessions reached. Try again later.`,
        topicSession.threadId,
      )
      return
    }

    const sessionId = crypto.randomUUID()
    topicSession.activeSessionId = sessionId
    this.broadcastSession(topicSession, "session_updated")

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
      this.pushToConversation(topicSession, { role: "assistant", text })
    }

    const prompts = { ...DEFAULT_PROMPTS, ...this.config.prompts }
    const profile = topicSession.profileId ? this.profileStore.get(topicSession.profileId) : undefined
    const sessionConfig: SessionConfig = {
      goose: this.config.goose,
      claude: this.config.claude,
      mcp: mcpOverrides ? { ...this.config.mcp, ...mcpOverrides } : this.config.mcp,
      profile,
      sessionEnvPassthrough: this.config.sessionEnvPassthrough,
    }

    const handle = new SessionHandle(
      meta,
      (event) => {
        this.observer.onEvent(meta, event).catch((err) => {
          loggers.observer.error({ err, sessionId }, "onEvent error")
        })

        if (event.type === "complete" && meta.totalTokens != null && meta.totalTokens > this.config.workspace.sessionTokenBudget) {
          log.warn({ sessionId, totalTokens: meta.totalTokens, budget: this.config.workspace.sessionTokenBudget }, "session exceeded token budget")
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
        this.broadcastSession(topicSession, "session_updated", state)
        this.updatePinnedSummary()

        this.stats.record({
          slug: topicSession.slug,
          repo: topicSession.repo,
          mode: topicSession.mode,
          state,
          durationMs,
          totalTokens: m.totalTokens ?? 0,
          timestamp: Date.now(),
        }).catch(() => {}) // best effort

        if (topicSession.mode === "think") {
          this.updateTopicTitle(topicSession, "💬").catch(() => {})
          this.observer.onSessionComplete(m, state, durationMs).catch((err) => {
            loggers.observer.error({ err, sessionId }, "onSessionComplete error")
          })
          this.telegram.sendMessage(
            formatThinkComplete(topicSession.slug),
            topicSession.threadId,
          ).catch(() => {})
          writeSessionLog(topicSession, m, state, durationMs)
        } else if (topicSession.mode === "review") {
          this.updateTopicTitle(topicSession, "💬").catch(() => {})
          this.observer.onSessionComplete(m, state, durationMs).catch((err) => {
            loggers.observer.error({ err, sessionId }, "onSessionComplete error")
          })
          this.telegram.sendMessage(
            formatReviewComplete(topicSession.slug),
            topicSession.threadId,
          ).catch(() => {})
          writeSessionLog(topicSession, m, state, durationMs)
        } else if (topicSession.mode === "plan") {
          this.updateTopicTitle(topicSession, "💬").catch(() => {})
          this.observer.onSessionComplete(m, state, durationMs).catch((err) => {
            loggers.observer.error({ err, sessionId }, "onSessionComplete error")
          })
          this.telegram.sendMessage(
            formatPlanComplete(topicSession.slug),
            topicSession.threadId,
          ).catch(() => {})
          writeSessionLog(topicSession, m, state, durationMs)
        } else if (state === "errored") {
          this.updateTopicTitle(topicSession, "❌").catch(() => {})
          this.observer.onSessionComplete(m, state, durationMs).catch((err) => {
            loggers.observer.error({ err, sessionId }, "onSessionComplete error")
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
                this.pushToConversation(topicSession, {
                  role: "user",
                  text: formatQualityReportForContext(qualityReport.results),
                })
              }
            } catch (err) {
              log.error({ err, sessionId }, "quality gates error")
              captureException(err, { operation: "qualityGates" })
            }

            writeSessionLog(topicSession, m, state, durationMs, qualityReport)

            if (topicSession.mode === "task") {
              const prUrl = this.extractPRFromConversation(topicSession)
              if (prUrl) {
                topicSession.prUrl = prUrl
                this.postSessionDigest(topicSession, prUrl)
                if (this.config.ci.babysitEnabled) {
                  if (topicSession.dagId || topicSession.parentThreadId) {
                    const parentId = topicSession.dagId
                      ? this.dags.get(topicSession.dagId)?.parentThreadId ?? topicSession.parentThreadId
                      : topicSession.parentThreadId
                    if (parentId != null) {
                      const queue = this.pendingBabysitPRs.get(parentId) ?? []
                      queue.push({ childSession: topicSession, prUrl, qualityReport })
                      this.pendingBabysitPRs.set(parentId, queue)
                    }
                  } else {
                    this.babysitPR(topicSession, prUrl, qualityReport).catch((err) => {
                      log.error({ err, prUrl }, "babysitPR error")
                      captureException(err, { operation: "babysitPR", prUrl })
                    })
                  }
                }
              }
            }
          }).catch((err) => {
            loggers.observer.error({ err, sessionId }, "flushAndComplete error")
          })
        }

        this.persistTopicSessions().catch(() => {}) // best effort
        this.cleanBuildArtifacts(topicSession.cwd)

        this.notifyParentOfChildComplete(topicSession, state).catch((err) => {
          log.warn({ err, slug: topicSession.slug }, "parent notify error")
        })

        if (topicSession.pendingFeedback.length > 0) {
          const feedback = topicSession.pendingFeedback.join("\n\n")
          topicSession.pendingFeedback = []
          this.handleTopicFeedback(topicSession, feedback).catch((err) => {
            log.error({ err }, "queued feedback error")
          })
        }
      },
      this.config.workspace.sessionTimeoutMs,
      this.config.workspace.sessionInactivityTimeoutMs,
      sessionConfig,
    )

    this.sessions.set(topicSession.threadId, { handle, meta, task })

    await this.updateTopicTitle(topicSession, "⚡")
    this.updatePinnedSummary()
    await this.observer.onSessionStart(meta, task, onTextCapture)
    const systemPrompt = systemPromptOverride ?? (topicSession.mode === "task" ? prompts.task : undefined)
    handle.start(task, systemPrompt)
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

  private postSessionDigest(topicSession: TopicSession, prUrl: string): void {
    const summaryPath = path.join(topicSession.cwd, ".session-summary.md")
    if (fs.existsSync(summaryPath)) return

    const digest = buildConversationDigest(topicSession.conversation)
    if (!digest) return

    try {
      execSync(`gh pr comment "${prUrl}" --body-file -`, {
        input: digest,
        cwd: topicSession.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (err) {
      log.error({ err }, "failed to post session digest")
    }
  }

  private async runDeferredBabysit(parentThreadId: number): Promise<void> {
    const entries = this.pendingBabysitPRs.get(parentThreadId)
    if (!entries || entries.length === 0) return
    this.pendingBabysitPRs.delete(parentThreadId)

    for (const { childSession, prUrl, qualityReport } of entries) {
      await this.babysitPR(childSession, prUrl, qualityReport).catch((err) => {
        log.error({ err, prUrl }, "deferred babysitPR error")
        captureException(err, { operation: "deferredBabysitPR", prUrl })
      })
    }
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

    log.info({ prUrl, maxRetries }, "watching CI for PR")

    // Check for merge conflicts before polling CI
    let mergeState = checkPRMergeability(prUrl, topicSession.cwd)
    if (mergeState === "UNKNOWN") {
      // GitHub may still be computing mergeability — retry once after a short delay
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      mergeState = checkPRMergeability(prUrl, topicSession.cwd)
    }

    // Auto-resolve merge conflicts if detected
    for (let conflictAttempt = 1; conflictAttempt <= maxRetries && mergeState === "CONFLICTING"; conflictAttempt++) {
      await this.telegram.sendMessage(
        formatCIResolvingConflicts(topicSession.slug, prUrl, conflictAttempt, maxRetries),
        topicSession.threadId,
      )

      log.info({ prUrl, conflictAttempt, maxRetries }, "spawning merge conflict resolution session")

      const conflictPrompt = buildMergeConflictPrompt(prUrl, conflictAttempt, maxRetries)
      topicSession.mode = "ci-fix"
      this.pushToConversation(topicSession, { role: "user", text: conflictPrompt })

      await new Promise<void>((resolve) => {
        this.spawnCIFixAgent(topicSession, conflictPrompt, () => resolve())
      })

      log.info({ prUrl, conflictAttempt, maxRetries }, "merge conflict resolution session completed")

      // Re-check mergeability after fix attempt
      mergeState = checkPRMergeability(prUrl, topicSession.cwd)
      if (mergeState === "UNKNOWN") {
        await new Promise((resolve) => setTimeout(resolve, 5_000))
        mergeState = checkPRMergeability(prUrl, topicSession.cwd)
      }

      if (mergeState === "CONFLICTING") {
        if (conflictAttempt < maxRetries) {
          log.warn({ prUrl, conflictAttempt }, "PR still has merge conflicts, retrying")
        } else {
          await this.telegram.sendMessage(
            formatCIConflicts(topicSession.slug, prUrl),
            topicSession.threadId,
          )
          log.warn({ prUrl, maxRetries }, "PR still has merge conflicts after max attempts, aborting")
          topicSession.mode = "task"
          return
        }
      }
    }

    if (mergeState !== "MERGEABLE") {
      // Couldn't determine mergeability — proceed cautiously
      log.warn({ prUrl }, "PR mergeability unknown, proceeding with CI watch")
    }

    const result = await waitForCI(prUrl, topicSession.cwd, this.config.ci)

    if (result.passed && localReport == null) {
      await this.telegram.sendMessage(
        formatCIPassed(topicSession.slug, prUrl),
        topicSession.threadId,
      )
      log.info({ prUrl }, "CI passed")
      return
    }

    if (result.timedOut && result.checks.length === 0 && localReport == null) {
      await this.telegram.sendMessage(
        formatCINoChecks(topicSession.slug, prUrl),
        topicSession.threadId,
      )
      log.info({ prUrl }, "no CI checks found, skipping babysit")
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

      log.info({ prUrl, attempt, maxRetries }, "spawning CI fix session")

      topicSession.mode = "ci-fix"
      this.pushToConversation(topicSession, { role: "user", text: fixPrompt })

      await new Promise<void>((resolve) => {
        this.spawnCIFixAgent(topicSession, fixPrompt, () => resolve())
      })

      log.info({ prUrl, attempt, maxRetries }, "CI fix session completed")

      // Re-run local quality gates after fix attempt
      let localFixed = true
      if (localReport != null) {
        try {
          localReport = runQualityGates(topicSession.cwd)
          localFixed = localReport.allPassed
          if (!localFixed) {
            log.warn({ prUrl, attempt }, "local quality gates still failing after fix attempt")
          } else {
            localReport = undefined
          }
        } catch (err) {
          log.error({ err, prUrl }, "quality gates re-check error")
        }
      }

      // Re-check for merge conflicts before polling CI again
      const retryMergeState = checkPRMergeability(prUrl, topicSession.cwd)
      if (retryMergeState === "CONFLICTING") {
        await this.telegram.sendMessage(
          formatCIConflicts(topicSession.slug, prUrl),
          topicSession.threadId,
        )
        log.warn({ prUrl, attempt }, "PR has merge conflicts after fix attempt, aborting")
        topicSession.mode = "task"
        return
      }

      const recheck = await waitForCI(prUrl, topicSession.cwd, this.config.ci)

      if (recheck.passed && localFixed) {
        await this.telegram.sendMessage(
          formatCIPassed(topicSession.slug, prUrl),
          topicSession.threadId,
        )
        log.info({ prUrl, attempt }, "CI passed after fix attempt")
        topicSession.mode = "task"
        return
      }

      const newFailed = recheck.checks.filter((c) => c.bucket === "fail")
      if (newFailed.length > failedChecks.length) {
        log.warn({ prUrl, from: failedChecks.length, to: newFailed.length }, "CI failures grew, aborting")
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
      log.warn("no session slots for CI fix, skipping")
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
          log.error({ err }, "CI fix onEvent error")
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
        }).catch(() => {}) // best effort

        this.observer.flushAndComplete(m, state, durationMs).then(() => {
          writeSessionLog(topicSession, m, state, durationMs)
          onComplete()
        }).catch(() => {
          onComplete()
        })
      },
      this.config.workspace.sessionTimeoutMs,
      this.config.workspace.sessionInactivityTimeoutMs,
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

    this.pushToConversation(topicSession, {
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
    } else if (topicSession.mode === "review") {
      await this.telegram.sendMessage(
        formatReviewIteration(topicSession.slug, iteration),
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

  private async notifyParentOfChildComplete(
    childSession: TopicSession,
    state: string,
  ): Promise<void> {
    if (!childSession.parentThreadId) return

    // If this child is part of a DAG, delegate to DAG completion handler
    if (childSession.dagId && childSession.dagNodeId) {
      await this.onDagChildComplete(childSession, state)
      return
    }

    const parent = this.topicSessions.get(childSession.parentThreadId)
    if (!parent) return

    const label = childSession.splitLabel ?? childSession.slug
    const prUrl = this.extractPRFromConversation(childSession) ?? undefined
    if (prUrl) childSession.prUrl = prUrl

    // Free child conversation memory
    childSession.conversation = []

    await this.telegram.sendMessage(
      formatSplitChildComplete(childSession.slug, state, label, prUrl),
      parent.threadId,
    )

    // Spawn next queued split item if any
    if (parent.pendingSplitItems && parent.pendingSplitItems.length > 0) {
      const nextItem = parent.pendingSplitItems.shift()!
      const allItems = parent.allSplitItems ?? [nextItem]
      const childThreadId = await this.spawnSplitChild(parent, nextItem, allItems)
      if (childThreadId) {
        parent.childThreadIds!.push(childThreadId)
      }
    }

    if (!parent.childThreadIds) return

    const allDone = parent.childThreadIds.every((id) => {
      const child = this.topicSessions.get(id)
      return !child || !child.activeSessionId
    })
    const hasPending = parent.pendingSplitItems && parent.pendingSplitItems.length > 0

    if (allDone && !hasPending) {
      let succeeded = 0
      for (const id of parent.childThreadIds) {
        const child = this.topicSessions.get(id)
        if (child) {
          const prFound = this.extractPRFromConversation(child)
          if (prFound) succeeded++
        }
      }

      await this.telegram.sendMessage(
        formatSplitAllDone(succeeded, parent.childThreadIds.length),
        parent.threadId,
      )
      await this.updateTopicTitle(parent, succeeded === parent.childThreadIds.length ? "✅" : "⚠️")

      // Run deferred CI babysitting sequentially
      await this.runDeferredBabysit(parent.threadId)
    }
  }

  private async handleSplitCommand(topicSession: TopicSession, directive?: string): Promise<void> {
    if (topicSession.activeSessionId) {
      const activeSession = this.sessions.get(topicSession.threadId)
      if (activeSession) await activeSession.handle.kill()
      this.sessions.delete(topicSession.threadId)
      topicSession.activeSessionId = undefined
    }

    await this.telegram.sendMessage(
      formatSplitAnalyzing(topicSession.slug),
      topicSession.threadId,
    )

    // Grace period: allow system resources to stabilize after session termination
    const GRACE_PERIOD_MS = 2000
    await new Promise((resolve) => setTimeout(resolve, GRACE_PERIOD_MS))

    const result = await extractSplitItems(topicSession.conversation, directive)

    if (result.error === "system") {
      await this.telegram.sendMessage(
        `⚠️ <b>System error</b> during extraction: <code>${result.errorMessage ?? "Unknown error"}</code>\n\n` +
        `This is likely a transient resource issue. Try <code>/split</code> again in a few seconds, ` +
        `or use <code>/execute</code> to proceed with a single task.`,
        topicSession.threadId,
      )
      return
    }

    if (result.items.length === 0) {
      await this.telegram.sendMessage(
        `⚠️ Could not extract discrete work items from the conversation. Try <code>/execute</code> instead.`,
        topicSession.threadId,
      )
      return
    }

    const items = result.items

    if (items.length === 1) {
      await this.telegram.sendMessage(
        `Only 1 item found — using <code>/execute</code> instead of splitting.`,
        topicSession.threadId,
      )
      await this.handleExecuteCommand(topicSession, items[0].description)
      return
    }

    const maxItems = this.config.workspace.maxSplitItems
    if (items.length > maxItems) {
      items.splice(maxItems)
    }

    // Close existing children before spawning new ones (handles both tracked and orphaned)
    await this.closeChildSessions(topicSession)
    topicSession.childThreadIds = []
    topicSession.allSplitItems = items.map(i => ({ title: i.title, description: i.description }))
    topicSession.pendingSplitItems = []

    // Spawn up to available slots; queue the rest
    const available = this.config.workspace.maxConcurrentSessions - this.sessions.size
    const toSpawnNow = items.slice(0, Math.max(1, available))
    const toQueue = items.slice(toSpawnNow.length)
    if (toQueue.length > 0) {
      topicSession.pendingSplitItems = toQueue.map(i => ({ title: i.title, description: i.description }))
    }

    const childSummaries: { repo: string; slug: string; title: string }[] = []

    for (const item of toSpawnNow) {
      const childThreadId = await this.spawnSplitChild(topicSession, item, items)
      if (childThreadId) {
        topicSession.childThreadIds!.push(childThreadId)
        const childSession = this.topicSessions.get(childThreadId)!
        childSummaries.push({
          repo: childSession.repo,
          slug: childSession.slug,
          title: item.title,
        })
      }
    }

    if (childSummaries.length === 0) {
      await this.telegram.sendMessage(
        `❌ Failed to spawn any sub-tasks. Try <code>/execute</code> instead.`,
        topicSession.threadId,
      )
      return
    }
    if (toQueue.length > 0) {
      await this.telegram.sendMessage(
        `⏳ Spawned ${childSummaries.length}/${items.length} items — ${toQueue.length} queued, will start as slots free up.`,
        topicSession.threadId,
      )
    }

    await this.telegram.sendMessage(
      formatSplitStart(topicSession.slug, childSummaries),
      topicSession.threadId,
    )

    await this.updateTopicTitle(topicSession, "🔀")
    await this.persistTopicSessions()
  }

  private async spawnSplitChild(
    parent: TopicSession,
    item: import("./split.js").SplitItem,
    allItems: import("./split.js").SplitItem[],
  ): Promise<number | null> {
    const sessionId = crypto.randomUUID()
    const slug = generateSlug(sessionId)
    const repo = parent.repo
    const topicName = `⚡ ${repo} · ${slug}`

    let topic: { message_thread_id: number }
    try {
      topic = await this.telegram.createForumTopic(topicName)
    } catch (err) {
      log.error({ err }, "failed to create child topic for split")
      captureException(err, { operation: "createForumTopic", parentSlug: parent.slug })
      return null
    }

    const threadId = topic.message_thread_id

    const cwd = await this.prepareWorkspace(slug, parent.repoUrl)
    if (!cwd) {
      await this.telegram.sendMessage(`❌ Failed to prepare workspace.`, threadId)
      await this.telegram.deleteForumTopic(threadId)
      return null
    }

    const task = buildSplitChildPrompt(parent.conversation, item, allItems)

    const childSession: TopicSession = {
      threadId,
      repo,
      repoUrl: parent.repoUrl,
      cwd,
      slug,
      conversation: [{ role: "user", text: task }],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      profileId: parent.profileId,
      parentThreadId: parent.threadId,
      splitLabel: item.title,
      branch: parent.repoUrl ? `minion/${slug}` : undefined,
    }

    this.topicSessions.set(threadId, childSession)
    this.broadcastSession(childSession, "session_created")

    await this.spawnTopicAgent(childSession, task, { browserEnabled: false })
    return threadId
  }

  // ── DAG / Stack commands ──────────────────────────────────────────

  private async handleStackCommand(topicSession: TopicSession, directive?: string): Promise<void> {
    if (topicSession.activeSessionId) {
      const activeSession = this.sessions.get(topicSession.threadId)
      if (activeSession) await activeSession.handle.kill()
      this.sessions.delete(topicSession.threadId)
      topicSession.activeSessionId = undefined
    }

    await this.telegram.sendMessage(
      formatStackAnalyzing(topicSession.slug),
      topicSession.threadId,
    )

    const GRACE_PERIOD_MS = 2000
    await new Promise((resolve) => setTimeout(resolve, GRACE_PERIOD_MS))

    const profile = topicSession.profileId ? this.profileStore.get(topicSession.profileId) : undefined
    const result = await extractStackItems(topicSession.conversation, directive, profile)

    if (result.error === "system") {
      await this.telegram.sendMessage(
        `⚠️ <b>System error</b> during extraction: <code>${result.errorMessage ?? "Unknown error"}</code>\n\n` +
        `Try <code>/stack</code> again, or use <code>/execute</code> for a single task.`,
        topicSession.threadId,
      )
      return
    }

    if (result.items.length === 0) {
      await this.telegram.sendMessage(
        `⚠️ Could not extract sequential work items. Try <code>/execute</code> instead.`,
        topicSession.threadId,
      )
      return
    }

    if (result.items.length === 1) {
      await this.telegram.sendMessage(
        `Only 1 item found — using <code>/execute</code> instead.`,
        topicSession.threadId,
      )
      await this.handleExecuteCommand(topicSession, result.items[0].description)
      return
    }

    await this.startDag(topicSession, result.items, true)
  }

  private async handleDagCommand(topicSession: TopicSession, directive?: string): Promise<void> {
    if (topicSession.activeSessionId) {
      const activeSession = this.sessions.get(topicSession.threadId)
      if (activeSession) await activeSession.handle.kill()
      this.sessions.delete(topicSession.threadId)
      topicSession.activeSessionId = undefined
    }

    await this.telegram.sendMessage(
      formatDagAnalyzing(topicSession.slug),
      topicSession.threadId,
    )

    const GRACE_PERIOD_MS = 2000
    await new Promise((resolve) => setTimeout(resolve, GRACE_PERIOD_MS))

    const profile = topicSession.profileId ? this.profileStore.get(topicSession.profileId) : undefined
    const result = await extractDagItems(topicSession.conversation, directive, profile)

    if (result.error === "system") {
      await this.telegram.sendMessage(
        `⚠️ <b>System error</b> during extraction: <code>${result.errorMessage ?? "Unknown error"}</code>\n\n` +
        `Try <code>/dag</code> again, or use <code>/split</code> for parallel tasks.`,
        topicSession.threadId,
      )
      return
    }

    if (result.items.length === 0) {
      await this.telegram.sendMessage(
        `⚠️ Could not extract work items with dependencies. Try <code>/split</code> or <code>/execute</code> instead.`,
        topicSession.threadId,
      )
      return
    }

    if (result.items.length === 1) {
      await this.telegram.sendMessage(
        `Only 1 item found — using <code>/execute</code> instead.`,
        topicSession.threadId,
      )
      await this.handleExecuteCommand(topicSession, result.items[0].description)
      return
    }

    await this.startDag(topicSession, result.items, false)
  }

  /**
   * Build a DAG graph and start scheduling nodes.
   */
  private async startDag(
    topicSession: TopicSession,
    items: DagInput[],
    isStack: boolean,
  ): Promise<void> {
    const dagId = `dag-${topicSession.slug}`

    let graph: DagGraph
    try {
      graph = buildDag(dagId, items, topicSession.threadId, topicSession.repo, topicSession.repoUrl)
    } catch (err) {
      await this.telegram.sendMessage(
        `❌ <b>Invalid DAG</b>: <code>${err instanceof Error ? err.message : String(err)}</code>`,
        topicSession.threadId,
      )
      return
    }

    // Close existing children before spawning new DAG
    await this.closeChildSessions(topicSession)
    topicSession.childThreadIds = []
    topicSession.dagId = dagId

    this.dags.set(dagId, graph)
    this.broadcastDag(graph, "dag_created")

    // Send DAG overview
    const childSummaries = graph.nodes.map((n) => ({
      slug: n.id,
      title: n.title,
      dependsOn: n.dependsOn,
    }))

    await this.telegram.sendMessage(
      formatDagStart(topicSession.slug, childSummaries, isStack),
      topicSession.threadId,
    )
    await this.updateTopicTitle(topicSession, isStack ? "📚" : "🔗")

    // Start scheduling ready nodes
    await this.scheduleDagNodes(topicSession, graph, isStack)
    await this.persistTopicSessions()
  }

  /**
   * Schedule all ready nodes in the DAG for execution.
   * Called initially and after each node completes.
   */
  private async scheduleDagNodes(
    topicSession: TopicSession,
    graph: DagGraph,
    isStack: boolean,
  ): Promise<void> {
    const ready = readyNodes(graph)

    for (const node of ready) {
      const runningDagNodes = graph.nodes.filter(n => n.status === "running").length
      const dagSlots = this.config.workspace.maxDagConcurrency - runningDagNodes
      const globalSlots = this.config.workspace.maxConcurrentSessions - this.sessions.size
      const available = Math.min(dagSlots, globalSlots)
      if (available <= 0) {
        log.warn({ dagId: graph.id, nodeId: node.id }, "no session slots for DAG node, will retry when a slot opens")
        break
      }

      node.status = "running"

      const threadId = await this.spawnDagChild(topicSession, graph, node, isStack)
      if (threadId) {
        node.threadId = threadId
        topicSession.childThreadIds!.push(threadId)
      } else {
        const skipped = failNode(graph, node.id)
        node.error = "Failed to spawn child session"

        await this.telegram.sendMessage(
          formatDagNodeSkipped(node.title, "Failed to spawn session"),
          topicSession.threadId,
        )

        if (skipped.length > 0) {
          for (const skippedId of skipped) {
            const skippedNode = graph.nodes.find((n) => n.id === skippedId)!
            await this.telegram.sendMessage(
              formatDagNodeSkipped(skippedNode.title, `upstream "${node.id}" failed`),
              topicSession.threadId,
            )
          }
        }
      }
    }
  }

  /**
   * Spawn a single DAG child session.
   */
  private async spawnDagChild(
    parent: TopicSession,
    graph: DagGraph,
    node: DagNode,
    isStack: boolean,
  ): Promise<number | null> {
    const sessionId = crypto.randomUUID()
    const slug = generateSlug(sessionId)
    const repo = parent.repo
    const topicName = `${isStack ? "📚" : "🔗"} ${repo} · ${slug}`

    let topic: { message_thread_id: number }
    try {
      topic = await this.telegram.createForumTopic(topicName)
    } catch (err) {
      log.error({ err }, "failed to create DAG child topic")
      captureException(err, { operation: "createForumTopic", parentSlug: parent.slug, dagNode: node.id })
      return null
    }

    const threadId = topic.message_thread_id

    // Determine the start branch for this node
    const upstreamBranches = getUpstreamBranches(graph, node.id)
    let startBranch: string | undefined

    if (upstreamBranches.length === 1) {
      startBranch = upstreamBranches[0]
    } else if (upstreamBranches.length > 1) {
      // Fan-in: need to merge upstream branches
      const fanInBranch = await this.prepareFanInBranch(slug, parent.repoUrl!, upstreamBranches)
      if (!fanInBranch) {
        await this.telegram.sendMessage(
          `❌ Merge conflict detected when combining upstream branches for <b>${node.title}</b>.`,
          threadId,
        )
        await this.telegram.deleteForumTopic(threadId)
        return null
      }
      startBranch = fanInBranch
    }

    const cwd = await this.prepareWorkspace(slug, parent.repoUrl, startBranch)
    if (!cwd) {
      await this.telegram.sendMessage(`❌ Failed to prepare workspace.`, threadId)
      await this.telegram.deleteForumTopic(threadId)
      return null
    }

    // For fan-in with multiple branches, merge remaining branches into the worktree
    if (upstreamBranches.length > 1 && startBranch) {
      const additionalBranches = upstreamBranches.filter((b) => b !== startBranch)
      if (additionalBranches.length > 0) {
        const mergeOk = this.mergeUpstreamBranches(cwd, additionalBranches)
        if (!mergeOk) {
          await this.telegram.sendMessage(
            `❌ Merge conflict when combining upstream branches for <b>${node.title}</b>.`,
            threadId,
          )
          await this.telegram.deleteForumTopic(threadId)
          await this.removeWorkspace({ cwd, repoUrl: parent.repoUrl } as TopicSession).catch(() => {})
          return null
        }
      }
    }

    const branch = `minion/${slug}`
    node.branch = branch

    const task = buildDagChildPrompt(
      parent.conversation,
      { id: node.id, title: node.title, description: node.description, dependsOn: node.dependsOn },
      graph.nodes.map((n) => ({ id: n.id, title: n.title, description: n.description, dependsOn: n.dependsOn })),
      upstreamBranches,
      isStack,
    )

    const childSession: TopicSession = {
      threadId,
      repo,
      repoUrl: parent.repoUrl,
      cwd,
      slug,
      conversation: [{ role: "user", text: task }],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      profileId: parent.profileId,
      parentThreadId: parent.threadId,
      splitLabel: node.title,
      branch: parent.repoUrl ? `minion/${slug}` : undefined,
      dagId: graph.id,
      dagNodeId: node.id,
    }

    this.topicSessions.set(threadId, childSession)
    this.broadcastSession(childSession, "session_created")

    await this.telegram.sendMessage(
      formatDagNodeStarting(node.title, node.id, slug),
      parent.threadId,
    )

    await this.spawnTopicAgent(childSession, task, { browserEnabled: false })
    return threadId
  }

  /**
   * Called when a DAG child session completes.
   * Advances the DAG and schedules newly ready nodes.
   */
  private async onDagChildComplete(
    childSession: TopicSession,
    state: string,
  ): Promise<void> {
    if (!childSession.dagId || !childSession.dagNodeId) return

    const graph = this.dags.get(childSession.dagId)
    if (!graph) return

    const node = graph.nodes.find((n) => n.id === childSession.dagNodeId)
    if (!node) return

    const parent = this.topicSessions.get(graph.parentThreadId)
    if (!parent) return

    const prUrl = this.extractPRFromConversation(childSession) ?? undefined
    if (prUrl) childSession.prUrl = prUrl

    // Free child conversation memory immediately — we've extracted everything we need
    childSession.conversation = []

    if (state === "errored" || state === "failed") {
      const skipped = failNode(graph, node.id)
      node.error = "Session errored"

      const progress = dagProgress(graph)
      await this.telegram.sendMessage(
        formatDagNodeComplete(childSession.slug, state, node.title, prUrl, {
          done: progress.done,
          total: progress.total,
          running: progress.running,
        }),
        parent.threadId,
      )

      for (const skippedId of skipped) {
        const skippedNode = graph.nodes.find((n) => n.id === skippedId)!
        await this.telegram.sendMessage(
          formatDagNodeSkipped(skippedNode.title, `upstream "${node.id}" failed`),
          parent.threadId,
        )
      }
    } else {
      let resolvedPrUrl = prUrl
      if (!resolvedPrUrl && node.branch) {
        resolvedPrUrl = findPRByBranch(node.branch, childSession.cwd) ?? undefined
      }

      if (!resolvedPrUrl && !node.recoveryAttempted) {
        node.recoveryAttempted = true

        await this.telegram.sendMessage(
          `⚠️ <b>${esc(childSession.slug)}</b> completed without a PR — spawning recovery session…`,
          parent.threadId,
        )

        const recoveryTask = [
          `## Recovery task`,
          `The previous session was assigned: "${node.title}"`,
          node.description ? `\nDescription: ${node.description}` : "",
          `\nIt completed without opening a pull request. Check the workspace, fix any issues, and create a PR.`,
        ].join("\n")

        childSession.conversation = [{ role: "user", text: recoveryTask }]
        await this.spawnTopicAgent(childSession, recoveryTask, undefined, DEFAULT_RECOVERY_PROMPT)
        await this.persistTopicSessions()
        return
      }

      if (!resolvedPrUrl) {
        const skipped = failNode(graph, node.id)
        node.error = "Completed without opening a PR"

        const progress = dagProgress(graph)
        await this.telegram.sendMessage(
          formatDagNodeComplete(childSession.slug, "failed", node.title, undefined, {
            done: progress.done,
            total: progress.total,
            running: progress.running,
          }),
          parent.threadId,
        )

        for (const skippedId of skipped) {
          const skippedNode = graph.nodes.find((n) => n.id === skippedId)!
          await this.telegram.sendMessage(
            formatDagNodeSkipped(skippedNode.title, `upstream "${node.id}" completed without PR`),
            parent.threadId,
          )
        }
      } else {
        node.status = "done"
        node.prUrl = resolvedPrUrl

        const progress = dagProgress(graph)
        await this.telegram.sendMessage(
          formatDagNodeComplete(childSession.slug, state, node.title, resolvedPrUrl, {
            done: progress.done,
            total: progress.total,
            running: progress.running,
          }),
          parent.threadId,
        )

        const newlyReady = advanceDag(graph)
        if (newlyReady.length > 0) {
          const isStack = !graph.nodes.some((n) => n.dependsOn.length > 1) &&
            graph.nodes.every((n, i) => i === 0 || n.dependsOn.length === 1)
          await this.scheduleDagNodes(parent, graph, isStack)
        }
      }
    }

    this.broadcastDag(graph, "dag_updated")

    // Update DAG section in all PR descriptions
    await this.updateDagPRDescriptions(graph, childSession.cwd)

    // Check if DAG is complete
    if (isDagComplete(graph)) {
      const progress = dagProgress(graph)
      await this.telegram.sendMessage(
        formatDagAllDone(progress.done, progress.total, progress.failed),
        parent.threadId,
      )

      await this.runDeferredBabysit(parent.threadId)

      if (progress.failed > 0) {
        await this.updateTopicTitle(parent, "⚠️")
        await this.telegram.sendMessage(
          `Send <code>/retry</code> to retry all failed nodes, or <code>/retry node-id</code> for a specific one. <code>/close</code> to finish.`,
          parent.threadId,
        )
      } else {
        await this.updateTopicTitle(parent, "✅")
        await this.closeChildSessions(parent)
      }
    }

    await this.persistTopicSessions()
  }

  /**
   * Update all DAG child PRs with the current DAG graph rendering.
   * Uses idempotent HTML comment markers so repeated calls replace rather than append.
   */
  private async updateDagPRDescriptions(graph: DagGraph, cwd: string): Promise<void> {
    const nodesWithPRs = graph.nodes.filter((n) => n.prUrl)
    if (nodesWithPRs.length === 0) return

    for (const node of nodesWithPRs) {
      try {
        const dagSection = renderDagForGitHub(graph, node.id)

        const currentBody = execSync(
          `gh pr view ${JSON.stringify(node.prUrl!)} --json body --jq .body`,
          { cwd, stdio: ["pipe", "pipe", "pipe"], timeout: 30_000, env: { ...process.env } },
        ).toString()

        const newBody = upsertDagSection(currentBody, dagSection)

        execSync(
          `gh pr edit ${JSON.stringify(node.prUrl!)} --body-file -`,
          { input: newBody, cwd, stdio: ["pipe", "pipe", "pipe"], timeout: 30_000, env: { ...process.env } },
        )
      } catch (err) {
        log.error({ err, prUrl: node.prUrl }, "failed to update DAG section in PR")
      }
    }
  }

  private async handleRetryCommand(topicSession: TopicSession, nodeId?: string): Promise<void> {
    if (!topicSession.dagId) {
      await this.telegram.sendMessage("⚠️ /retry only works in DAG parent threads.", topicSession.threadId)
      return
    }

    const graph = this.dags.get(topicSession.dagId)
    if (!graph) return

    const failedNodes = nodeId
      ? graph.nodes.filter((n) => n.id === nodeId && n.status === "failed")
      : graph.nodes.filter((n) => n.status === "failed")

    if (failedNodes.length === 0) {
      await this.telegram.sendMessage("No failed nodes to retry.", topicSession.threadId)
      return
    }

    for (const node of failedNodes) {
      resetFailedNode(graph, node.id)

      const childSession = [...this.topicSessions.values()].find(
        (s) => s.dagId === graph.id && s.dagNodeId === node.id,
      )

      if (childSession) {
        const retryTask = [
          `## Retry task`,
          `Previous attempt failed: ${node.error ?? "unknown reason"}`,
          `\nOriginal task: "${node.title}"`,
          node.description ? `\nDescription: ${node.description}` : "",
          `\nCheck the workspace, fix any issues, and create a PR.`,
        ].join("\n")

        childSession.conversation = [{ role: "user", text: retryTask }]
        node.status = "running"
        await this.spawnTopicAgent(childSession, retryTask, undefined, DEFAULT_RECOVERY_PROMPT)

        await this.telegram.sendMessage(
          `🔄 Retrying <b>${esc(node.title)}</b> (<code>${esc(node.id)}</code>)`,
          topicSession.threadId,
        )
      } else {
        const isStack = !graph.nodes.some((n) => n.dependsOn.length > 1) &&
          graph.nodes.every((n, i) => i === 0 || n.dependsOn.length === 1)
        await this.scheduleDagNodes(topicSession, graph, isStack)
      }
    }

    await this.updateDagPRDescriptions(graph, topicSession.cwd)
    await this.persistTopicSessions()
  }

  /**
   * Handle /land command — merge completed DAG PRs in topological order.
   */
  private async handleLandCommand(topicSession: TopicSession): Promise<void> {
    if (!topicSession.dagId) {
      // Fallback: check if this is a split parent with child PRs
      if (!topicSession.childThreadIds || topicSession.childThreadIds.length === 0) {
        await this.telegram.sendMessage(
          `⚠️ No DAG or stack found for this session. Use <code>/stack</code> or <code>/dag</code> first.`,
          topicSession.threadId,
        )
        return
      }
    }

    const graph = topicSession.dagId ? this.dags.get(topicSession.dagId) : undefined

    if (graph) {
      await this.landDag(topicSession, graph)
    } else {
      await this.landChildPRs(topicSession)
    }
  }

  /**
   * Land a DAG by merging PRs in topological order.
   */
  private async landDag(topicSession: TopicSession, graph: DagGraph): Promise<void> {
    const sorted = topologicalSort(graph)
    const prNodes = sorted
      .map((id) => graph.nodes.find((n) => n.id === id)!)
      .filter((n) => n.status === "done" && n.prUrl)

    if (prNodes.length === 0) {
      await this.telegram.sendMessage(
        `⚠️ No completed PRs to land.`,
        topicSession.threadId,
      )
      return
    }

    await this.telegram.sendMessage(
      formatLandStart(topicSession.slug, prNodes.length),
      topicSession.threadId,
    )

    let succeeded = 0
    const gitOpts = { stdio: ["pipe" as const, "pipe" as const, "pipe" as const], timeout: 60_000 }

    for (const node of prNodes) {
      try {
        // Merge the PR with squash
        execSync(
          `gh pr merge ${JSON.stringify(node.prUrl!)} --squash`,
          { ...gitOpts, cwd: topicSession.cwd, env: { ...process.env } },
        )
        succeeded++

        await this.telegram.sendMessage(
          formatLandProgress(node.title, node.prUrl!, succeeded - 1, prNodes.length),
          topicSession.threadId,
        )

        // Brief pause for GitHub to process the merge and retarget downstream PRs
        await new Promise((resolve) => setTimeout(resolve, 3000))
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        await this.telegram.sendMessage(
          formatLandError(node.title, errMsg),
          topicSession.threadId,
        )
        break
      }
    }

    await this.telegram.sendMessage(
      formatLandComplete(succeeded, prNodes.length),
      topicSession.threadId,
    )
  }

  /**
   * Land child PRs (for split sessions without a DAG).
   */
  private async landChildPRs(topicSession: TopicSession): Promise<void> {
    if (!topicSession.childThreadIds) return

    const prUrls: { title: string; prUrl: string }[] = []
    for (const childId of topicSession.childThreadIds) {
      const child = this.topicSessions.get(childId)
      if (child) {
        const prUrl = this.extractPRFromConversation(child)
        if (prUrl) {
          prUrls.push({ title: child.splitLabel ?? child.slug, prUrl })
        }
      }
    }

    if (prUrls.length === 0) {
      await this.telegram.sendMessage(
        `⚠️ No PRs found among child sessions.`,
        topicSession.threadId,
      )
      return
    }

    await this.telegram.sendMessage(
      formatLandStart(topicSession.slug, prUrls.length),
      topicSession.threadId,
    )

    let succeeded = 0
    const gitOpts = { stdio: ["pipe" as const, "pipe" as const, "pipe" as const], timeout: 60_000 }
    const anyCwd = topicSession.cwd || this.topicSessions.get(topicSession.childThreadIds[0])?.cwd

    for (const { title, prUrl } of prUrls) {
      try {
        execSync(
          `gh pr merge ${JSON.stringify(prUrl)} --squash`,
          { ...gitOpts, cwd: anyCwd, env: { ...process.env } },
        )
        succeeded++

        await this.telegram.sendMessage(
          formatLandProgress(title, prUrl, succeeded - 1, prUrls.length),
          topicSession.threadId,
        )

        await new Promise((resolve) => setTimeout(resolve, 3000))
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        await this.telegram.sendMessage(
          formatLandError(title, errMsg),
          topicSession.threadId,
        )
        break
      }
    }

    await this.telegram.sendMessage(
      formatLandComplete(succeeded, prUrls.length),
      topicSession.threadId,
    )
  }

  /**
   * Close all children of a parent session.
   * Handles both tracked children (in childThreadIds) and orphaned children (pointing via parentThreadId).
   */
  private async closeChildSessions(parent: TopicSession): Promise<void> {
    const childrenToClose = new Map<number, TopicSession>()

    // Collect tracked children
    if (parent.childThreadIds) {
      for (const childId of parent.childThreadIds) {
        const child = this.topicSessions.get(childId)
        if (child) childrenToClose.set(childId, child)
      }
    }

    // Also collect orphaned children that still point to this parent
    for (const [candidateId, candidate] of this.topicSessions) {
      if (candidate.parentThreadId === parent.threadId && !childrenToClose.has(candidateId)) {
        childrenToClose.set(candidateId, candidate)
      }
    }

    await Promise.all([...childrenToClose.values()].map((child) => this.closeSingleChild(child)))

    parent.childThreadIds = []
  }

  private async closeSingleChild(child: TopicSession): Promise<void> {
    const childId = child.threadId

    if (child.activeSessionId) {
      const childActive = this.sessions.get(childId)
      this.sessions.delete(childId)
      if (childActive) await childActive.handle.kill().catch(() => {})
    }
    this.topicSessions.delete(childId)
    this.broadcastSessionDeleted(child.slug)
    await this.telegram.deleteForumTopic(childId).catch(() => {})
    await this.removeWorkspace(child).catch(() => {})
    log.info({ slug: child.slug, threadId: childId }, "closed child topic")
  }

  private async handleCloseCommandInternal(topicSession: TopicSession): Promise<void> {
    const threadId = topicSession.threadId

    // Cascade close to children first (handles both tracked and orphaned)
    await this.closeChildSessions(topicSession)

    // Clean up DAG graph if this parent had one (keeps PR URLs alive until /close)
    if (topicSession.dagId) {
      this.broadcastDagDeleted(topicSession.dagId)
      this.dags.delete(topicSession.dagId)
    }

    // Remove from tracking and delete the topic first for instant user feedback
    this.topicSessions.delete(threadId)
    this.broadcastSessionDeleted(topicSession.slug)
    await this.persistTopicSessions()
    this.updatePinnedSummary()
    await this.telegram.deleteForumTopic(threadId)
    log.info({ slug: topicSession.slug, threadId }, "closed and deleted topic")

    // Kill process and clean up workspace in background (non-blocking)
    if (topicSession.activeSessionId) {
      const activeSession = this.sessions.get(threadId)
      this.sessions.delete(threadId)
      if (activeSession) {
        activeSession.handle.kill().then(
          () => this.removeWorkspace(topicSession),
          () => this.removeWorkspace(topicSession),
        ).catch((err) => {
          log.error({ err, slug: topicSession.slug }, "background cleanup failed")
        })
        return
      }
    }

    this.removeWorkspace(topicSession).catch((err) => {
      log.error({ err, slug: topicSession.slug }, "background cleanup failed")
    })
  }

  private async handleStopCommandInternal(topicSession: TopicSession): Promise<void> {
    const threadId = topicSession.threadId

    // Only act if there's an active session
    if (!topicSession.activeSessionId) {
      await this.telegram.sendMessage(
        `⚠️ No active session to stop.`,
        threadId,
      )
      return
    }

    const activeSession = this.sessions.get(threadId)
    if (activeSession) {
      this.sessions.delete(threadId)
      await activeSession.handle.kill()  // graceful kill with SIGINT → SIGKILL escalation
    }

    // Clear the active session ID but preserve everything else
    topicSession.activeSessionId = undefined
    topicSession.pendingFeedback = []
    this.persistTopicSessions()

    await this.telegram.sendMessage(
      `⏹️ Session stopped. Send <b>/reply</b> to continue.`,
      threadId,
    )
    log.info({ slug: topicSession.slug, threadId }, "stopped session")
  }

  // Wrapper methods for extracted session-manager functions
  private async prepareWorkspace(slug: string, repoUrl?: string, startBranch?: string): Promise<string | null> {
    return prepareWorkspace(slug, this.config.workspace.root, repoUrl, startBranch)
  }

  private async removeWorkspace(topicSession: TopicSession): Promise<void> {
    return removeWorkspace(topicSession, this.config.workspace.root)
  }

  private cleanBuildArtifacts(cwd: string): void {
    cleanBuildArtifacts(cwd)
  }

  private async prepareFanInBranch(slug: string, repoUrl: string, upstreamBranches: string[]): Promise<string | null> {
    return prepareFanInBranch(slug, repoUrl, upstreamBranches, this.config.workspace.root)
  }

  private async downloadPhotos(photos: TelegramPhotoSize[] | undefined, _cwd: string): Promise<string[]> {
    return downloadPhotos(photos, this.telegram)
  }

  private mergeUpstreamBranches(workDir: string, additionalBranches: string[]): boolean {
    return mergeUpstreamBranches(workDir, additionalBranches)
  }

  activeSessions(): number {
    return this.sessions.size
  }

  // API server accessors
  getSessions(): Map<number, { handle: SessionHandle; meta: SessionMeta; task: string }> {
    return this.sessions
  }

  getTopicSessions(): Map<number, TopicSession> {
    return this.topicSessions
  }

  getDags(): Map<string, DagGraph> {
    return this.dags
  }

  getSessionState(threadId: number): SessionState | undefined {
    const session = this.sessions.get(threadId)
    return session?.handle.getState()
  }

  async apiSendReply(threadId: number, message: string): Promise<void> {
    const topicSession = this.topicSessions.get(threadId)
    if (!topicSession) {
      throw new SessionNotFoundError(threadId, Array.from(this.topicSessions.keys()))
    }

    // Queue the message for the session to pick up
    topicSession.pendingFeedback.push(message)

    // Note: If there's no active session, the message will be queued
    // and processed when the user sends another /reply command
    // This is a limitation of the current architecture
  }

  apiStopSession(threadId: number): void {
    const session = this.sessions.get(threadId)
    if (session) {
      session.handle.interrupt()
    }
  }

  async apiCloseSession(threadId: number): Promise<void> {
    const topicSession = this.topicSessions.get(threadId)
    if (!topicSession) {
      throw new SessionNotFoundError(threadId, Array.from(this.topicSessions.keys()))
    }

    // Stop any active session
    const activeSession = this.sessions.get(threadId)
    if (activeSession) {
      activeSession.handle.interrupt()
      this.sessions.delete(threadId)
    }

    // Delete the topic
    await this.telegram.deleteForumTopic(threadId)
    await this.removeWorkspace(topicSession)
    this.topicSessions.delete(threadId)
    this.broadcastSessionDeleted(topicSession.slug)
    await this.persistTopicSessions()
    this.updatePinnedSummary()
  }
}

