import { execFile as execFileCb } from "node:child_process"
import type { LoopDefinition, LoopState } from "./domain-types.js"
import type { LoopStore } from "./loop-store.js"
import { loggers } from "../logger.js"
import { captureException } from "../sentry.js"

const log = loggers.loopScheduler

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5
const BACKOFF_THRESHOLD = 3
const STAGGER_INTERVAL_MS = 30_000

export interface LoopSchedulerConfig {
  maxConcurrentLoops: number
  reservedInteractiveSlots: number
  maxConcurrentSessions: number
}

export interface LoopSchedulerCallbacks {
  getActiveSessionCount(): number
  startLoopSession(loopId: string, definition: LoopDefinition, state: LoopState): Promise<number | null>
  isQuotaSleeping(): boolean
}

export class LoopScheduler {
  private readonly definitions = new Map<string, LoopDefinition>()
  private readonly states = new Map<string, LoopState>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly activeLoopThreads = new Map<string, number>()
  private running = false

  constructor(
    private readonly store: LoopStore,
    private readonly config: LoopSchedulerConfig,
    private readonly callbacks: LoopSchedulerCallbacks,
  ) {}

  async start(definitions: LoopDefinition[]): Promise<void> {
    this.running = true

    for (const def of definitions) {
      this.definitions.set(def.id, def)
    }

    const persisted = await this.store.load()
    for (const [id, state] of persisted) {
      this.states.set(id, state)
    }

    for (const def of definitions) {
      if (!this.states.has(def.id)) {
        this.states.set(def.id, this.createInitialState(def.id))
      }
    }

    this.purgeStaleStates()
    await this.persist()

    let staggerIndex = 0
    for (const def of definitions) {
      if (!def.enabled) continue
      const state = this.states.get(def.id)!
      if (!state.enabled) continue

      const delay = this.calculateNextDelay(def, state, staggerIndex)
      this.scheduleLoop(def.id, delay)
      state.nextRunAt = Date.now() + delay
      staggerIndex++
    }

    await this.persist()
    log.info({ loopCount: definitions.length, enabledCount: this.countEnabled() }, "loop scheduler started")
  }

  stop(): void {
    this.running = false
    for (const [id, timer] of this.timers) {
      clearTimeout(timer)
      log.debug({ loopId: id }, "cleared loop timer")
    }
    this.timers.clear()
    this.activeLoopThreads.clear()
    log.info("loop scheduler stopped")
  }

  getDefinitions(): Map<string, LoopDefinition> {
    return this.definitions
  }

  getStates(): Map<string, LoopState> {
    return this.states
  }

  getActiveLoopThreads(): Map<string, number> {
    return this.activeLoopThreads
  }

  isLoopActive(loopId: string): boolean {
    return this.activeLoopThreads.has(loopId)
  }

  enableLoop(loopId: string): boolean {
    const state = this.states.get(loopId)
    const def = this.definitions.get(loopId)
    if (!state || !def) return false

    state.enabled = true
    state.consecutiveFailures = 0
    this.scheduleLoop(loopId, def.intervalMs)
    state.nextRunAt = Date.now() + def.intervalMs
    this.persist().catch(() => {})
    log.info({ loopId }, "loop enabled")
    return true
  }

  disableLoop(loopId: string): boolean {
    const state = this.states.get(loopId)
    if (!state) return false

    state.enabled = false
    state.nextRunAt = undefined
    const timer = this.timers.get(loopId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(loopId)
    }
    this.persist().catch(() => {})
    log.info({ loopId }, "loop disabled")
    return true
  }

  recordOutcome(loopId: string, result: LoopState["outcomes"][number]): void {
    const state = this.states.get(loopId)
    const def = this.definitions.get(loopId)
    if (!state || !def) return

    this.activeLoopThreads.delete(loopId)

    state.totalRuns++
    state.lastRunAt = result.startedAt
    state.outcomes.push(result)

    const maxHistory = def.maxOutcomeHistory ?? 20
    if (state.outcomes.length > maxHistory) {
      state.outcomes = state.outcomes.slice(-maxHistory)
    }

    if (result.prUrl) {
      state.lastPrUrl = result.prUrl
    }

    if (result.result === "errored" || result.result === "quota_exhausted") {
      state.consecutiveFailures++
      const maxFailures = def.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES

      if (state.consecutiveFailures >= maxFailures) {
        state.enabled = false
        state.nextRunAt = undefined
        const timer = this.timers.get(loopId)
        if (timer) {
          clearTimeout(timer)
          this.timers.delete(loopId)
        }
        log.warn({ loopId, failures: state.consecutiveFailures, maxFailures }, "loop auto-disabled after max failures")
      } else if (state.consecutiveFailures >= BACKOFF_THRESHOLD) {
        const backoffMs = def.intervalMs * 2
        this.scheduleLoop(loopId, backoffMs)
        state.nextRunAt = Date.now() + backoffMs
        log.info({ loopId, failures: state.consecutiveFailures, backoffMs }, "loop backing off")
      } else {
        this.scheduleLoop(loopId, def.intervalMs)
        state.nextRunAt = Date.now() + def.intervalMs
      }
    } else {
      state.consecutiveFailures = 0
      if (state.enabled && this.running) {
        this.scheduleLoop(loopId, def.intervalMs)
        state.nextRunAt = Date.now() + def.intervalMs
      }
    }

    this.persist().catch(() => {})
    log.info({ loopId, result: result.result, totalRuns: state.totalRuns, consecutiveFailures: state.consecutiveFailures }, "loop outcome recorded")
  }

  async checkDuplicatePR(loopId: string, cwd: string): Promise<boolean> {
    const state = this.states.get(loopId)
    if (!state?.lastPrUrl) return false

    try {
      const prNumber = state.lastPrUrl.match(/\/pull\/(\d+)/)?.[1]
      if (!prNumber) return false

      const output = await execGh(
        ["pr", "view", prNumber, "--json", "state", "--jq", ".state"],
        { cwd },
      )
      const prState = output.trim()
      if (prState === "OPEN") {
        log.info({ loopId, prUrl: state.lastPrUrl }, "skipping loop run — previous PR still open")
        return true
      }
      return false
    } catch {
      return false
    }
  }

  private scheduleLoop(loopId: string, delayMs: number): void {
    if (!this.running) return

    const existing = this.timers.get(loopId)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.timers.delete(loopId)
      this.fireLoop(loopId).catch((err) => {
        log.error({ err, loopId }, "loop fire error")
        captureException(err, { operation: "loop-scheduler.fire", loopId })
      })
    }, delayMs)

    this.timers.set(loopId, timer)
    log.debug({ loopId, delayMs }, "loop scheduled")
  }

  private async fireLoop(loopId: string): Promise<void> {
    if (!this.running) return

    const def = this.definitions.get(loopId)
    const state = this.states.get(loopId)
    if (!def || !state || !state.enabled) return

    if (this.callbacks.isQuotaSleeping()) {
      log.info({ loopId }, "skipping loop — quota sleeping")
      this.scheduleLoop(loopId, def.intervalMs)
      state.nextRunAt = Date.now() + def.intervalMs
      return
    }

    if (!this.hasCapacity()) {
      log.info({ loopId }, "skipping loop — no capacity")
      this.scheduleLoop(loopId, 60_000)
      state.nextRunAt = Date.now() + 60_000
      return
    }

    const threadId = await this.callbacks.startLoopSession(loopId, def, state)
    if (threadId != null) {
      this.activeLoopThreads.set(loopId, threadId)
      log.info({ loopId, threadId }, "loop session started")
    } else {
      log.warn({ loopId }, "failed to start loop session, rescheduling")
      this.scheduleLoop(loopId, def.intervalMs)
      state.nextRunAt = Date.now() + def.intervalMs
    }
  }

  private hasCapacity(): boolean {
    const activeSessions = this.callbacks.getActiveSessionCount()
    const maxForLoops = this.config.maxConcurrentSessions - this.config.reservedInteractiveSlots
    if (activeSessions >= maxForLoops) return false

    const activeLoops = this.activeLoopThreads.size
    if (activeLoops >= this.config.maxConcurrentLoops) return false

    return true
  }

  private calculateNextDelay(def: LoopDefinition, state: LoopState, staggerIndex: number): number {
    const stagger = staggerIndex * STAGGER_INTERVAL_MS

    if (state.lastRunAt) {
      const elapsed = Date.now() - state.lastRunAt
      const remaining = def.intervalMs - elapsed
      if (remaining > 0) return remaining + stagger
    }

    return stagger + STAGGER_INTERVAL_MS
  }

  private createInitialState(loopId: string): LoopState {
    return {
      loopId,
      enabled: true,
      consecutiveFailures: 0,
      totalRuns: 0,
      outcomes: [],
    }
  }

  private purgeStaleStates(): void {
    const definedIds = new Set(this.definitions.keys())
    for (const id of this.states.keys()) {
      if (!definedIds.has(id)) {
        this.states.delete(id)
        log.info({ loopId: id }, "purged stale loop state")
      }
    }
  }

  private countEnabled(): number {
    let count = 0
    for (const def of this.definitions.values()) {
      const state = this.states.get(def.id)
      if (def.enabled && state?.enabled) count++
    }
    return count
  }

  private async persist(): Promise<void> {
    await this.store.save(this.states)
  }
}

function execGh(
  args: string[],
  opts: { cwd: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb("gh", args, {
      cwd: opts.cwd,
      timeout: 30_000,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout.trim())
    })
  })
}
