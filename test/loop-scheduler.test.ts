import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { LoopScheduler } from "../src/loops/loop-scheduler.js"
import { LoopStore } from "../src/loops/loop-store.js"
import type { LoopDefinition, LoopState, LoopOutcome } from "../src/loops/domain-types.js"
import type { LoopSchedulerConfig, LoopSchedulerCallbacks } from "../src/loops/loop-scheduler.js"

function makeDef(overrides: Partial<LoopDefinition> = {}): LoopDefinition {
  return {
    id: "test-loop",
    name: "Test Loop",
    repo: "https://github.com/org/repo",
    intervalMs: 60_000,
    prompt: "Find and fix one lint warning",
    enabled: true,
    ...overrides,
  }
}

function makeOutcome(overrides: Partial<LoopOutcome> = {}): LoopOutcome {
  return {
    runNumber: 1,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    result: "pr_opened",
    ...overrides,
  }
}

function makeConfig(overrides: Partial<LoopSchedulerConfig> = {}): LoopSchedulerConfig {
  return {
    maxConcurrentLoops: 3,
    reservedInteractiveSlots: 2,
    maxConcurrentSessions: 5,
    ...overrides,
  }
}

function makeCallbacks(overrides: Partial<LoopSchedulerCallbacks> = {}): LoopSchedulerCallbacks {
  return {
    getActiveSessionCount: () => 0,
    startLoopSession: vi.fn().mockResolvedValue(12345),
    isQuotaSleeping: () => false,
    ...overrides,
  }
}

describe("LoopScheduler", () => {
  let tmpDir: string
  let store: LoopStore

  beforeEach(() => {
    vi.useFakeTimers()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-sched-test-"))
    store = new LoopStore(tmpDir)
  })

  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("starts and registers definitions", async () => {
    const callbacks = makeCallbacks()
    const scheduler = new LoopScheduler(store, makeConfig(), callbacks)

    await scheduler.start([makeDef({ id: "a" }), makeDef({ id: "b" })])

    expect(scheduler.getDefinitions().size).toBe(2)
    expect(scheduler.getStates().size).toBe(2)

    scheduler.stop()
  })

  it("initializes state for new loop definitions", async () => {
    const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks())
    await scheduler.start([makeDef({ id: "new-loop" })])

    const state = scheduler.getStates().get("new-loop")
    expect(state).toBeDefined()
    expect(state!.enabled).toBe(true)
    expect(state!.consecutiveFailures).toBe(0)
    expect(state!.totalRuns).toBe(0)

    scheduler.stop()
  })

  it("loads persisted state on start", async () => {
    const persisted = new Map<string, LoopState>()
    persisted.set("loop-1", {
      loopId: "loop-1",
      enabled: true,
      consecutiveFailures: 2,
      totalRuns: 10,
      outcomes: [],
    })
    await store.save(persisted)

    const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks())
    await scheduler.start([makeDef({ id: "loop-1" })])

    const state = scheduler.getStates().get("loop-1")
    expect(state!.consecutiveFailures).toBe(2)
    expect(state!.totalRuns).toBe(10)

    scheduler.stop()
  })

  it("purges state for undefined loops on start", async () => {
    const persisted = new Map<string, LoopState>()
    persisted.set("stale-loop", {
      loopId: "stale-loop",
      enabled: true,
      consecutiveFailures: 0,
      totalRuns: 5,
      outcomes: [],
    })
    await store.save(persisted)

    const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks())
    await scheduler.start([makeDef({ id: "active-loop" })])

    expect(scheduler.getStates().has("stale-loop")).toBe(false)
    expect(scheduler.getStates().has("active-loop")).toBe(true)

    scheduler.stop()
  })

  it("fires loop after staggered delay", async () => {
    const startLoopSession = vi.fn().mockResolvedValue(100)
    const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks({ startLoopSession }))

    await scheduler.start([makeDef({ id: "loop-1" })])

    // Stagger delay: index 0 → 0 * 30s + 30s = 30s
    await vi.advanceTimersByTimeAsync(30_001)

    expect(startLoopSession).toHaveBeenCalledOnce()
    expect(startLoopSession).toHaveBeenCalledWith(
      "loop-1",
      expect.objectContaining({ id: "loop-1" }),
      expect.objectContaining({ loopId: "loop-1" }),
    )

    scheduler.stop()
  })

  it("does not fire disabled loops", async () => {
    const startLoopSession = vi.fn().mockResolvedValue(100)
    const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks({ startLoopSession }))

    await scheduler.start([makeDef({ id: "loop-1", enabled: false })])

    await vi.advanceTimersByTimeAsync(120_000)

    expect(startLoopSession).not.toHaveBeenCalled()

    scheduler.stop()
  })

  it("skips firing when quota is sleeping", async () => {
    const startLoopSession = vi.fn().mockResolvedValue(100)
    const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks({
      startLoopSession,
      isQuotaSleeping: () => true,
    }))

    await scheduler.start([makeDef({ id: "loop-1" })])

    await vi.advanceTimersByTimeAsync(30_001)

    expect(startLoopSession).not.toHaveBeenCalled()

    scheduler.stop()
  })

  it("skips firing when no capacity (sessions full)", async () => {
    const startLoopSession = vi.fn().mockResolvedValue(100)
    const scheduler = new LoopScheduler(
      store,
      makeConfig({ maxConcurrentSessions: 5, reservedInteractiveSlots: 2 }),
      makeCallbacks({
        startLoopSession,
        getActiveSessionCount: () => 3, // 3 >= 5-2 = 3, no capacity
      }),
    )

    await scheduler.start([makeDef({ id: "loop-1" })])
    await vi.advanceTimersByTimeAsync(30_001)

    expect(startLoopSession).not.toHaveBeenCalled()

    scheduler.stop()
  })

  it("skips firing when max concurrent loops reached", async () => {
    const startLoopSession = vi.fn().mockResolvedValue(100)
    const scheduler = new LoopScheduler(
      store,
      makeConfig({ maxConcurrentLoops: 1 }),
      makeCallbacks({ startLoopSession }),
    )

    await scheduler.start([makeDef({ id: "loop-1" }), makeDef({ id: "loop-2" })])

    // First fires at 30s stagger
    await vi.advanceTimersByTimeAsync(30_001)
    expect(startLoopSession).toHaveBeenCalledOnce()
    expect(scheduler.getActiveLoopThreads().size).toBe(1)

    // Second fires at 60s stagger but blocked by maxConcurrentLoops=1
    await vi.advanceTimersByTimeAsync(30_001)
    expect(startLoopSession).toHaveBeenCalledOnce() // still just once

    scheduler.stop()
  })

  describe("recordOutcome", () => {
    it("records success and resets consecutive failures", async () => {
      const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks())
      await scheduler.start([makeDef({ id: "loop-1" })])

      const state = scheduler.getStates().get("loop-1")!
      state.consecutiveFailures = 2

      // Simulate an active loop
      scheduler.getActiveLoopThreads().set("loop-1", 100)

      scheduler.recordOutcome("loop-1", makeOutcome({ result: "pr_opened", prUrl: "https://github.com/org/repo/pull/1" }))

      expect(state.consecutiveFailures).toBe(0)
      expect(state.totalRuns).toBe(1)
      expect(state.lastPrUrl).toBe("https://github.com/org/repo/pull/1")
      expect(scheduler.getActiveLoopThreads().has("loop-1")).toBe(false)

      scheduler.stop()
    })

    it("increments failures on error", async () => {
      const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks())
      await scheduler.start([makeDef({ id: "loop-1" })])

      scheduler.getActiveLoopThreads().set("loop-1", 100)
      scheduler.recordOutcome("loop-1", makeOutcome({ result: "errored" }))

      const state = scheduler.getStates().get("loop-1")!
      expect(state.consecutiveFailures).toBe(1)

      scheduler.stop()
    })

    it("backs off after 3 consecutive failures", async () => {
      const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks())
      const def = makeDef({ id: "loop-1", intervalMs: 60_000 })
      await scheduler.start([def])

      const state = scheduler.getStates().get("loop-1")!
      state.consecutiveFailures = 2

      scheduler.getActiveLoopThreads().set("loop-1", 100)
      scheduler.recordOutcome("loop-1", makeOutcome({ result: "errored" }))

      expect(state.consecutiveFailures).toBe(3)
      // nextRunAt should be set to now + 2x interval (backoff)
      expect(state.nextRunAt).toBeGreaterThan(Date.now() + def.intervalMs)

      scheduler.stop()
    })

    it("auto-disables after max consecutive failures", async () => {
      const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks())
      await scheduler.start([makeDef({ id: "loop-1", maxConsecutiveFailures: 3 })])

      const state = scheduler.getStates().get("loop-1")!
      state.consecutiveFailures = 2

      scheduler.getActiveLoopThreads().set("loop-1", 100)
      scheduler.recordOutcome("loop-1", makeOutcome({ result: "errored" }))

      expect(state.consecutiveFailures).toBe(3)
      expect(state.enabled).toBe(false)
      expect(state.nextRunAt).toBeUndefined()

      scheduler.stop()
    })

    it("trims outcome history to maxOutcomeHistory", async () => {
      const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks())
      await scheduler.start([makeDef({ id: "loop-1", maxOutcomeHistory: 3 })])

      for (let i = 0; i < 5; i++) {
        scheduler.getActiveLoopThreads().set("loop-1", 100)
        scheduler.recordOutcome("loop-1", makeOutcome({ runNumber: i + 1, result: "no_findings" }))
      }

      const state = scheduler.getStates().get("loop-1")!
      expect(state.outcomes).toHaveLength(3)
      expect(state.outcomes[0].runNumber).toBe(3)
      expect(state.outcomes[2].runNumber).toBe(5)

      scheduler.stop()
    })

    it("records no_findings as success (resets failures)", async () => {
      const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks())
      await scheduler.start([makeDef({ id: "loop-1" })])

      const state = scheduler.getStates().get("loop-1")!
      state.consecutiveFailures = 2
      scheduler.getActiveLoopThreads().set("loop-1", 100)

      scheduler.recordOutcome("loop-1", makeOutcome({ result: "no_findings" }))

      expect(state.consecutiveFailures).toBe(0)

      scheduler.stop()
    })

    it("increments failures on quota_exhausted", async () => {
      const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks())
      await scheduler.start([makeDef({ id: "loop-1" })])

      scheduler.getActiveLoopThreads().set("loop-1", 100)
      scheduler.recordOutcome("loop-1", makeOutcome({ result: "quota_exhausted" }))

      expect(scheduler.getStates().get("loop-1")!.consecutiveFailures).toBe(1)

      scheduler.stop()
    })
  })

  describe("enable/disable", () => {
    it("disableLoop stops the timer and marks state disabled", async () => {
      const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks())
      await scheduler.start([makeDef({ id: "loop-1" })])

      const result = scheduler.disableLoop("loop-1")
      expect(result).toBe(true)

      const state = scheduler.getStates().get("loop-1")!
      expect(state.enabled).toBe(false)
      expect(state.nextRunAt).toBeUndefined()

      scheduler.stop()
    })

    it("enableLoop resets failures and reschedules", async () => {
      const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks())
      await scheduler.start([makeDef({ id: "loop-1" })])

      const state = scheduler.getStates().get("loop-1")!
      state.enabled = false
      state.consecutiveFailures = 5

      const result = scheduler.enableLoop("loop-1")
      expect(result).toBe(true)
      expect(state.enabled).toBe(true)
      expect(state.consecutiveFailures).toBe(0)
      expect(state.nextRunAt).toBeDefined()

      scheduler.stop()
    })

    it("returns false for unknown loop id", async () => {
      const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks())
      await scheduler.start([makeDef({ id: "loop-1" })])

      expect(scheduler.enableLoop("unknown")).toBe(false)
      expect(scheduler.disableLoop("unknown")).toBe(false)

      scheduler.stop()
    })
  })

  describe("stop", () => {
    it("clears all timers and active loops", async () => {
      const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks())
      await scheduler.start([makeDef({ id: "a" }), makeDef({ id: "b" })])

      scheduler.getActiveLoopThreads().set("a", 100)

      scheduler.stop()

      expect(scheduler.getActiveLoopThreads().size).toBe(0)
    })

    it("does not fire loops after stop", async () => {
      const startLoopSession = vi.fn().mockResolvedValue(100)
      const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks({ startLoopSession }))
      await scheduler.start([makeDef({ id: "loop-1" })])

      scheduler.stop()
      await vi.advanceTimersByTimeAsync(120_000)

      expect(startLoopSession).not.toHaveBeenCalled()
    })
  })

  describe("isLoopActive", () => {
    it("returns true when loop has an active thread", async () => {
      const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks())
      await scheduler.start([makeDef({ id: "loop-1" })])

      expect(scheduler.isLoopActive("loop-1")).toBe(false)
      scheduler.getActiveLoopThreads().set("loop-1", 100)
      expect(scheduler.isLoopActive("loop-1")).toBe(true)

      scheduler.stop()
    })
  })

  describe("staggered startup", () => {
    it("staggers multiple loop starts", async () => {
      const startLoopSession = vi.fn().mockResolvedValue(100)
      const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks({ startLoopSession }))

      await scheduler.start([
        makeDef({ id: "a", intervalMs: 600_000 }),
        makeDef({ id: "b", intervalMs: 600_000 }),
        makeDef({ id: "c", intervalMs: 600_000 }),
      ])

      // First loop fires at ~30s stagger
      await vi.advanceTimersByTimeAsync(30_001)
      expect(startLoopSession).toHaveBeenCalledTimes(1)
      expect(startLoopSession.mock.calls[0][0]).toBe("a")

      // Second at ~60s stagger
      await vi.advanceTimersByTimeAsync(30_001)
      expect(startLoopSession).toHaveBeenCalledTimes(2)
      expect(startLoopSession.mock.calls[1][0]).toBe("b")

      // Third at ~90s stagger
      await vi.advanceTimersByTimeAsync(30_001)
      expect(startLoopSession).toHaveBeenCalledTimes(3)
      expect(startLoopSession.mock.calls[2][0]).toBe("c")

      scheduler.stop()
    })
  })

  describe("persistence", () => {
    it("persists state after start", async () => {
      const scheduler = new LoopScheduler(store, makeConfig(), makeCallbacks())
      await scheduler.start([makeDef({ id: "loop-1" })])

      const loaded = await store.load()
      expect(loaded.has("loop-1")).toBe(true)

      scheduler.stop()
    })

    it("persists state after recordOutcome", async () => {
      vi.useRealTimers()
      const realTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-sched-persist-"))
      const realStore = new LoopStore(realTmpDir)
      const scheduler = new LoopScheduler(realStore, makeConfig(), makeCallbacks())
      await scheduler.start([makeDef({ id: "loop-1" })])

      scheduler.getActiveLoopThreads().set("loop-1", 100)
      scheduler.recordOutcome("loop-1", makeOutcome({ result: "pr_opened" }))

      // Give the async persist time to complete
      await new Promise((r) => setTimeout(r, 50))

      const loaded = await realStore.load()
      expect(loaded.get("loop-1")!.totalRuns).toBe(1)

      scheduler.stop()
      fs.rmSync(realTmpDir, { recursive: true, force: true })
      vi.useFakeTimers()
    })
  })
})
