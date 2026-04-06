import type { DispatcherContext } from "./dispatcher-context.js"
import type { TopicSession, PatrolFinding, PatrolCycle } from "../domain/session-types.js"
import { loggers } from "../logger.js"
import {
  formatPatrolStatus,
  formatPatrolCycleStart,
  formatPatrolFindings,
  formatPatrolSleeping,
  formatPatrolSpawning,
} from "../telegram/format.js"

const log = loggers.dispatcher

export class PatrolOrchestrator {
  private readonly ctx: DispatcherContext
  private readonly sleepTimers = new Map<number, ReturnType<typeof setTimeout>>()

  constructor(ctx: DispatcherContext) {
    this.ctx = ctx
  }

  async handlePatrolCommand(
    repoUrl: string | undefined,
    task: string,
    replyThreadId?: number,
  ): Promise<void> {
    // Check if there's already an active patrol for this repo
    for (const session of this.ctx.topicSessions.values()) {
      if (session.mode === "patrol" && session.repoUrl === repoUrl && !session.patrolState?.paused) {
        await this.ctx.telegram.sendMessage(
          `⚠️ A patrol is already running for this repo. Use <code>/close</code> in that thread to stop it first.`,
          replyThreadId,
        )
        return
      }
    }

    if (!repoUrl) {
      await this.ctx.telegram.sendMessage(
        `Usage: <code>/patrol [repo] [optional focus area]</code>\n\nA repo is required for patrol.`,
        replyThreadId,
      )
      return
    }

    return this.ctx.startWithProfileSelection(repoUrl, task || "patrol", "patrol" as "task", replyThreadId)
  }

  initPatrolState(topicSession: TopicSession): void {
    topicSession.patrolState = {
      intervalMs: this.ctx.config.patrol.intervalMs,
      currentCycle: 0,
      history: [],
    }
  }

  async startPatrolCycle(topicSession: TopicSession): Promise<void> {
    if (!topicSession.patrolState) {
      this.initPatrolState(topicSession)
    }

    const state = topicSession.patrolState!
    if (state.paused) {
      log.info({ slug: topicSession.slug }, "patrol is paused, skipping cycle")
      return
    }

    state.currentCycle++

    await this.ctx.telegram.sendMessage(
      formatPatrolCycleStart(topicSession.slug, state.currentCycle),
      topicSession.threadId,
    )

    await this.ctx.updateTopicTitle(topicSession, "🔍")

    // Spawn the analysis agent (uses SDK/Claude in read-only mode)
    const analysisTask = this.buildAnalysisTask(topicSession)
    await this.ctx.spawnTopicAgent(topicSession, analysisTask)
  }

  async onAnalysisComplete(topicSession: TopicSession): Promise<void> {
    if (!topicSession.patrolState) return

    const state = topicSession.patrolState
    const findings = this.extractFindings(topicSession.conversation)

    const cycle: PatrolCycle = {
      cycle: state.currentCycle,
      startedAt: state.history.length > 0
        ? state.history[state.history.length - 1]?.startedAt ?? Date.now()
        : Date.now(),
      completedAt: Date.now(),
      findings,
      spawnedTasks: [],
    }

    // Trim history to last 10 cycles
    if (state.history.length >= 10) {
      state.history = state.history.slice(-9)
    }
    state.history.push(cycle)

    // Report findings
    await this.ctx.telegram.sendMessage(
      formatPatrolFindings(topicSession.slug, state.currentCycle, findings),
      topicSession.threadId,
    )

    // Spawn fix tasks for error-level findings
    const errorFindings = findings.filter((f) => f.severity === "error")
    const maxTasks = this.ctx.config.patrol.maxTasksPerCycle
    const toFix = errorFindings.slice(0, maxTasks)

    if (toFix.length > 0) {
      await this.spawnFixTasks(topicSession, cycle, toFix)
    }

    // Update pinned status
    await this.ctx.pinThreadMessage(topicSession, formatPatrolStatus(topicSession))

    // Schedule next cycle
    this.scheduleNextCycle(topicSession)
    await this.ctx.persistTopicSessions()
  }

  async handlePauseCommand(topicSession: TopicSession): Promise<void> {
    if (!topicSession.patrolState) return

    topicSession.patrolState.paused = true
    topicSession.patrolState.nextRunAt = undefined

    // Clear any pending timer
    const timer = this.sleepTimers.get(topicSession.threadId)
    if (timer) {
      clearTimeout(timer)
      this.sleepTimers.delete(topicSession.threadId)
    }

    // Kill active analysis if running
    if (topicSession.activeSessionId) {
      const active = this.ctx.sessions.get(topicSession.threadId)
      if (active) await active.handle.kill()
      this.ctx.sessions.delete(topicSession.threadId)
      topicSession.activeSessionId = undefined
    }

    await this.ctx.updateTopicTitle(topicSession, "⏸️")
    await this.ctx.telegram.sendMessage(
      `⏸️ Patrol paused. Use <code>/resume</code> to continue.`,
      topicSession.threadId,
    )
    await this.ctx.pinThreadMessage(topicSession, formatPatrolStatus(topicSession))
    await this.ctx.persistTopicSessions()
  }

  async handleResumeCommand(topicSession: TopicSession): Promise<void> {
    if (!topicSession.patrolState) return

    topicSession.patrolState.paused = false

    await this.ctx.telegram.sendMessage(
      `▶️ Patrol resumed. Starting next cycle now.`,
      topicSession.threadId,
    )

    await this.startPatrolCycle(topicSession)
  }

  scheduleNextCycle(topicSession: TopicSession): void {
    if (!topicSession.patrolState || topicSession.patrolState.paused) return

    const intervalMs = topicSession.patrolState.intervalMs
    topicSession.patrolState.nextRunAt = Date.now() + intervalMs

    const timer = setTimeout(() => {
      this.sleepTimers.delete(topicSession.threadId)
      this.startPatrolCycle(topicSession).catch((err) => {
        log.error({ err, slug: topicSession.slug }, "patrol cycle error")
      })
    }, intervalMs)

    // Clear any existing timer
    const existing = this.sleepTimers.get(topicSession.threadId)
    if (existing) clearTimeout(existing)
    this.sleepTimers.set(topicSession.threadId, timer)

    const hours = Math.round(intervalMs / 3600000 * 10) / 10

    this.ctx.telegram.sendMessage(
      formatPatrolSleeping(topicSession.slug, hours),
      topicSession.threadId,
    ).catch(() => {})

    this.ctx.updateTopicTitle(topicSession, "💤").catch(() => {})
  }

  recoverTimers(): void {
    const now = Date.now()
    for (const session of this.ctx.topicSessions.values()) {
      if (session.mode !== "patrol" || !session.patrolState) continue
      if (session.patrolState.paused) continue

      const nextRun = session.patrolState.nextRunAt
      if (!nextRun) {
        // No scheduled run — start a cycle immediately
        this.startPatrolCycle(session).catch((err) => {
          log.error({ err, slug: session.slug }, "patrol recovery error")
        })
        continue
      }

      if (nextRun <= now) {
        // Overdue — run immediately
        this.startPatrolCycle(session).catch((err) => {
          log.error({ err, slug: session.slug }, "patrol recovery error")
        })
      } else {
        // Schedule for remaining time
        const remaining = nextRun - now
        const timer = setTimeout(() => {
          this.sleepTimers.delete(session.threadId)
          this.startPatrolCycle(session).catch((err) => {
            log.error({ err, slug: session.slug }, "patrol cycle error")
          })
        }, remaining)
        this.sleepTimers.set(session.threadId, timer)
      }
    }
  }

  clearTimers(): void {
    for (const timer of this.sleepTimers.values()) {
      clearTimeout(timer)
    }
    this.sleepTimers.clear()
  }

  private buildAnalysisTask(topicSession: TopicSession): string {
    const state = topicSession.patrolState!
    const prevFindings = state.history.length > 0
      ? state.history[state.history.length - 1]?.findings ?? []
      : []

    const lines = [
      `Patrol cycle #${state.currentCycle} for ${topicSession.repo}.`,
      "",
      "Run the health checks described in your system prompt and report findings.",
    ]

    if (prevFindings.length > 0) {
      lines.push(
        "",
        "Previous cycle found these issues (check if they're still present):",
        ...prevFindings.map((f) => `- [${f.severity}] ${f.check}: ${f.summary}`),
      )
    }

    const checks = this.ctx.config.patrol.checks
    if (checks.length > 0) {
      lines.push(
        "",
        `Focus on these checks: ${checks.join(", ")}`,
      )
    }

    return lines.join("\n")
  }

  extractFindings(conversation: { role: string; text: string }[]): PatrolFinding[] {
    // Look for PATROL_FINDINGS: JSON in the conversation
    for (let i = conversation.length - 1; i >= 0; i--) {
      const msg = conversation[i]
      if (msg.role !== "assistant") continue

      const match = /PATROL_FINDINGS:\s*(\[[\s\S]*?\])/.exec(msg.text)
      if (match) {
        try {
          const parsed = JSON.parse(match[1]) as PatrolFinding[]
          return parsed.filter(
            (f) =>
              typeof f.check === "string" &&
              typeof f.severity === "string" &&
              typeof f.summary === "string" &&
              ["error", "warning", "info"].includes(f.severity),
          )
        } catch {
          log.warn("failed to parse PATROL_FINDINGS JSON")
        }
      }
    }
    return []
  }

  private async spawnFixTasks(
    topicSession: TopicSession,
    cycle: PatrolCycle,
    findings: PatrolFinding[],
  ): Promise<void> {
    // Deduplicate: check if there's already an open PR for this type of fix
    const existing = topicSession.childThreadIds ?? []
    const available = this.ctx.config.patrol.maxTasksPerCycle - existing.filter((id) => {
      const child = this.ctx.topicSessions.get(id)
      return child && child.activeSessionId
    }).length

    if (available <= 0) {
      await this.ctx.telegram.sendMessage(
        `⏳ Max patrol tasks already running. Fixes deferred to next cycle.`,
        topicSession.threadId,
      )
      return
    }

    const toSpawn = findings.slice(0, available)

    await this.ctx.telegram.sendMessage(
      formatPatrolSpawning(topicSession.slug, toSpawn),
      topicSession.threadId,
    )

    if (!topicSession.childThreadIds) {
      topicSession.childThreadIds = []
    }

    for (const finding of toSpawn) {
      const taskDescription = [
        `Fix ${finding.check} issue found by patrol:`,
        "",
        `**Problem**: ${finding.summary}`,
        finding.detail ? `\n**Detail**: ${finding.detail}` : "",
        "",
        "Keep the fix minimal and focused. Open a PR with the fix.",
      ].join("\n")

      const childThreadId = await this.ctx.spawnSplitChild(
        topicSession,
        { title: `fix: ${finding.check} — ${finding.summary.slice(0, 50)}`, description: taskDescription },
        toSpawn.map((f) => ({ title: f.check, description: f.summary })),
      )

      if (childThreadId) {
        topicSession.childThreadIds.push(childThreadId)
        cycle.spawnedTasks.push(childThreadId)
      }
    }
  }
}
