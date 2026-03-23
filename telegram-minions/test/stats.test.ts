import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { StatsTracker, type SessionRecord } from "../src/stats.js"

describe("StatsTracker", () => {
  let tmpDir: string
  let tracker: StatsTracker

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-test-"))
    tracker = new StatsTracker(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeRecord(overrides?: Partial<SessionRecord>): SessionRecord {
    return {
      slug: "bold-arc",
      repo: "test-repo",
      mode: "task",
      state: "completed",
      durationMs: 60000,
      totalTokens: 5000,
            timestamp: Date.now(),
      ...overrides,
    }
  }

  it("records and loads entries", () => {
    tracker.record(makeRecord())
    tracker.record(makeRecord({ slug: "calm-bay" }))
    const loaded = tracker.load()
    expect(loaded).toHaveLength(2)
    expect(loaded[0].slug).toBe("bold-arc")
    expect(loaded[1].slug).toBe("calm-bay")
  })

  it("returns empty array when no file exists", () => {
    expect(tracker.load()).toEqual([])
  })

  it("aggregates stats correctly", () => {
    tracker.record(makeRecord({ durationMs: 30000, totalTokens: 1000 }))
    tracker.record(makeRecord({ durationMs: 90000, totalTokens: 3000, state: "errored" }))

    const agg = tracker.aggregate()
    expect(agg.totalSessions).toBe(2)
    expect(agg.completedSessions).toBe(1)
    expect(agg.erroredSessions).toBe(1)
    expect(agg.totalTokens).toBe(4000)
    expect(agg.totalDurationMs).toBe(120000)
    expect(agg.avgDurationMs).toBe(60000)
  })

  it("filters by days when aggregating", () => {
    const old = Date.now() - 10 * 86400000
    tracker.record(makeRecord({ timestamp: old }))
    tracker.record(makeRecord({ timestamp: Date.now() }))

    const agg = tracker.aggregate(7)
    expect(agg.totalSessions).toBe(1)
  })

  it("caps at MAX_RECORDS", () => {
    for (let i = 0; i < 510; i++) {
      tracker.record(makeRecord({ slug: `slug-${i}` }))
    }
    const loaded = tracker.load()
    expect(loaded.length).toBeLessThanOrEqual(500)
    expect(loaded[loaded.length - 1].slug).toBe("slug-509")
  })
})
