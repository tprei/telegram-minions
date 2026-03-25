import fs from "node:fs"
import path from "node:path"
import type { TopicSession } from "./types.js"
import { captureException } from "./sentry.js"

const STORE_FILENAME = ".sessions.json"
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

interface StoreData {
  sessions: [number, TopicSession][]
  offset: number
}

export class SessionStore {
  private readonly filePath: string
  private readonly ttlMs: number

  constructor(workspaceRoot: string, ttlMs = DEFAULT_TTL_MS) {
    this.filePath = path.join(workspaceRoot, STORE_FILENAME)
    this.ttlMs = ttlMs
  }

  save(sessions: Map<number, TopicSession>, offset: number = 0): void {
    const entries = Array.from(sessions.entries())
    const data: StoreData = { sessions: entries, offset }
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(data), "utf-8")
    } catch (err) {
      process.stderr.write(`store: failed to save sessions: ${err}\n`)
      captureException(err, { operation: "store.save" })
    }
  }

  load(): { active: Map<number, TopicSession>; expired: Map<number, TopicSession>; offset: number } {
    const active = new Map<number, TopicSession>()
    const expired = new Map<number, TopicSession>()
    let offset = 0
    try {
      if (!fs.existsSync(this.filePath)) return { active, expired, offset }
      const raw = fs.readFileSync(this.filePath, "utf-8")
      const parsed = JSON.parse(raw)

      // Handle both old format (array) and new format (object with sessions + offset)
      let entries: [number, TopicSession][]
      if (Array.isArray(parsed)) {
        entries = parsed as [number, TopicSession][]
      } else {
        entries = (parsed as StoreData).sessions
        offset = (parsed as StoreData).offset || 0
      }

      const now = Date.now()
      for (const [threadId, session] of entries) {
        session.activeSessionId = undefined
        // Consider both lastActivityAt and interruptedAt for staleness
        // Interrupted sessions expire based on when they were interrupted
        const staleTime = session.interruptedAt ?? session.lastActivityAt
        if (now - staleTime < this.ttlMs) {
          active.set(threadId, session)
        } else {
          // Clear interrupted flag on expired sessions since they're no longer recoverable
          session.interruptedAt = undefined
          expired.set(threadId, session)
        }
      }
    } catch (err) {
      process.stderr.write(`store: failed to load sessions: ${err}\n`)
      captureException(err, { operation: "store.load" })
    }
    return { active, expired, offset }
  }
}
