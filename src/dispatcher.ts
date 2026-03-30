import { execSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import crypto from "node:crypto"
import type { TelegramClient } from "./telegram.js"
import { captureException } from "./sentry.js"
import { SessionHandle, type SessionConfig } from "./session.js"
import { Observer } from "./observer.js"
import type { TelegramUpdate, TelegramCallbackQuery, TelegramPhotoSize, SessionMeta, TopicSession, SessionMode, SessionState, TopicMessage, AutoAdvance } from "./types.js"
import { generateSlug, taskToLabel } from "./slugs.js"
import type { MinionConfig, McpConfig } from "./config-types.js"
import { DEFAULT_PROMPTS } from "./prompts.js"
import { SessionStore } from "./store.js"
import { ProfileStore } from "./profile-store.js"
import {
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
  formatProfileList,
  formatConfigHelp,
  formatDagAnalyzing,
  formatPinnedStatus,
} from "./format.js"
import { runQualityGates } from "./quality-gates.js"
import { StatsTracker } from "./stats.js"
import { fetchClaudeUsage } from "./claude-usage.js"
import { writeSessionLog } from "./session-log.js"
import { extractPRUrl } from "./ci-babysit.js"
import { buildConversationDigest } from "./conversation-digest.js"
import { truncateConversation } from "./conversation-limits.js"
import { DEFAULT_CI_FIX_PROMPT } from "./prompts.js"
import { StateBroadcaster, topicSessionToApi, dagToApi } from "./api-server.js"
import { loggers } from "./logger.js"
import { SessionNotFoundError } from "./errors.js"
import {
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
import { extractDagItems } from "./dag/dag-extract.js"
import { buildSplitChildPrompt } from "./split.js"
import type { DagGraph } from "./dag/dag.js"
import type { DispatcherContext } from "./dispatcher-context.js"
import { CIBabysitter } from "./ci-babysitter.js"
import { LandingManager } from "./landing-manager.js"
import { DagOrchestrator } from "./dag/dag-orchestrator.js"
import { ShipPipeline } from "./ship-pipeline.js"
import { SplitOrchestrator } from "./split-orchestrator.js"
import { PinnedMessageManager } from "./pinned-message-manager.js"
import { routeCommand } from "./command-router.js"

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
  private readonly broadcaster?: StateBroadcaster
  private offset = 0
  private running = false
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private readonly stats: StatsTracker

  private readonly ciBabysitter: CIBabysitter
  private readonly landingManager: LandingManager
  private readonly dagOrchestrator: DagOrchestrator
  private readonly shipPipeline: ShipPipeline
  private readonly splitOrchestrator: SplitOrchestrator
  private readonly pinnedMessages: PinnedMessageManager

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

    const ctx = this.buildContext()
    this.ciBabysitter = new CIBabysitter(ctx)
    this.landingManager = new LandingManager(ctx)
    this.dagOrchestrator = new DagOrchestrator(ctx)
    this.shipPipeline = new ShipPipeline(ctx)
    this.splitOrchestrator = new SplitOrchestrator(ctx)
    this.pinnedMessages = new PinnedMessageManager({
      telegram: this.telegram,
      topicSessions: this.topicSessions,
      workspaceRoot: this.config.workspace.root,
      chatId: this.config.telegram.chatId,
    })
  }

  private buildContext(): DispatcherContext {
    return {
      config: this.config,
      telegram: this.telegram,
      observer: this.observer,
      stats: this.stats,
      profileStore: this.profileStore,
      broadcaster: this.broadcaster,
      sessions: this.sessions,
      topicSessions: this.topicSessions,
      dags: this.dags,
      spawnTopicAgent: (ts, task, mcp, sp) => this.spawnTopicAgent(ts, task, mcp, sp),
      spawnCIFixAgent: (ts, task, cb) => this.spawnCIFixAgent(ts, task, cb),
      prepareWorkspace: (slug, repo, branch) => this.prepareWorkspace(slug, repo, branch),
      removeWorkspace: (ts) => this.removeWorkspace(ts),
      cleanBuildArtifacts: (cwd) => this.cleanBuildArtifacts(cwd),
      prepareFanInBranch: (slug, repo, branches) => this.prepareFanInBranch(slug, repo, branches),
      mergeUpstreamBranches: (dir, branches) => this.mergeUpstreamBranches(dir, branches),
      downloadPhotos: (photos, cwd) => this.downloadPhotos(photos, cwd),
      pushToConversation: (s, m) => this.pushToConversation(s, m),
      extractPRFromConversation: (ts) => this.extractPRFromConversation(ts),
      persistTopicSessions: (mark) => this.persistTopicSessions(mark),
      updatePinnedSummary: () => this.pinnedMessages.updatePinnedSummary(),
      updateTopicTitle: (ts, emoji) => this.pinnedMessages.updateTopicTitle(ts, emoji),
      pinThreadMessage: (s, html) => this.pinnedMessages.pinThreadMessage(s, html),
      updatePinnedSplitStatus: (p) => this.pinnedMessages.updatePinnedSplitStatus(p),
      updatePinnedDagStatus: (p, g) => this.pinnedMessages.updatePinnedDagStatus(p, g),
      broadcastSession: (s, e, st) => this.broadcastSession(s, e, st),
      broadcastSessionDeleted: (slug) => this.broadcastSessionDeleted(slug),
      broadcastDag: (g, e) => this.broadcastDag(g, e),
      broadcastDagDeleted: (id) => this.broadcastDagDeleted(id),
      closeChildSessions: (p) => this.closeChildSessions(p),
      closeSingleChild: (c) => this.closeSingleChild(c),
      startDag: (ts, items, isStack) => this.dagOrchestrator.startDag(ts, items, isStack),
      shipAdvanceToVerification: (ts, g) => this.shipPipeline.shipAdvanceToVerification(ts, g),
      handleLandCommand: (ts) => this.landingManager.handleLandCommand(ts),
      handleShipAdvance: (ts) => this.shipPipeline.handleShipAdvance(ts),
      handleExecuteCommand: (ts, d) => this.handleExecuteCommand(ts, d),
      notifyParentOfChildComplete: (cs, s) => this.notifyParentOfChildComplete(cs, s),
      postSessionDigest: (ts, pr) => this.postSessionDigest(ts, pr),
      runDeferredBabysit: (id) => this.ciBabysitter.runDeferredBabysit(id),
      babysitPR: (ts, pr, qr) => this.ciBabysitter.babysitPR(ts, pr, qr),
      babysitDagChildCI: (cs, pr) => this.ciBabysitter.babysitDagChildCI(cs, pr),
      updateDagPRDescriptions: (g, cwd) => this.dagOrchestrator.updateDagPRDescriptions(g, cwd),
      scheduleDagNodes: (ts, g, isStack) => this.dagOrchestrator.scheduleDagNodes(ts, g, isStack),
      spawnSplitChild: (p, item, all) => this.spawnSplitChild(p, item, all),
      spawnDagChild: (p, g, n, s) => this.dagOrchestrator.spawnDagChild(p, g, n, s),
    }
  }

  // ── Conversation & broadcast helpers ──────────────────────────────────

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

  // ── Session persistence & lifecycle ───────────────────────────────────

  async loadPersistedSessions(): Promise<void> {
    const { active, expired, offset } = await this.store.load()
    this.offset = offset

    for (const [threadId, session] of active) {
      this.topicSessions.set(threadId, session)

      if (session.interruptedAt) {
        log.info({ slug: session.slug, threadId }, "session was interrupted, notifying")
        this.telegram.sendMessage(
          `⚡ This session was interrupted by a deploy. Send <b>/reply</b> to continue.`,
          threadId,
        ).catch((err) => {
          log.warn({ err, slug: session.slug }, "failed to notify interrupted session")
        })
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
    this.pinnedMessages.updatePinnedSummary()
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
    this.persistTopicSessions(true).catch(() => {})
    log.info("stopped")
  }

  // ── Public command handlers (called by tests and external API) ────────

  async handleReplyCommand(threadId: number, text: string): Promise<void> {
    const topicSession = this.topicSessions.get(threadId)
    if (!topicSession) {
      await this.telegram.sendMessage(`❌ Thread ${threadId} not found or no active session`, threadId)
      return
    }
    if (!topicSession.activeSessionId) {
      await this.telegram.sendMessage(`❌ No active session in thread ${threadId}`, threadId)
      return
    }
    await this.handleTopicFeedback(topicSession, text)
  }

  async handleStopCommand(threadId: number): Promise<void> {
    const topicSession = this.topicSessions.get(threadId)
    if (!topicSession) {
      await this.telegram.sendMessage(`❌ Thread ${threadId} not found or no active session`, threadId)
      return
    }
    await this.handleStopCommandInternal(topicSession)
  }

  async handleCloseCommand(threadId: number): Promise<void> {
    const topicSession = this.topicSessions.get(threadId)
    if (!topicSession) {
      await this.telegram.sendMessage(`❌ Thread ${threadId} not found or no active session`, threadId)
      return
    }
    await this.handleCloseCommandInternal(topicSession)
  }

  // ── Cleanup timer ─────────────────────────────────────────────────────

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
      const staleTime = session.interruptedAt ?? session.lastActivityAt
      if (now - staleTime > staleTtlMs) {
        stale.push([threadId, session])
      }
    }

    if (stale.length === 0) return

    log.info({ count: stale.length }, "cleaning up stale sessions")

    for (const [threadId, session] of stale) {
      await this.closeChildSessions(session)
      await this.telegram.deleteForumTopic(threadId)
      await this.removeWorkspace(session)
      this.topicSessions.delete(threadId)
      log.info({ slug: session.slug, threadId }, "cleaned up stale session")
    }

    await this.persistTopicSessions()
    this.pinnedMessages.updatePinnedSummary()
  }

  private async persistTopicSessions(markInterrupted = false): Promise<void> {
    const toSave = new Map<number, TopicSession>()
    const now = Date.now()
    for (const [threadId, session] of this.topicSessions) {
      if (markInterrupted && session.activeSessionId) {
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

  // ── Polling & update handling ─────────────────────────────────────────

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

    const threadId = message.message_thread_id
    const topicSession = threadId !== undefined ? this.topicSessions.get(threadId) : undefined

    const routed = routeCommand(text, threadId, topicSession?.mode, !!topicSession, photos)

    if (!routed) {
      if (threadId !== undefined) {
        const session = this.sessions.get(threadId)
        if (session) {
          log.debug({ threadId }, "received message in active topic, session still initializing")
        }
      }
      return
    }

    switch (routed.type) {
      case "status": return this.handleStatusCommand()
      case "stats": return this.handleStatsCommand()
      case "usage": return this.handleUsageCommand()
      case "clean": return this.handleCleanCommand()
      case "help": return this.handleHelpCommand()
      case "config": return this.handleConfigCommand(routed.args)
      case "task": return this.handleTaskCommand(routed.args, routed.threadId, routed.photos)
      case "plan": return this.handlePlanCommand(routed.args, routed.threadId, routed.photos)
      case "think": return this.handleThinkCommand(routed.args, routed.threadId, routed.photos)
      case "review": return this.handleReviewCommand(routed.args, routed.threadId)
      case "ship": return this.handleShipCommand(routed.args, routed.threadId)
      case "close": return this.handleCloseCommandInternal(topicSession!)
      case "stop": return this.handleStopCommandInternal(topicSession!)
      case "execute": return this.handleExecuteCommand(topicSession!, routed.directive)
      case "split": return this.splitOrchestrator.handleSplitCommand(topicSession!, routed.directive)
      case "stack": return this.splitOrchestrator.handleStackCommand(topicSession!, routed.directive)
      case "dag": return this.handleDagCommand(topicSession!, routed.directive)
      case "land": return this.landingManager.handleLandCommand(topicSession!)
      case "retry": return this.dagOrchestrator.handleRetryCommand(topicSession!, routed.nodeId)
      case "force": return this.dagOrchestrator.handleForceCommand(topicSession!, routed.nodeId)
      case "reply": return this.handleTopicFeedback(topicSession!, routed.text, routed.photos)
    }
  }

  // ── Callback queries ──────────────────────────────────────────────────

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

    if (!data.startsWith("repo:") && !data.startsWith("plan-repo:") && !data.startsWith("think-repo:") && !data.startsWith("review-repo:") && !data.startsWith("ship-repo:")) {
      await this.telegram.answerCallbackQuery(query.id)
      return
    }

    const isThink = data.startsWith("think-repo:")
    const isPlan = data.startsWith("plan-repo:")
    const isReview = data.startsWith("review-repo:")
    const isShip = data.startsWith("ship-repo:")
    const repoSlug = isThink
      ? data.slice("think-repo:".length)
      : isPlan
      ? data.slice("plan-repo:".length)
      : isReview
      ? data.slice("review-repo:".length)
      : isShip
      ? data.slice("ship-repo:".length)
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
          await this.startTopicSession(repoUrl, pending.task, pending.mode, undefined, defaultProfileId, pending.autoAdvance)
        } else {
          const profiles = this.profileStore.list()
          if (profiles.length > 1) {
            const label = pending.mode === "ship-think" ? "ship" : pending.mode
            const keyboard = buildProfileKeyboard(profiles)
            const msgId = await this.telegram.sendMessageWithKeyboard(
              `Pick a profile for ${label}: <i>${escapeHtml(pending.task)}</i>`,
              keyboard,
              pending.threadId,
            )
            if (msgId) {
              this.pendingProfiles.set(msgId, pending)
            }
          } else {
            await this.startTopicSession(repoUrl, pending.task, pending.mode, undefined, undefined, pending.autoAdvance)
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
        await this.startTopicSession(pending.repoUrl, pending.task, pending.mode, undefined, profileId, pending.autoAdvance)
        return
      }
    }

    await this.telegram.answerCallbackQuery(query.id)
  }

  // ── Global commands ───────────────────────────────────────────────────

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
        const p = this.profileStore.get(id)
        await this.telegram.sendMessage(`✅ Default profile set to <code>${escapeHtml(id)}</code> (${escapeHtml(p?.name ?? id)})`)
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

    await this.persistTopicSessions()
    this.pinnedMessages.updatePinnedSummary()

    const totalItems = removedSessions + removedOrphans + removedRepos
    if (totalItems === 0) {
      await this.telegram.sendMessage("🧹 Nothing to clean up — disk is tidy.")
      return
    }

    const itemParts: string[] = []
    if (removedSessions > 0) itemParts.push(`${removedSessions} idle session(s)`)
    if (removedOrphans > 0) itemParts.push(`${removedOrphans} orphaned workspace(s)`)
    if (removedRepos > 0) itemParts.push(`${removedRepos} cached repo(s)`)

    const freedMB = (freedBytes / (1024 * 1024)).toFixed(1)
    await this.telegram.sendMessage(`🧹 Cleaned ${itemParts.join(", ")} — freed ~${freedMB} MB.`)
  }

  // ── Session-creating commands ─────────────────────────────────────────

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

    await this.startWithProfileSelection(repoUrl, task, "task", replyThreadId, photos)
  }

  private async handlePlanCommand(args: string, replyThreadId?: number, photos?: TelegramPhotoSize[]): Promise<void> {
    const { repoUrl, task } = parseTaskArgs(this.config.repos, args)

    if (!task) {
      if (replyThreadId !== undefined) {
        await this.telegram.sendMessage(`Usage: <code>/plan [repo] description of what to plan</code>`, replyThreadId)
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

    await this.startWithProfileSelection(repoUrl, task, "plan", replyThreadId, photos)
  }

  private async handleThinkCommand(args: string, replyThreadId?: number, photos?: TelegramPhotoSize[]): Promise<void> {
    const { repoUrl, task } = parseTaskArgs(this.config.repos, args)

    if (!task) {
      if (replyThreadId !== undefined) {
        await this.telegram.sendMessage(`Usage: <code>/think [repo] question or topic to research</code>`, replyThreadId)
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

    await this.startWithProfileSelection(repoUrl, task, "think", replyThreadId, photos)
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
        await this.startWithProfileSelection(repoUrl, task, "review", replyThreadId)
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
      await this.startWithProfileSelection(parsed.repoUrl, task, "review", replyThreadId)
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
      await this.startWithProfileSelection(parsed.repoUrl, parsed.task, "review", replyThreadId)
      return
    }
  }

  private async handleShipCommand(args: string, replyThreadId?: number): Promise<void> {
    const { repoUrl, task } = parseTaskArgs(this.config.repos, args)

    if (!task) {
      if (replyThreadId !== undefined) {
        await this.telegram.sendMessage(
          `Usage: <code>/ship [repo] description of the feature to build</code>`,
          replyThreadId,
        )
      }
      return
    }

    const autoAdvance: AutoAdvance = { phase: "think", featureDescription: task, autoLand: false }

    if (!repoUrl) {
      const repoKeys = Object.keys(this.config.repos)
      if (repoKeys.length > 0) {
        const keyboard = buildRepoKeyboard(repoKeys, "ship")
        const msgId = await this.telegram.sendMessageWithKeyboard(
          `Pick a repo for ship: <i>${escapeHtml(task)}</i>`,
          keyboard,
          replyThreadId,
        )
        if (msgId) {
          this.pendingTasks.set(msgId, { task, threadId: replyThreadId, mode: "ship-think", autoAdvance })
        }
        return
      }
    }

    await this.startWithProfileSelection(repoUrl, task, "ship-think", replyThreadId, undefined, autoAdvance)
  }

  private async startWithProfileSelection(
    repoUrl: string | undefined,
    task: string,
    mode: "task" | "plan" | "think" | "review" | "ship-think",
    replyThreadId?: number,
    photos?: TelegramPhotoSize[],
    autoAdvance?: AutoAdvance,
  ): Promise<void> {
    const defaultProfileId = this.profileStore.getDefaultId()
    if (defaultProfileId) {
      await this.startTopicSession(repoUrl, task, mode, photos, defaultProfileId, autoAdvance)
      return
    }

    const profiles = this.profileStore.list()
    if (profiles.length > 1) {
      const keyboard = buildProfileKeyboard(profiles)
      const label = mode === "ship-think" ? "ship" : mode
      const msgId = await this.telegram.sendMessageWithKeyboard(
        `Pick a profile for ${label}: <i>${escapeHtml(task)}</i>`,
        keyboard,
        replyThreadId,
      )
      if (msgId) {
        this.pendingProfiles.set(msgId, { task, threadId: replyThreadId, repoUrl, mode, autoAdvance })
      }
      return
    }

    await this.startTopicSession(repoUrl, task, mode, photos, undefined, autoAdvance)
  }

  // ── Topic session creation ────────────────────────────────────────────

  private async startTopicSession(
    repoUrl: string | undefined,
    task: string,
    mode: SessionMode,
    photos?: TelegramPhotoSize[],
    profileId?: string,
    autoAdvance?: AutoAdvance,
  ): Promise<void> {
    const sessionId = crypto.randomUUID()
    const slug = generateSlug(sessionId)
    const repo = repoUrl ? extractRepoName(repoUrl) : "local"
    const label = taskToLabel(task)
    const topicHandle = `${slug}/${label}`
    const emoji = autoAdvance
      ? "🚢"
      : mode === "think"
      ? "🧠"
      : mode === "plan"
      ? "📋"
      : mode === "review"
      ? "👀"
      : ""
    const topicName = emoji ? `${emoji} ${topicHandle}` : topicHandle

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
      topicHandle,
      conversation: [{ role: "user", text: fullTask, images: imagePaths.length > 0 ? imagePaths : undefined }],
      pendingFeedback: [],
      mode,
      lastActivityAt: Date.now(),
      profileId,
      branch: repoUrl ? `minion/${slug}` : undefined,
      autoAdvance,
    }

    this.topicSessions.set(threadId, topicSession)
    this.broadcastSession(topicSession, "session_created")
    this.pinnedMessages.updatePinnedSummary()

    await this.spawnTopicAgent(topicSession, fullTask)
  }

  private async updateTopicTitle(topicSession: TopicSession, stateEmoji: string): Promise<void> {
    const handle = topicSession.topicHandle ?? topicSession.slug
    const name = `${stateEmoji} ${handle}`
    await this.telegram.editForumTopic(topicSession.threadId, name).catch(() => {})
  }

  // ── Agent spawning ────────────────────────────────────────────────────

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
      topicName: topicSession.topicHandle ?? topicSession.slug,
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
      (m, state) => this.handleSessionComplete(topicSession, m, state, sessionId),
      this.config.workspace.sessionTimeoutMs,
      this.config.workspace.sessionInactivityTimeoutMs,
      sessionConfig,
    )

    this.sessions.set(topicSession.threadId, { handle, meta, task })

    await this.pinnedMessages.updateTopicTitle(topicSession, "⚡")
    this.pinnedMessages.updatePinnedSummary()
    const onDeadThread = () => {
      log.warn({ threadId: meta.threadId, slug: topicSession.slug }, "thread not found, removing session from store")
      this.topicSessions.delete(meta.threadId)
      this.persistTopicSessions().catch(() => {})
    }
    await this.observer.onSessionStart(meta, task, onTextCapture, onDeadThread)
    const systemPrompt = systemPromptOverride ?? (topicSession.mode === "task" ? prompts.task : undefined)
    handle.start(task, systemPrompt)
  }

  private handleSessionComplete(topicSession: TopicSession, m: SessionMeta, state: "completed" | "errored", sessionId: string): void {
    if (topicSession.activeSessionId !== m.sessionId) return

    const durationMs = Date.now() - m.startedAt
    this.sessions.delete(topicSession.threadId)
    topicSession.activeSessionId = undefined
    topicSession.lastActivityAt = Date.now()
    this.broadcastSession(topicSession, "session_updated", state as "completed" | "errored")
    this.pinnedMessages.updatePinnedSummary()

    this.stats.record({
      slug: topicSession.slug,
      repo: topicSession.repo,
      mode: topicSession.mode,
      state,
      durationMs,
      totalTokens: m.totalTokens ?? 0,
      timestamp: Date.now(),
    }).catch(() => {})

    // Ship auto-advance
    if (topicSession.autoAdvance && (topicSession.mode === "ship-think" || topicSession.mode === "ship-plan" || topicSession.mode === "ship-verify")) {
      if (state === "completed") {
        this.observer.flushAndComplete(m, state, durationMs).then(() => {
          writeSessionLog(topicSession, m, state, durationMs)
          this.shipPipeline.handleShipAdvance(topicSession).catch((err) => {
            loggers.ship.error({ err, slug: topicSession.slug }, "ship advance error")
            this.telegram.sendMessage(
              `❌ Ship pipeline error during ${topicSession.autoAdvance!.phase} phase: ${err instanceof Error ? err.message : String(err)}`,
              topicSession.threadId,
            ).catch(() => {})
          })
        }).catch((err) => {
          loggers.ship.error({ err }, "flushAndComplete error in ship phase")
        })
      } else {
        topicSession.autoAdvance.phase = "done"
        this.pinnedMessages.updateTopicTitle(topicSession, "❌").catch(() => {})
        this.observer.onSessionComplete(m, state, durationMs).catch(() => {})
        this.telegram.sendMessage(
          `❌ Ship pipeline halted: ${topicSession.mode} phase errored.`,
          topicSession.threadId,
        ).catch(() => {})
        writeSessionLog(topicSession, m, state, durationMs)
      }
      this.persistTopicSessions().catch(() => {})
      this.cleanBuildArtifacts(topicSession.cwd)
      return
    }

    if (topicSession.mode === "think") {
      this.pinnedMessages.updateTopicTitle(topicSession, "💬").catch(() => {})
      this.observer.onSessionComplete(m, state, durationMs).catch((err) => {
        loggers.observer.error({ err, sessionId }, "onSessionComplete error")
      })
      this.telegram.sendMessage(
        formatThinkComplete(topicSession.slug),
        topicSession.threadId,
      ).catch(() => {})
      writeSessionLog(topicSession, m, state, durationMs)
    } else if (topicSession.mode === "review") {
      this.pinnedMessages.updateTopicTitle(topicSession, "💬").catch(() => {})
      this.observer.onSessionComplete(m, state, durationMs).catch((err) => {
        loggers.observer.error({ err, sessionId }, "onSessionComplete error")
      })
      this.telegram.sendMessage(
        formatReviewComplete(topicSession.slug),
        topicSession.threadId,
      ).catch(() => {})
      writeSessionLog(topicSession, m, state, durationMs)
    } else if (topicSession.mode === "plan") {
      this.pinnedMessages.updateTopicTitle(topicSession, "💬").catch(() => {})
      this.observer.onSessionComplete(m, state, durationMs).catch((err) => {
        loggers.observer.error({ err, sessionId }, "onSessionComplete error")
      })
      this.telegram.sendMessage(
        formatPlanComplete(topicSession.slug),
        topicSession.threadId,
      ).catch(() => {})
      writeSessionLog(topicSession, m, state, durationMs)
    } else if (state === "errored") {
      topicSession.lastState = "errored"
      this.pinnedMessages.updateTopicTitle(topicSession, "❌").catch(() => {})
      this.observer.onSessionComplete(m, state, durationMs).catch((err) => {
        loggers.observer.error({ err, sessionId }, "onSessionComplete error")
      })
      writeSessionLog(topicSession, m, state, durationMs)
    } else {
      topicSession.lastState = "completed"
      this.pinnedMessages.updateTopicTitle(topicSession, "✅").catch(() => {})
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
            await this.pinnedMessages.pinThreadMessage(
              topicSession,
              formatPinnedStatus(topicSession.slug, topicSession.repo, "completed", prUrl),
            )
            if (this.config.ci.babysitEnabled) {
              if (topicSession.dagId) {
                // DAG children: CI is handled inline in onDagChildComplete
              } else if (topicSession.parentThreadId) {
                this.ciBabysitter.queueDeferredBabysit(topicSession.parentThreadId, { childSession: topicSession, prUrl, qualityReport })
              } else {
                this.ciBabysitter.babysitPR(topicSession, prUrl, qualityReport).catch((err) => {
                  log.error({ err, prUrl }, "babysitPR error")
                  captureException(err, { operation: "babysitPR", prUrl })
                })
              }
            }
          } else {
            await this.pinnedMessages.pinThreadMessage(
              topicSession,
              formatPinnedStatus(topicSession.slug, topicSession.repo, "completed"),
            )
          }
        }
      }).catch((err) => {
        loggers.observer.error({ err, sessionId }, "flushAndComplete error")
      })
    }

    this.persistTopicSessions().catch(() => {})
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
      topicName: topicSession.topicHandle ?? topicSession.slug,
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
        }).catch(() => {})

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

    const onDeadThread = () => {
      log.warn({ threadId: meta.threadId, slug: topicSession.slug }, "thread not found, removing session from store")
      this.topicSessions.delete(meta.threadId)
      this.persistTopicSessions().catch(() => {})
    }
    await this.observer.onSessionStart(meta, task, undefined, onDeadThread)
    handle.start(task, DEFAULT_CI_FIX_PROMPT)
  }

  // ── Feedback & commands that stay in Dispatcher ───────────────────────

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
      await this.telegram.sendMessage(formatThinkIteration(topicSession.slug, iteration), topicSession.threadId)
    } else if (topicSession.mode === "review") {
      await this.telegram.sendMessage(formatReviewIteration(topicSession.slug, iteration), topicSession.threadId)
    } else if (topicSession.mode === "plan") {
      await this.telegram.sendMessage(formatPlanIteration(topicSession.slug, iteration), topicSession.threadId)
    } else {
      await this.telegram.sendMessage(formatFollowUpIteration(topicSession.slug, iteration), topicSession.threadId)
    }

    const contextTask = buildContextPrompt(topicSession)
    await this.spawnTopicAgent(topicSession, contextTask)
  }

  private async handleExecuteCommand(topicSession: TopicSession, directive?: string): Promise<void> {
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

    topicSession.mode = "task"
    topicSession.activeSessionId = undefined
    topicSession.pendingFeedback = []

    await this.spawnTopicAgent(topicSession, executionTask)
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

    await this.dagOrchestrator.startDag(topicSession, result.items, false)
  }

  // ── Parent/child notification ─────────────────────────────────────────

  private async notifyParentOfChildComplete(
    childSession: TopicSession,
    state: string,
  ): Promise<void> {
    if (!childSession.parentThreadId) return

    if (childSession.dagId && childSession.dagNodeId) {
      await this.dagOrchestrator.onDagChildComplete(childSession, state)
      return
    }

    await this.splitOrchestrator.notifyParentOfChildComplete(childSession, state)
  }

  // ── Split child spawning (context implementation) ─────────────────────

  private async spawnSplitChild(
    parent: TopicSession,
    item: { title: string; description: string },
    allItems: { title: string; description: string }[],
  ): Promise<number | null> {
    const sessionId = crypto.randomUUID()
    const slug = generateSlug(sessionId)
    const repo = parent.repo
    const childLabel = taskToLabel(item.title)
    const topicHandle = `${parent.slug}/${childLabel}`
    const topicName = `⚡ ${topicHandle}`

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
      topicHandle,
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

  // ── Conversation utilities ────────────────────────────────────────────

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

  // ── Child session management ──────────────────────────────────────────

  private async closeChildSessions(parent: TopicSession): Promise<void> {
    const childrenToClose = new Map<number, TopicSession>()

    if (parent.childThreadIds) {
      for (const childId of parent.childThreadIds) {
        const child = this.topicSessions.get(childId)
        if (child) childrenToClose.set(childId, child)
      }
    }

    for (const [candidateId, candidate] of this.topicSessions) {
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

    await this.closeChildSessions(topicSession)

    if (topicSession.dagId) {
      this.broadcastDagDeleted(topicSession.dagId)
      this.dags.delete(topicSession.dagId)
    }

    this.topicSessions.delete(threadId)
    this.broadcastSessionDeleted(topicSession.slug)
    await this.persistTopicSessions()
    this.pinnedMessages.updatePinnedSummary()
    await this.telegram.deleteForumTopic(threadId)
    log.info({ slug: topicSession.slug, threadId }, "closed and deleted topic")

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

    if (!topicSession.activeSessionId) {
      await this.telegram.sendMessage(`⚠️ No active session to stop.`, threadId)
      return
    }

    const activeSession = this.sessions.get(threadId)
    if (activeSession) {
      this.sessions.delete(threadId)
      await activeSession.handle.kill()
    }

    topicSession.activeSessionId = undefined
    topicSession.pendingFeedback = []
    this.persistTopicSessions()

    await this.telegram.sendMessage(`⏹️ Session stopped. Send <b>/reply</b> to continue.`, threadId)
    log.info({ slug: topicSession.slug, threadId }, "stopped session")
  }

  // ── Workspace wrappers ────────────────────────────────────────────────

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

  // ── API accessors ─────────────────────────────────────────────────────

  activeSessions(): number {
    return this.sessions.size
  }

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
    topicSession.pendingFeedback.push(message)
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

    const activeSession = this.sessions.get(threadId)
    if (activeSession) {
      activeSession.handle.interrupt()
      this.sessions.delete(threadId)
    }

    await this.telegram.deleteForumTopic(threadId)
    await this.removeWorkspace(topicSession)
    this.topicSessions.delete(threadId)
    this.broadcastSessionDeleted(topicSession.slug)
    await this.persistTopicSessions()
    this.pinnedMessages.updatePinnedSummary()
  }
}
