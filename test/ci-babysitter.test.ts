import { describe, it, expect, vi, beforeEach } from "vitest"
import { CIBabysitter } from "../src/ci/ci-babysitter.js"
import type { DispatcherContext } from "../src/orchestration/dispatcher-context.js"
import type { TopicSession } from "../src/domain/session-types.js"
// Mock external dependencies
vi.mock("../src/ci/ci-babysit.js", () => ({
  waitForCI: vi.fn(),
  getFailedCheckLogs: vi.fn(),
  buildCIFixPrompt: vi.fn(),
  buildQualityGateFixPrompt: vi.fn(),
  buildMergeConflictPrompt: vi.fn(),
  checkPRMergeability: vi.fn(),
}))

vi.mock("../src/ci/quality-gates.js", () => ({
  runQualityGates: vi.fn(),
}))

vi.mock("../src/sentry.js", () => ({
  captureException: vi.fn(),
}))

import { waitForCI, getFailedCheckLogs, buildCIFixPrompt, checkPRMergeability, buildMergeConflictPrompt, buildQualityGateFixPrompt } from "../src/ci/ci-babysit.js"
import { runQualityGates } from "../src/ci/quality-gates.js"

const mockWaitForCI = vi.mocked(waitForCI)
const mockCheckPRMergeability = vi.mocked(checkPRMergeability)
const mockGetFailedCheckLogs = vi.mocked(getFailedCheckLogs)
const mockBuildCIFixPrompt = vi.mocked(buildCIFixPrompt)
const mockBuildMergeConflictPrompt = vi.mocked(buildMergeConflictPrompt)
const mockBuildQualityGateFixPrompt = vi.mocked(buildQualityGateFixPrompt)
const mockRunQualityGates = vi.mocked(runQualityGates)

function makeSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: "100",
    repo: "org/repo",
    cwd: "/tmp/workspace",
    slug: "test-slug",
    conversation: [],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

function makeContext(overrides: Partial<DispatcherContext> = {}): DispatcherContext {
  return {
    config: {
      ci: { babysitEnabled: true, maxRetries: 2, pollIntervalMs: 100, pollTimeoutMs: 1000, dagCiPolicy: "skip" },
    } as any,
    telegram: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    } as any,
    observer: {} as any,
    stats: {} as any,
    profileStore: {} as any,
    broadcaster: undefined,
    sessions: new Map(),
    topicSessions: new Map(),
    dags: new Map(),
    abortControllers: new Map(),
    refreshGitToken: vi.fn().mockResolvedValue(undefined),
    spawnTopicAgent: vi.fn().mockResolvedValue(undefined),
    spawnCIFixAgent: vi.fn().mockImplementation(async (_s, _t, cb) => cb()),
    prepareWorkspace: vi.fn().mockResolvedValue("/tmp"),
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    cleanBuildArtifacts: vi.fn(),
    prepareFanInBranch: vi.fn().mockResolvedValue(null),
    mergeUpstreamBranches: vi.fn().mockReturnValue({ ok: true, conflictFiles: [] }),
    downloadPhotos: vi.fn().mockResolvedValue([]),
    pushToConversation: vi.fn(),
    extractPRFromConversation: vi.fn().mockReturnValue(null),
    persistTopicSessions: vi.fn().mockResolvedValue(undefined),
    persistDags: vi.fn().mockResolvedValue(undefined),
    updatePinnedSummary: vi.fn(),
    updateTopicTitle: vi.fn().mockResolvedValue(undefined),
    pinThreadMessage: vi.fn().mockResolvedValue(undefined),
    updatePinnedSplitStatus: vi.fn().mockResolvedValue(undefined),
    updatePinnedDagStatus: vi.fn().mockResolvedValue(undefined),
    broadcastSession: vi.fn(),
    broadcastSessionDeleted: vi.fn(),
    broadcastDag: vi.fn(),
    broadcastDagDeleted: vi.fn(),
    closeChildSessions: vi.fn().mockResolvedValue(undefined),
    closeSingleChild: vi.fn().mockResolvedValue(undefined),
    startDag: vi.fn().mockResolvedValue(undefined),
    shipAdvanceToVerification: vi.fn().mockResolvedValue(undefined),
    handleExecuteCommand: vi.fn().mockResolvedValue(undefined),
    notifyParentOfChildComplete: vi.fn().mockResolvedValue(undefined),
    postSessionDigest: vi.fn(),
    runDeferredBabysit: vi.fn().mockResolvedValue(undefined),
    babysitPR: vi.fn().mockResolvedValue(undefined),
    babysitDagChildCI: vi.fn().mockResolvedValue(true),
    updateDagPRDescriptions: vi.fn().mockResolvedValue(undefined),
    scheduleDagNodes: vi.fn().mockResolvedValue(undefined),
    spawnSplitChild: vi.fn().mockResolvedValue(null),
    spawnDagChild: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
}

describe("CIBabysitter", () => {
  let ctx: DispatcherContext
  let babysitter: CIBabysitter

  beforeEach(() => {
    vi.clearAllMocks()
    ctx = makeContext()
    babysitter = new CIBabysitter(ctx)
  })

  describe("queueDeferredBabysit", () => {
    it("queues entries by parent thread ID", () => {
      const session = makeSession()
      babysitter.queueDeferredBabysit("1", { childSession: session, prUrl: "https://github.com/org/repo/pull/1" })
      babysitter.queueDeferredBabysit("1", { childSession: session, prUrl: "https://github.com/org/repo/pull/2" })

      expect(babysitter.pendingBabysitPRs.get("1")).toHaveLength(2)
    })

    it("keeps separate queues per parent", () => {
      const session = makeSession()
      babysitter.queueDeferredBabysit("1", { childSession: session, prUrl: "https://github.com/org/repo/pull/1" })
      babysitter.queueDeferredBabysit("2", { childSession: session, prUrl: "https://github.com/org/repo/pull/2" })

      expect(babysitter.pendingBabysitPRs.get("1")).toHaveLength(1)
      expect(babysitter.pendingBabysitPRs.get("2")).toHaveLength(1)
    })
  })

  describe("runDeferredBabysit", () => {
    it("does nothing when no entries exist", async () => {
      await babysitter.runDeferredBabysit("999")
      expect(ctx.telegram.sendMessage).not.toHaveBeenCalled()
    })

    it("processes and clears queued entries", async () => {
      const session = makeSession()
      mockCheckPRMergeability.mockResolvedValue("MERGEABLE")
      mockWaitForCI.mockResolvedValue({ passed: true, checks: [], timedOut: false })

      babysitter.queueDeferredBabysit("1", { childSession: session, prUrl: "https://github.com/org/repo/pull/1" })
      await babysitter.runDeferredBabysit("1")

      expect(babysitter.pendingBabysitPRs.has("1")).toBe(false)
      expect(ctx.telegram.sendMessage).toHaveBeenCalled()
    })

    it("continues processing even if one entry fails", async () => {
      const session1 = makeSession({ threadId: "100" })
      const session2 = makeSession({ threadId: "200" })
      mockCheckPRMergeability.mockResolvedValue("MERGEABLE")

      // First call throws, second succeeds
      mockWaitForCI
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce({ passed: true, checks: [], timedOut: false })

      babysitter.queueDeferredBabysit("1", { childSession: session1, prUrl: "https://github.com/org/repo/pull/1" })
      babysitter.queueDeferredBabysit("1", { childSession: session2, prUrl: "https://github.com/org/repo/pull/2" })

      await babysitter.runDeferredBabysit("1")

      // Queue should be cleared regardless
      expect(babysitter.pendingBabysitPRs.has("1")).toBe(false)
    })

    it("runs entries in parallel, not sequentially", async () => {
      const session1 = makeSession({ threadId: "100" })
      const session2 = makeSession({ threadId: "200" })
      mockCheckPRMergeability.mockResolvedValue("MERGEABLE")

      const callOrder: number[] = []
      let resolveFirst: () => void
      let resolveSecond: () => void
      const firstBlock = new Promise<void>((r) => { resolveFirst = r })
      const secondBlock = new Promise<void>((r) => { resolveSecond = r })

      mockWaitForCI
        .mockImplementationOnce(async () => {
          callOrder.push(1)
          await firstBlock
          return { passed: true, checks: [], timedOut: false }
        })
        .mockImplementationOnce(async () => {
          callOrder.push(2)
          await secondBlock
          return { passed: true, checks: [], timedOut: false }
        })

      babysitter.queueDeferredBabysit("1", { childSession: session1, prUrl: "https://github.com/org/repo/pull/1" })
      babysitter.queueDeferredBabysit("1", { childSession: session2, prUrl: "https://github.com/org/repo/pull/2" })

      const promise = babysitter.runDeferredBabysit("1")

      // Wait a tick for both to start
      await new Promise((r) => setTimeout(r, 10))

      // Both should have started (parallel), not just the first (sequential)
      expect(callOrder).toEqual([1, 2])

      resolveFirst!()
      resolveSecond!()
      await promise
    })
  })

  describe("babysitPR", () => {
    it("reports CI passed when checks pass immediately", async () => {
      const session = makeSession()
      mockCheckPRMergeability.mockResolvedValue("MERGEABLE")
      mockWaitForCI.mockResolvedValue({ passed: true, checks: [], timedOut: false })

      await babysitter.babysitPR(session, "https://github.com/org/repo/pull/1")

      const sendMsg = vi.mocked(ctx.telegram.sendMessage)
      const calls = sendMsg.mock.calls.map((c) => c[0])
      expect(calls.some((c) => typeof c === "string" && c.includes("passed"))).toBe(true)
    })

    it("reports no checks when CI times out with no checks", async () => {
      const session = makeSession()
      mockCheckPRMergeability.mockResolvedValue("MERGEABLE")
      mockWaitForCI.mockResolvedValue({ passed: false, checks: [], timedOut: true })

      await babysitter.babysitPR(session, "https://github.com/org/repo/pull/1")

      const sendMsg = vi.mocked(ctx.telegram.sendMessage)
      expect(sendMsg).toHaveBeenCalled()
    })

    it("spawns CI fix agent when checks fail", async () => {
      const session = makeSession()
      mockCheckPRMergeability.mockResolvedValue("MERGEABLE")
      mockWaitForCI
        .mockResolvedValueOnce({
          passed: false,
          checks: [{ name: "test", state: "failure", bucket: "fail" }],
          timedOut: false,
        })
        .mockResolvedValueOnce({ passed: true, checks: [], timedOut: false })

      mockGetFailedCheckLogs.mockResolvedValue([{ checkName: "test", logs: "error" }])
      mockBuildCIFixPrompt.mockReturnValue("fix prompt")

      await babysitter.babysitPR(session, "https://github.com/org/repo/pull/1")

      expect(ctx.spawnCIFixAgent).toHaveBeenCalled()
      expect(session.mode).toBe("task")
    })

    it("gives up after max retries", async () => {
      const session = makeSession()
      mockCheckPRMergeability.mockResolvedValue("MERGEABLE")
      mockWaitForCI.mockResolvedValue({
        passed: false,
        checks: [{ name: "test", state: "failure", bucket: "fail" }],
        timedOut: false,
      })
      mockGetFailedCheckLogs.mockResolvedValue([])
      mockBuildCIFixPrompt.mockReturnValue("fix prompt")

      await babysitter.babysitPR(session, "https://github.com/org/repo/pull/1")

      expect(ctx.spawnCIFixAgent).toHaveBeenCalledTimes(2) // maxRetries = 2
      expect(session.mode).toBe("task")
    })

    it("aborts when CI failures grow", async () => {
      const session = makeSession()
      mockCheckPRMergeability.mockResolvedValue("MERGEABLE")
      mockWaitForCI
        .mockResolvedValueOnce({
          passed: false,
          checks: [{ name: "test1", state: "failure", bucket: "fail" }],
          timedOut: false,
        })
        .mockResolvedValueOnce({
          passed: false,
          checks: [
            { name: "test1", state: "failure", bucket: "fail" },
            { name: "test2", state: "failure", bucket: "fail" },
          ],
          timedOut: false,
        })
      mockGetFailedCheckLogs.mockResolvedValue([])
      mockBuildCIFixPrompt.mockReturnValue("fix prompt")

      await babysitter.babysitPR(session, "https://github.com/org/repo/pull/1")

      // Should only attempt once then abort
      expect(ctx.spawnCIFixAgent).toHaveBeenCalledTimes(1)
    })

    it("handles merge conflicts by spawning conflict resolution", async () => {
      const session = makeSession()
      mockCheckPRMergeability
        .mockResolvedValueOnce("CONFLICTING")
        .mockResolvedValueOnce("MERGEABLE")
      mockBuildMergeConflictPrompt.mockReturnValue("conflict prompt")
      mockWaitForCI.mockResolvedValue({ passed: true, checks: [], timedOut: false })

      await babysitter.babysitPR(session, "https://github.com/org/repo/pull/1")

      expect(ctx.spawnCIFixAgent).toHaveBeenCalledTimes(1)
      expect(mockBuildMergeConflictPrompt).toHaveBeenCalled()
    })

    it("aborts when merge conflicts persist after max retries", async () => {
      const session = makeSession()
      mockCheckPRMergeability.mockResolvedValue("CONFLICTING")
      mockBuildMergeConflictPrompt.mockReturnValue("conflict prompt")

      await babysitter.babysitPR(session, "https://github.com/org/repo/pull/1")

      expect(session.mode).toBe("task")
    })

    it("handles local quality gate failures", async () => {
      const session = makeSession()
      const qualityReport = {
        allPassed: false,
        results: [{ gate: "typecheck", passed: false, output: "error" }],
      }
      mockCheckPRMergeability.mockResolvedValue("MERGEABLE")
      mockWaitForCI.mockResolvedValue({ passed: true, checks: [], timedOut: false })
      mockBuildQualityGateFixPrompt.mockReturnValue("quality fix prompt")
      mockRunQualityGates.mockReturnValue({ allPassed: true, results: [] })

      await babysitter.babysitPR(session, "https://github.com/org/repo/pull/1", qualityReport)

      // Should have spawned a fix agent for the quality gate failure
      expect(ctx.spawnCIFixAgent).toHaveBeenCalled()
    })
  })

  describe("babysitDagChildCI", () => {
    it("returns true when CI passes immediately", async () => {
      const session = makeSession()
      mockWaitForCI.mockResolvedValue({ passed: true, checks: [], timedOut: false })

      const result = await babysitter.babysitDagChildCI(session, "https://github.com/org/repo/pull/1")
      expect(result).toBe(true)
    })

    it("returns true when no checks found (timed out)", async () => {
      const session = makeSession()
      mockWaitForCI.mockResolvedValue({ passed: false, checks: [], timedOut: true })

      const result = await babysitter.babysitDagChildCI(session, "https://github.com/org/repo/pull/1")
      expect(result).toBe(true)
    })

    it("returns true when all checks pass (no fail bucket)", async () => {
      const session = makeSession()
      mockWaitForCI.mockResolvedValue({
        passed: false,
        checks: [{ name: "test", state: "pending", bucket: "pending" }],
        timedOut: false,
      })

      const result = await babysitter.babysitDagChildCI(session, "https://github.com/org/repo/pull/1")
      expect(result).toBe(true)
    })

    it("attempts CI fix and returns true on success", async () => {
      const session = makeSession()
      mockWaitForCI
        .mockResolvedValueOnce({
          passed: false,
          checks: [{ name: "test", state: "failure", bucket: "fail" }],
          timedOut: false,
        })
        .mockResolvedValueOnce({ passed: true, checks: [], timedOut: false })
      mockGetFailedCheckLogs.mockResolvedValue([])
      mockBuildCIFixPrompt.mockReturnValue("fix prompt")

      const result = await babysitter.babysitDagChildCI(session, "https://github.com/org/repo/pull/1")

      expect(result).toBe(true)
      expect(ctx.spawnCIFixAgent).toHaveBeenCalledTimes(1)
      expect(session.mode).toBe("task")
    })

    it("returns false after exhausting retries", async () => {
      const session = makeSession()
      mockWaitForCI.mockResolvedValue({
        passed: false,
        checks: [{ name: "test", state: "failure", bucket: "fail" }],
        timedOut: false,
      })
      mockGetFailedCheckLogs.mockResolvedValue([])
      mockBuildCIFixPrompt.mockReturnValue("fix prompt")

      const result = await babysitter.babysitDagChildCI(session, "https://github.com/org/repo/pull/1")

      expect(result).toBe(false)
      expect(ctx.spawnCIFixAgent).toHaveBeenCalledTimes(2)
      expect(session.mode).toBe("task")
    })
  })
})
