import fs from "node:fs"
import path from "node:path"
import type { TopicSession } from "./types.js"

const STORE_FILENAME = ".sessions.json"
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

export class SessionStore {
  private readonly filePath: string
  private readonly ttlMs: number

  constructor(workspaceRoot: string, ttlMs = DEFAULT_TTL_MS) {
    this.filePath = path.join(workspaceRoot, STORE_FILENAME)
    this.ttlMs = ttlMs
  }

  save(sessions: Map<number, TopicSession>): void {
    const entries = Array.from(sessions.entries())
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(entries), "utf-8")
    } catch (err) {
      process.stderr.write(`store: failed to save sessions: ${err}\n`)
    }
  }

  load(): Map<number, TopicSession> {
    const result = new Map<number, TopicSession>()
    try {
      if (!fs.existsSync(this.filePath)) return result
      const raw = fs.readFileSync(this.filePath, "utf-8")
      const entries = JSON.parse(raw) as [number, TopicSession][]
      const now = Date.now()
      for (const [threadId, session] of entries) {
        if (now - session.lastActivityAt < this.ttlMs) {
          // Persisted sessions are never actively running
          session.activeSessionId = undefined
          result.set(threadId, session)
        }
      }
    } catch (err) {
      process.stderr.write(`store: failed to load sessions: ${err}\n`)
    }
    return result
  }
}
