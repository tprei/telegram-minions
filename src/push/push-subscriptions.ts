import fs from "node:fs/promises"
import path from "node:path"

const SUBSCRIPTIONS_FILE = ".push/subscriptions.json"

export interface PushSubscriptionKeys {
  p256dh: string
  auth: string
}

export interface PushSubscription {
  endpoint: string
  keys: PushSubscriptionKeys
  /** ISO-8601 timestamp. Used for pruning old subs. */
  subscribedAt: string
}

/**
 * Disk-backed store for Web Push subscriptions.
 *
 * Subscriptions live in `${workspaceRoot}/.push/subscriptions.json` as a JSON
 * array. Deduplication is by endpoint URL — re-subscribing refreshes the
 * keys + timestamp without creating a duplicate entry.
 */
export class PushSubscriptionStore {
  private readonly filePath: string
  private subs: PushSubscription[] = []
  private loaded = false
  private savePromise: Promise<void> = Promise.resolve()

  constructor(workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, SUBSCRIPTIONS_FILE)
  }

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await fs.readFile(this.filePath, "utf-8")
      const parsed = JSON.parse(raw) as PushSubscription[]
      if (Array.isArray(parsed)) this.subs = parsed
    } catch {
      this.subs = []
    }
    this.loaded = true
  }

  list(): PushSubscription[] {
    return [...this.subs]
  }

  async add(sub: { endpoint: string; keys: PushSubscriptionKeys }): Promise<void> {
    await this.load()
    const now = new Date().toISOString()
    const idx = this.subs.findIndex((s) => s.endpoint === sub.endpoint)
    if (idx >= 0) {
      this.subs[idx] = { endpoint: sub.endpoint, keys: sub.keys, subscribedAt: now }
    } else {
      this.subs.push({ endpoint: sub.endpoint, keys: sub.keys, subscribedAt: now })
    }
    await this.persist()
  }

  async remove(endpoint: string): Promise<boolean> {
    await this.load()
    const before = this.subs.length
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint)
    if (this.subs.length === before) return false
    await this.persist()
    return true
  }

  private async persist(): Promise<void> {
    this.savePromise = this.savePromise.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      await fs.writeFile(this.filePath, JSON.stringify(this.subs, null, 2) + "\n", { mode: 0o600 })
    })
    await this.savePromise
  }
}
