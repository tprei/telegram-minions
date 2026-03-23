import fs from "node:fs"
import path from "node:path"

const STATS_FILENAME = ".stats.json"
const MAX_RECORDS = 500

export interface SessionRecord {
  slug: string
  repo: string
  mode: string
  state: "completed" | "errored"
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

export class StatsTracker {
  private readonly filePath: string

  constructor(workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, STATS_FILENAME)
  }

  record(entry: SessionRecord): void {
    const records = this.load()
    records.push(entry)
    if (records.length > MAX_RECORDS) {
      records.splice(0, records.length - MAX_RECORDS)
    }
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(records), "utf-8")
    } catch (err) {
      process.stderr.write(`stats: failed to save: ${err}\n`)
    }
  }

  load(): SessionRecord[] {
    try {
      if (!fs.existsSync(this.filePath)) return []
      return JSON.parse(fs.readFileSync(this.filePath, "utf-8"))
    } catch {
      return []
    }
  }

  aggregate(sinceDaysAgo?: number): AggregateStats {
    let records = this.load()
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
}
