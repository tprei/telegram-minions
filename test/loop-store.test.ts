import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { LoopStore } from "../src/loops/loop-store.js"
import type { LoopState } from "../src/loops/domain-types.js"

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    loopId: "test-loop",
    enabled: true,
    consecutiveFailures: 0,
    totalRuns: 0,
    outcomes: [],
    ...overrides,
  }
}

describe("LoopStore", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-store-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("round-trips save and load", async () => {
    const store = new LoopStore(tmpDir)
    const loops = new Map<string, LoopState>()
    loops.set("loop-1", makeState({ loopId: "loop-1" }))

    await store.save(loops)

    const loaded = await store.load()
    expect(loaded.size).toBe(1)
    expect(loaded.get("loop-1")?.loopId).toBe("loop-1")
    expect(loaded.get("loop-1")?.enabled).toBe(true)
  })

  it("returns empty map when no file exists", async () => {
    const store = new LoopStore(tmpDir)
    const loaded = await store.load()
    expect(loaded.size).toBe(0)
  })

  it("returns empty map on corrupt JSON", async () => {
    const store = new LoopStore(tmpDir)
    fs.writeFileSync(path.join(tmpDir, ".loops.json"), "not json", "utf-8")
    const loaded = await store.load()
    expect(loaded.size).toBe(0)
  })

  it("falls back to backup when main file is corrupt", async () => {
    const store = new LoopStore(tmpDir)
    const loops = new Map<string, LoopState>()
    loops.set("loop-1", makeState({ loopId: "loop-1" }))
    await store.save(loops)

    fs.writeFileSync(path.join(tmpDir, ".loops.json"), "corrupted!", "utf-8")

    const loaded = await store.load()
    expect(loaded.size).toBe(1)
    expect(loaded.get("loop-1")?.loopId).toBe("loop-1")
  })

  it("handles multiple loops", async () => {
    const store = new LoopStore(tmpDir)
    const loops = new Map<string, LoopState>()
    loops.set("loop-1", makeState({ loopId: "loop-1" }))
    loops.set("loop-2", makeState({ loopId: "loop-2", enabled: false }))
    loops.set("loop-3", makeState({ loopId: "loop-3", totalRuns: 5 }))

    await store.save(loops)

    const loaded = await store.load()
    expect(loaded.size).toBe(3)
    expect(loaded.get("loop-2")?.enabled).toBe(false)
    expect(loaded.get("loop-3")?.totalRuns).toBe(5)
  })

  it("second save overwrites the first", async () => {
    const store = new LoopStore(tmpDir)
    const loops1 = new Map<string, LoopState>()
    loops1.set("loop-1", makeState({ loopId: "loop-1" }))
    await store.save(loops1)

    const loops2 = new Map<string, LoopState>()
    loops2.set("loop-2", makeState({ loopId: "loop-2" }))
    await store.save(loops2)

    const loaded = await store.load()
    expect(loaded.size).toBe(1)
    expect(loaded.has("loop-1")).toBe(false)
    expect(loaded.get("loop-2")?.loopId).toBe("loop-2")
  })

  it("round-trips an empty map", async () => {
    const store = new LoopStore(tmpDir)
    await store.save(new Map())

    const loaded = await store.load()
    expect(loaded.size).toBe(0)
  })

  it("uses atomic write (no .tmp file left after save)", async () => {
    const store = new LoopStore(tmpDir)
    await store.save(new Map([["loop-1", makeState()]]))

    expect(fs.existsSync(path.join(tmpDir, ".loops.json"))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, ".loops.json.tmp"))).toBe(false)
  })

  it("preserves outcome history through save/load", async () => {
    const store = new LoopStore(tmpDir)
    const state = makeState({
      loopId: "loop-1",
      totalRuns: 2,
      consecutiveFailures: 1,
      lastPrUrl: "https://github.com/org/repo/pull/42",
      lastRunAt: 1700000000000,
      nextRunAt: 1700003600000,
      outcomes: [
        {
          runNumber: 1,
          startedAt: 1700000000000,
          finishedAt: 1700000060000,
          result: "pr_opened",
          prUrl: "https://github.com/org/repo/pull/42",
          threadId: 100,
        },
        {
          runNumber: 2,
          startedAt: 1700003600000,
          finishedAt: 1700003660000,
          result: "errored",
          error: "Session crashed",
        },
      ],
    })

    const loops = new Map<string, LoopState>()
    loops.set("loop-1", state)
    await store.save(loops)

    const loaded = await store.load()
    const loadedState = loaded.get("loop-1")!
    expect(loadedState.totalRuns).toBe(2)
    expect(loadedState.consecutiveFailures).toBe(1)
    expect(loadedState.lastPrUrl).toBe("https://github.com/org/repo/pull/42")
    expect(loadedState.outcomes).toHaveLength(2)
    expect(loadedState.outcomes[0].result).toBe("pr_opened")
    expect(loadedState.outcomes[0].prUrl).toBe("https://github.com/org/repo/pull/42")
    expect(loadedState.outcomes[1].result).toBe("errored")
    expect(loadedState.outcomes[1].error).toBe("Session crashed")
  })

  it("returns empty map on empty file", async () => {
    const store = new LoopStore(tmpDir)
    fs.writeFileSync(path.join(tmpDir, ".loops.json"), "", "utf-8")
    const loaded = await store.load()
    expect(loaded.size).toBe(0)
  })

  it("handles JSON null gracefully", async () => {
    const store = new LoopStore(tmpDir)
    fs.writeFileSync(path.join(tmpDir, ".loops.json"), "null", "utf-8")
    const loaded = await store.load()
    expect(loaded.size).toBe(0)
  })

  it("handles legacy array format", async () => {
    const store = new LoopStore(tmpDir)
    const entries: [string, LoopState][] = [
      ["loop-1", makeState({ loopId: "loop-1" })],
    ]
    fs.writeFileSync(path.join(tmpDir, ".loops.json"), JSON.stringify(entries), "utf-8")

    const loaded = await store.load()
    expect(loaded.size).toBe(1)
    expect(loaded.get("loop-1")?.loopId).toBe("loop-1")
  })
})
