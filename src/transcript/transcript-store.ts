import fs from "node:fs/promises"
import path from "node:path"
import { captureException } from "../sentry.js"
import { loggers } from "../logger.js"
import type { TranscriptEvent } from "./types.js"

const TRANSCRIPT_DIR = ".transcripts"
const ARCHIVE_DIR = "archive"
const log = loggers.transcriptStore

/**
 * Slugs are generated as `adjective-noun` (see src/slugs.ts) but they are
 * user-visible and used to build file paths. Accept only lowercase letters,
 * digits, and the separators `-` or `_`, which is a strict superset of the
 * generator's output and prevents path traversal.
 */
const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]{0,127}$/

function assertSafeSlug(slug: string): void {
  if (!SAFE_SLUG.test(slug)) {
    throw new Error(`invalid transcript slug: ${JSON.stringify(slug)}`)
  }
}

/**
 * Channel-agnostic store for structured transcript events.
 *
 * Each session's events are held in memory as an append-only array and
 * mirrored to `<workspaceRoot>/.transcripts/<slug>.ndjson` so a restarted
 * engine (or the SSE endpoint after a reconnect) can serve a complete replay.
 *
 * Writes for a given slug are serialised via a per-slug promise chain so
 * NDJSON lines never interleave even under concurrent `append` calls.
 * Writes across different slugs proceed independently.
 */
export class TranscriptStore {
  private readonly rootDir: string
  private readonly archiveDir: string
  private readonly events = new Map<string, TranscriptEvent[]>()
  private readonly writeQueues = new Map<string, Promise<void>>()
  private readonly loaded = new Set<string>()

  constructor(workspaceRoot: string) {
    this.rootDir = path.join(workspaceRoot, TRANSCRIPT_DIR)
    this.archiveDir = path.join(this.rootDir, ARCHIVE_DIR)
  }

  /**
   * Append an event to the session's transcript. Persists to NDJSON.
   *
   * Appends are FIFO per slug. The returned promise resolves when the
   * event has been durably appended to disk.
   */
  async append(slug: string, event: TranscriptEvent): Promise<void> {
    assertSafeSlug(slug)
    const buffer = this.events.get(slug) ?? []
    buffer.push(event)
    this.events.set(slug, buffer)
    return this.enqueueWrite(slug, () => this.writeLine(slug, event))
  }

  /** Return a defensive copy of all events currently buffered for `slug`. */
  get(slug: string): TranscriptEvent[] {
    assertSafeSlug(slug)
    const buffer = this.events.get(slug)
    return buffer ? buffer.slice() : []
  }

  /**
   * Incremental sync: return every event with `seq > afterSeq`, in order.
   *
   * Pass `-1` to fetch everything (matching the snapshot envelope's
   * `highWaterMark` convention for empty transcripts).
   */
  getSince(slug: string, afterSeq: number): TranscriptEvent[] {
    assertSafeSlug(slug)
    const buffer = this.events.get(slug)
    if (!buffer || buffer.length === 0) return []
    return buffer.filter((e) => e.seq > afterSeq)
  }

  /** Highest `seq` currently buffered for `slug`, or `-1` when empty. */
  highWaterMark(slug: string): number {
    assertSafeSlug(slug)
    const buffer = this.events.get(slug)
    if (!buffer || buffer.length === 0) return -1
    return buffer[buffer.length - 1].seq
  }

  /** True when the store has any buffered events for `slug`. */
  has(slug: string): boolean {
    const buffer = this.events.get(slug)
    return !!buffer && buffer.length > 0
  }

  /** List slugs currently buffered in memory. */
  slugs(): string[] {
    return Array.from(this.events.keys())
  }

  /**
   * Rehydrate an on-disk transcript into memory. Idempotent — repeated
   * calls for the same slug are no-ops once the first load has completed.
   * Missing files are treated as empty transcripts, not errors.
   */
  async load(slug: string): Promise<TranscriptEvent[]> {
    assertSafeSlug(slug)
    if (this.loaded.has(slug)) {
      return this.get(slug)
    }
    const filePath = this.filePathFor(slug)
    try {
      const raw = await fs.readFile(filePath, "utf-8")
      const events: TranscriptEvent[] = []
      for (const line of raw.split("\n")) {
        if (!line) continue
        try {
          events.push(JSON.parse(line) as TranscriptEvent)
        } catch (err) {
          log.warn({ err, slug, operation: "transcript-store.load.parse" }, "skipping malformed NDJSON line")
        }
      }
      events.sort((a, b) => a.seq - b.seq)
      this.events.set(slug, events)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.error({ err, slug, operation: "transcript-store.load" }, "failed to load transcript")
        captureException(err, { operation: "transcript-store.load", slug })
      }
      if (!this.events.has(slug)) this.events.set(slug, [])
    }
    this.loaded.add(slug)
    return this.get(slug)
  }

  /**
   * Close out a session's transcript: flush any pending writes, then move
   * the NDJSON file into `.transcripts/archive/<slug>-<timestamp>.ndjson`
   * and drop the in-memory buffer.
   *
   * Safe to call even when no file has been written yet.
   */
  async archive(slug: string, now: number = Date.now()): Promise<string | null> {
    assertSafeSlug(slug)
    await this.flush(slug)
    const source = this.filePathFor(slug)
    const target = path.join(this.archiveDir, `${slug}-${now}.ndjson`)
    let archivedPath: string | null = target
    try {
      await fs.mkdir(this.archiveDir, { recursive: true })
      await fs.rename(source, target)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        archivedPath = null
      } else {
        log.error({ err, slug, operation: "transcript-store.archive" }, "failed to archive transcript")
        captureException(err, { operation: "transcript-store.archive", slug })
        throw err
      }
    }
    this.events.delete(slug)
    this.loaded.delete(slug)
    this.writeQueues.delete(slug)
    return archivedPath
  }

  /**
   * Wait for all queued writes for `slug` to finish. Used by `archive` and
   * exposed for tests and graceful shutdown.
   */
  async flush(slug?: string): Promise<void> {
    if (slug === undefined) {
      await Promise.all(Array.from(this.writeQueues.values()))
      return
    }
    const pending = this.writeQueues.get(slug)
    if (pending) await pending
  }

  private filePathFor(slug: string): string {
    return path.join(this.rootDir, `${slug}.ndjson`)
  }

  private enqueueWrite(slug: string, task: () => Promise<void>): Promise<void> {
    const previous = this.writeQueues.get(slug) ?? Promise.resolve()
    const next = previous.then(task, task)
    const wrapped = next.catch((err) => {
      log.error({ err, slug, operation: "transcript-store.write" }, "transcript write failed")
      captureException(err, { operation: "transcript-store.write", slug })
    })
    this.writeQueues.set(slug, wrapped)
    return wrapped
  }

  private async writeLine(slug: string, event: TranscriptEvent): Promise<void> {
    const filePath = this.filePathFor(slug)
    await fs.mkdir(this.rootDir, { recursive: true })
    await fs.appendFile(filePath, JSON.stringify(event) + "\n", "utf-8")
  }
}
