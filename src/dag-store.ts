import fs from "node:fs/promises"
import path from "node:path"
import type { DagGraph } from "./dag/dag.js"
import { captureException } from "./sentry.js"
import { loggers } from "./logger.js"

const STORE_FILENAME = ".dags.json"
const log = loggers.dagStore

interface DagStoreData {
  dags: [string, DagGraph][]
}

export class DagStore {
  private readonly filePath: string
  private readonly backupPath: string

  constructor(workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, STORE_FILENAME)
    this.backupPath = this.filePath + ".bak"
  }

  async save(dags: Map<string, DagGraph>): Promise<void> {
    const entries = Array.from(dags.entries())
    const data: DagStoreData = { dags: entries }
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
      log.error({ err, operation: "dag-store.save" }, "failed to save DAGs")
      captureException(err, { operation: "dag-store.save" })
    }
  }

  async load(): Promise<Map<string, DagGraph>> {
    const result = await this.loadFile(this.filePath)
    if (!result) {
      const backup = await this.loadFile(this.backupPath)
      if (backup) {
        log.warn("main DAG store file missing/corrupt, recovered from backup")
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
          { err, isBadJson, path: filePath, operation: "dag-store.load" },
          isBadJson ? "corrupt DAG store file" : "failed to load DAGs",
        )
        if (!isBadJson) captureException(err, { operation: "dag-store.load" })
      }
      return null
    }
  }

  private parseEntries(parsed: unknown): Map<string, DagGraph> {
    const dags = new Map<string, DagGraph>()

    let entries: [string, DagGraph][]
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      entries = (parsed as DagStoreData).dags ?? []
    } else if (Array.isArray(parsed)) {
      entries = parsed as [string, DagGraph][]
    } else {
      entries = []
    }

    for (const [dagId, graph] of entries) {
      dags.set(dagId, graph)
    }
    return dags
  }
}
