import fs from "node:fs/promises"
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

  async save(sessions: Map<number, TopicSession>, offset: number = 0): Promise<void> {
    const entries = Array.from(sessions.entries())
    const data: StoreData = { sessions: entries, offset }
    const tmp = this.filePath + ".tmp"
    try {
      await fs.writeFile(tmp, JSON.stringify(data), "utf-8")
      await fs.rename(tmp, this.filePath)
    } catch (err) {
      process.stderr.write(`store: failed to save sessions: ${err}\n`)
      captureException(err, { operation: "store.save" })
    }
  }

  async load(): Promise<{ active: Map<number, TopicSession>; expired: Map<number, TopicSession>; offset: number }> {
    const active = new Map<number, TopicSession>()
    const expired = new Map<number, TopicSession>()
    let offset = 0
    try {
      const raw = await fs.readFile(this.filePath, "utf-8")
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
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        const isBadJson = err instanceof SyntaxError
        process.stderr.write(`store: ${isBadJson ? "corrupt file, starting fresh" : "failed to load sessions"}: ${err}\n`)
        if (!isBadJson) captureException(err, { operation: "store.load" })
      }
    }
    return { active, expired, offset }
  }
}
