import fs from "node:fs/promises"
import path from "node:path"
import type { LoopState } from "./domain-types.js"
import { captureException } from "../sentry.js"
import { loggers } from "../logger.js"

const STORE_FILENAME = ".loops.json"
const log = loggers.loopStore

interface LoopStoreData {
  loops: [string, LoopState][]
}

export class LoopStore {
  private readonly filePath: string
  private readonly backupPath: string
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, STORE_FILENAME)
    this.backupPath = this.filePath + ".bak"
  }

  async save(loops: Map<string, LoopState>): Promise<void> {
    this.saveQueue = this.saveQueue.then(
      () => this.doSave(loops),
      () => this.doSave(loops),
    )
    return this.saveQueue
  }

  private async doSave(loops: Map<string, LoopState>): Promise<void> {
    const entries = Array.from(loops.entries())
    const data: LoopStoreData = { loops: entries }
    const tmp = this.filePath + ".tmp"
    try {
      await fs.mkdir(path.dirname(tmp), { recursive: true })
      await fs.writeFile(tmp, JSON.stringify(data), "utf-8")
      await fs.rename(tmp, this.filePath)
      try {
        await fs.copyFile(this.filePath, this.backupPath)
      } catch {
        // non-fatal
      }
    } catch (err) {
      log.error({ err, operation: "loop-store.save" }, "failed to save loops")
      captureException(err, { operation: "loop-store.save" })
    }
  }

  async load(): Promise<Map<string, LoopState>> {
    const result = await this.loadFile(this.filePath)
    if (!result) {
      const backup = await this.loadFile(this.backupPath)
      if (backup) {
        log.warn("main loop store file missing/corrupt, recovered from backup")
        return this.parseEntries(backup)
      }
      return new Map()
    }
    return this.parseEntries(result)
  }

  private async loadFile(filePath: string): Promise<unknown | null> {
    try {
      const raw = await fs.readFile(filePath, "utf-8")
      return JSON.parse(raw)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        const isBadJson = err instanceof SyntaxError
        log.error(
          { err, isBadJson, path: filePath, operation: "loop-store.load" },
          isBadJson ? "corrupt loop store file" : "failed to load loops",
        )
        if (!isBadJson) captureException(err, { operation: "loop-store.load" })
      }
      return null
    }
  }

  private parseEntries(parsed: unknown): Map<string, LoopState> {
    const loops = new Map<string, LoopState>()

    let entries: [string, LoopState][]
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      entries = (parsed as LoopStoreData).loops ?? []
    } else if (Array.isArray(parsed)) {
      entries = parsed as [string, LoopState][]
    } else {
      entries = []
    }

    for (const [loopId, state] of entries) {
      loops.set(loopId, state)
    }
    return loops
  }
}
