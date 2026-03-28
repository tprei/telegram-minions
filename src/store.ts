import fs from "node:fs/promises"
import path from "node:path"
import type { TopicSession } from "./types.js"
import { captureException } from "./sentry.js"
import { loggers } from "./logger.js"

const STORE_FILENAME = ".sessions.json"
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const log = loggers.store

interface StoreData {
  sessions: [number, TopicSession][]
  offset: number
}

export class SessionStore {
  private readonly filePath: string
  private readonly backupPath: string
  private readonly ttlMs: number

  constructor(workspaceRoot: string, ttlMs = DEFAULT_TTL_MS) {
    this.filePath = path.join(workspaceRoot, STORE_FILENAME)
    this.backupPath = this.filePath + ".bak"
    this.ttlMs = ttlMs
  }

  async save(sessions: Map<number, TopicSession>, offset: number = 0): Promise<void> {
    const entries = Array.from(sessions.entries())
    const data: StoreData = { sessions: entries, offset }
    const tmp = this.filePath + ".tmp"
    try {
      await fs.mkdir(path.dirname(tmp), { recursive: true })
      await fs.writeFile(tmp, JSON.stringify(data), "utf-8")
      await fs.rename(tmp, this.filePath)
      // Keep a backup of the last good write for crash recovery
      try {
        await fs.copyFile(this.filePath, this.backupPath)
      } catch {
        // non-fatal
      }
    } catch (err) {
      log.error({ err, operation: "store.save" }, "failed to save sessions")
      captureException(err, { operation: "store.save" })
    }
  }

  async load(): Promise<{ active: Map<number, TopicSession>; expired: Map<number, TopicSession>; offset: number }> {
    const active = new Map<number, TopicSession>()
    const expired = new Map<number, TopicSession>()
    let offset = 0

    const result = await this.loadFile(this.filePath)
    if (!result) {
      // Main file is missing or corrupt — try backup
      const backup = await this.loadFile(this.backupPath)
      if (backup) {
        log.warn("main store file missing/corrupt, recovered from backup")
        this.parseEntries(backup.parsed, backup.raw, active, expired)
        offset = backup.offset
      }
      return { active, expired, offset }
    }

    this.parseEntries(result.parsed, result.raw, active, expired)
    offset = result.offset
    return { active, expired, offset }
  }

  private async loadFile(filePath: string): Promise<{ parsed: unknown; raw: string; offset: number } | null> {
    try {
      const raw = await fs.readFile(filePath, "utf-8")
      const parsed = JSON.parse(raw)
      let offset = 0
      if (parsed && !Array.isArray(parsed)) {
        offset = (parsed as StoreData).offset || 0
      }
      return { parsed, raw, offset }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        const isBadJson = err instanceof SyntaxError
        log.error({ err, isBadJson, path: filePath, operation: "store.load" }, isBadJson ? "corrupt file" : "failed to load sessions")
        if (!isBadJson) captureException(err, { operation: "store.load" })
      }
      return null
    }
  }

  private parseEntries(parsed: unknown, _raw: string, active: Map<number, TopicSession>, expired: Map<number, TopicSession>): void {
    let entries: [number, TopicSession][]
    if (Array.isArray(parsed)) {
      entries = parsed as [number, TopicSession][]
    } else if (parsed && typeof parsed === "object") {
      entries = (parsed as StoreData).sessions ?? []
    } else {
      entries = []
    }

    const now = Date.now()
    for (const [threadId, session] of entries) {
      session.activeSessionId = undefined
      const staleTime = session.interruptedAt ?? session.lastActivityAt
      if (now - staleTime < this.ttlMs) {
        active.set(threadId, session)
      } else {
        session.interruptedAt = undefined
        expired.set(threadId, session)
      }
    }
  }
}
