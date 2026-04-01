import fs from "node:fs/promises"
import path from "node:path"
import { captureException } from "./sentry.js"
import { loggers } from "./logger.js"

const STATS_FILENAME = ".stats.json"
const MAX_RECORDS = 500
const log = loggers.stats

export interface SessionRecord {
  slug: string
  repo: string
  mode: string
  state: "completed" | "errored" | "quota_exhausted"
  durationMs: number
  totalTokens: number
  timestamp: number
}

export interface AggregateStats {
  totalSessions: number
  completedSessions: number
  erroredSessions: number
  totalTokens: number
  totalDurationMs: number
  avgDurationMs: number
}

export interface ModeBreakdown {
  count: number
  tokens: number
  durationMs: number
}

export class StatsTracker {
  private readonly filePath: string
  private cache: SessionRecord[] | null = null

  constructor(workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, STATS_FILENAME)
  }

  async record(entry: SessionRecord): Promise<void> {
    const records = await this.load()
    records.push(entry)
    if (records.length > MAX_RECORDS) {
      records.splice(0, records.length - MAX_RECORDS)
    }
    this.cache = records
    try {
      await fs.writeFile(this.filePath, JSON.stringify(records), "utf-8")
    } catch (err) {
      log.error({ err, operation: "stats.save" }, "failed to save")
      captureException(err, { operation: "stats.save" })
    }
  }

  async load(): Promise<SessionRecord[]> {
    if (this.cache) return this.cache
    try {
      const raw = await fs.readFile(this.filePath, "utf-8")
      this.cache = JSON.parse(raw)
      return this.cache!
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = []
      }
      return this.cache ?? []
    }
  }

  async aggregate(sinceDaysAgo?: number): Promise<AggregateStats> {
    let records = await this.load()
    if (sinceDaysAgo !== undefined) {
      const cutoff = Date.now() - sinceDaysAgo * 86400000
      records = records.filter((r) => r.timestamp >= cutoff)
    }

    const completed = records.filter((r) => r.state === "completed")
    const errored = records.filter((r) => r.state === "errored")
    const totalDuration = records.reduce((sum, r) => sum + r.durationMs, 0)

    return {
      totalSessions: records.length,
      completedSessions: completed.length,
      erroredSessions: errored.length,
      totalTokens: records.reduce((sum, r) => sum + r.totalTokens, 0),
      totalDurationMs: totalDuration,
      avgDurationMs: records.length > 0 ? Math.round(totalDuration / records.length) : 0,
    }
  }

  async recentSessions(n: number): Promise<SessionRecord[]> {
    const records = await this.load()
    return records.slice(-n).reverse()
  }

  async breakdownByMode(sinceDaysAgo?: number): Promise<Record<string, ModeBreakdown>> {
    let records = await this.load()
    if (sinceDaysAgo !== undefined) {
      const cutoff = Date.now() - sinceDaysAgo * 86400000
      records = records.filter((r) => r.timestamp >= cutoff)
    }
    const result: Record<string, ModeBreakdown> = {}
    for (const r of records) {
      const entry = result[r.mode] ?? (result[r.mode] = { count: 0, tokens: 0, durationMs: 0 })
      entry.count++
      entry.tokens += r.totalTokens
      entry.durationMs += r.durationMs
    }
    return result
  }
}
