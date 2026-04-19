import fs from "node:fs/promises"
import path from "node:path"
import { loggers } from "./logger.js"
import { captureException } from "./sentry.js"
import { isErrnoException } from "./errors.js"

const QUEUE_DIR = ".minion/reply-queue"
const log = loggers.replyQueue

export interface QueuedReply {
  id: string
  text: string
  images?: string[]
  timestamp: number
  delivered: boolean
}

interface ReplyFileData {
  text: string
  images?: string[]
  timestamp: number
  delivered: boolean
}

export class ReplyQueue {
  private readonly queueDir: string
  private seq: number | null = null

  constructor(cwd: string) {
    this.queueDir = path.join(cwd, QUEUE_DIR)
  }

  private async nextSeq(): Promise<number> {
    if (this.seq === null) {
      let entries: string[]
      try {
        entries = await fs.readdir(this.queueDir)
      } catch (err) {
        if (isErrnoException(err) && err.code === "ENOENT") {
          entries = []
        } else {
          throw err
        }
      }
      let max = -1
      for (const entry of entries) {
        const match = entry.match(/^\d+-(\d{4})-[a-z0-9]+\.json$/)
        if (match) {
          const n = parseInt(match[1], 10)
          if (n > max) max = n
        }
      }
      this.seq = max + 1
    }
    return this.seq++
  }

  async push(text: string, images?: string[]): Promise<QueuedReply> {
    await fs.mkdir(this.queueDir, { recursive: true })
    const timestamp = Date.now()
    const seq = String(await this.nextSeq()).padStart(4, "0")
    const id = `${timestamp}-${seq}-${randomSuffix()}`
    const data: ReplyFileData = { text, timestamp, delivered: false }
    if (images && images.length > 0) {
      data.images = images
    }
    const filePath = path.join(this.queueDir, `${id}.json`)
    const tmp = filePath + ".tmp"
    const handle = await fs.open(tmp, "w")
    await handle.writeFile(JSON.stringify(data), "utf-8")
    await handle.datasync()
    await handle.close()
    await fs.rename(tmp, filePath)
    log.debug({ id }, "reply queued")
    return { id, ...data }
  }

  async list(): Promise<QueuedReply[]> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.queueDir)
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return []
      throw err
    }

    const jsonFiles = entries
      .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
      .sort()

    const replies: QueuedReply[] = []
    for (const file of jsonFiles) {
      try {
        const raw = await fs.readFile(path.join(this.queueDir, file), "utf-8")
        const data: ReplyFileData = JSON.parse(raw)
        const id = file.replace(/\.json$/, "")
        replies.push({ id, ...data })
      } catch (err) {
        log.warn({ err, file }, "skipping corrupt reply file")
        captureException(err, { operation: "reply-queue.list", file })
      }
    }
    return replies
  }

  async pending(): Promise<QueuedReply[]> {
    const all = await this.list()
    return all.filter((r) => !r.delivered)
  }

  async markDelivered(id: string): Promise<void> {
    const filePath = path.join(this.queueDir, `${id}.json`)
    try {
      const raw = await fs.readFile(filePath, "utf-8")
      const data: ReplyFileData = JSON.parse(raw)
      data.delivered = true
      const tmp = filePath + ".tmp"
      const handle = await fs.open(tmp, "w")
      await handle.writeFile(JSON.stringify(data), "utf-8")
      await handle.datasync()
      await handle.close()
      await fs.rename(tmp, filePath)
      log.debug({ id }, "reply marked delivered")
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        log.warn({ id }, "reply file not found for markDelivered")
        return
      }
      throw err
    }
  }

  async clear(): Promise<number> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.queueDir)
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return 0
      throw err
    }

    let removed = 0
    for (const file of entries) {
      try {
        await fs.unlink(path.join(this.queueDir, file))
        removed++
      } catch (err) {
        if (!isErrnoException(err) || err.code !== "ENOENT") {
          log.warn({ err, file }, "failed to remove reply file")
        }
      }
    }
    log.debug({ removed }, "reply queue cleared")
    return removed
  }

  async clearDelivered(): Promise<number> {
    const all = await this.list()
    let removed = 0
    for (const reply of all) {
      if (reply.delivered) {
        try {
          await fs.unlink(path.join(this.queueDir, `${reply.id}.json`))
          removed++
        } catch (err) {
          if (!isErrnoException(err) || err.code !== "ENOENT") {
            log.warn({ err, id: reply.id }, "failed to remove delivered reply")
          }
        }
      }
    }
    log.debug({ removed }, "delivered replies cleared")
    return removed
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}
