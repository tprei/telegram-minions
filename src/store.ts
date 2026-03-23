import fs from "node:fs"
import path from "node:path"
import type { TopicSession } from "./types.js"
import { captureException } from "./sentry.js"

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
      captureException(err, { operation: "store.save" })
    }
  }

  load(): { active: Map<number, TopicSession>; expired: Map<number, TopicSession> } {
    const active = new Map<number, TopicSession>()
    const expired = new Map<number, TopicSession>()
    try {
      if (!fs.existsSync(this.filePath)) return { active, expired }
      const raw = fs.readFileSync(this.filePath, "utf-8")
      const entries = JSON.parse(raw) as [number, TopicSession][]
      const now = Date.now()
      for (const [threadId, session] of entries) {
        session.activeSessionId = undefined
        if (now - session.lastActivityAt < this.ttlMs) {
          active.set(threadId, session)
        } else {
          expired.set(threadId, session)
        }
      }
    } catch (err) {
      process.stderr.write(`store: failed to load sessions: ${err}\n`)
      captureException(err, { operation: "store.load" })
    }
    return { active, expired }
  }
}
