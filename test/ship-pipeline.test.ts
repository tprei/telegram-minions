import { describe, it, expect, vi, beforeEach } from "vitest"
import { ShipPipeline } from "../src/ship-pipeline.js"
import type { DispatcherContext } from "../src/dispatcher-context.js"
import type { TopicSession, AutoAdvance } from "../src/types.js"
import type { DagGraph, DagNode } from "../src/dag.js"

vi.mock("../src/verification.js", () => ({
  buildCompletenessReviewPrompt: vi.fn().mockReturnValue("verify task prompt"),
  parseCompletenessResult: vi.fn().mockReturnValue({ passed: true, details: "ok" }),
}))

vi.mock("../src/dag-extract.js", () => ({
  extractDagItems: vi.fn().mockResolvedValue({
    items: [
      { id: "a", title: "Task A", description: "Do A", dependsOn: [] },
    ],
  }),
}))

vi.mock("../src/sentry.js", () => ({
  captureException: vi.fn(),
}))

import { extractDagItems } from "../src/dag-extract.js"
import { parseCompletenessResult } from "../src/verification.js"

const mockExtractDagItems = vi.mocked(extractDagItems)
const mockParseCompletenessResult = vi.mocked(parseCompletenessResult)

function makeAutoAdvance(overrides: Partial<AutoAdvance> = {}): AutoAdvance {
  return {
    phase: "think",
    featureDescription: "Build a cool feature",
    autoLand: false,
    ...overrides,
  }
}

function makeSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 100,
    repo: "org/repo",
    repoUrl: "https://github.com/org/repo",
    cwd: "/tmp/workspace",
    slug: "test-slug",
    conversation: [{ role: "user", text: "test task" }],
    pendingFeedback: [],
    mode: "ship-think",
    lastActivityAt: Date.now(),
    childThreadIds: [],
    autoAdvance: makeAutoAdvance(),
    ...overrides,
  }
}

function makeContext(overrides: Partial<DispatcherContext> = {}): DispatcherContext {
  return {
    config: {
      goose: {},
      claude: {},
      mcp: {},
      ci: { babysitEnabled: false, maxRetries: 2, pollIntervalMs: 100, pollTimeoutMs: 1000, dagCiPolicy: "skip" },
      workspace: { maxDagConcurrency: 3, maxConcurrentSessions: 5, sessionTimeoutMs: 60000, sessionInactivityTimeoutMs: 30000 },
      sessionEnvPassthrough: [],
    } as any,
    telegram: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    } as any,
    observer: {
      onEvent: vi.fn().mockResolvedValue(undefined),
      onSessionStart: vi.fn().mockResolvedValue(undefined),
      onSessionComplete: vi.fn().mockResolvedValue(undefined),
    } as any,
    stats: {} as any,
    profileStore: {
      get: vi.fn().mockReturnValue(undefined),
    } as any,
    broadcaster: undefined,
    sessions: new Map(),
    topicSessions: new Map(),
    dags: new Map(),
    spawnTopicAgent: vi.fn().mockResolvedValue(undefined),
    spawnCIFixAgent: vi.fn().mockResolvedValue(undefined),
    prepareWorkspace: vi.fn().mockResolvedValue("/tmp/child-workspace"),
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    cleanBuildArtifacts: vi.fn(),
    prepareFanInBranch: vi.fn().mockResolvedValue(null),
    mergeUpstreamBranches: vi.fn().mockReturnValue({ ok: true, conflictFiles: [] }),
    downloadPhotos: vi.fn().mockResolvedValue([]),
    pushToConversation: vi.fn(),
    extractPRFromConversation: vi.fn().mockReturnValue(null),
    persistTopicSessions: vi.fn().mockResolvedValue(undefined),
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
    handleLandCommand: vi.fn().mockResolvedValue(undefined),
    handleShipAdvance: vi.fn().mockResolvedValue(undefined),
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

describe("ShipPipeline", () => {
  let ctx: DispatcherContext
  let pipeline: ShipPipeline

  beforeEach(() => {
    vi.clearAllMocks()
    ctx = makeContext()
    pipeline = new ShipPipeline(ctx)
  })

  describe("handleShipAdvance", () => {
    it("does nothing when autoAdvance is undefined", async () => {
      const session = makeSession({ autoAdvance: undefined })
      await pipeline.handleShipAdvance(session)
      expect(ctx.telegram.sendMessage).not.toHaveBeenCalled()
    })

    it("advances from think to plan phase", async () => {
      const session = makeSession({
        autoAdvance: makeAutoAdvance({ phase: "think" }),
        conversation: [{ role: "assistant", text: "research findings here" }],
      })

      await pipeline.handleShipAdvance(session)

      expect(session.autoAdvance!.phase).toBe("plan")
      expect(session.mode).toBe("ship-plan")
      expect(ctx.telegram.sendMessage).toHaveBeenCalled()
      expect(ctx.spawnTopicAgent).toHaveBeenCalled()
    })

    it("advances from plan to dag phase", async () => {
      const session = makeSession({
        autoAdvance: makeAutoAdvance({ phase: "plan" }),
      })

      await pipeline.handleShipAdvance(session)

      expect(session.autoAdvance!.phase).toBe("dag")
      expect(ctx.startDag).toHaveBeenCalledWith(session, expect.any(Array), false)
    })

    it("does nothing for dag phase (handled by DagOrchestrator)", async () => {
      const session = makeSession({
        autoAdvance: makeAutoAdvance({ phase: "dag" }),
      })

      await pipeline.handleShipAdvance(session)

      expect(ctx.spawnTopicAgent).not.toHaveBeenCalled()
      expect(ctx.startDag).not.toHaveBeenCalled()
    })

    it("does nothing for done phase", async () => {
      const session = makeSession({
        autoAdvance: makeAutoAdvance({ phase: "done" }),
      })

      await pipeline.handleShipAdvance(session)

      expect(ctx.telegram.sendMessage).not.toHaveBeenCalled()
    })
  })

  describe("shipAdvanceToDag", () => {
    it("halts on system extraction error", async () => {
      mockExtractDagItems.mockResolvedValueOnce({
        items: [],
        error: "system",
        errorMessage: "API down",
      })

      const session = makeSession({
        autoAdvance: makeAutoAdvance({ phase: "plan" }),
      })

      await pipeline.shipAdvanceToDag(session)

      expect(session.autoAdvance!.phase).toBe("done")
      expect(ctx.updateTopicTitle).toHaveBeenCalledWith(session, "❌")
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("DAG extraction failed"),
        session.threadId,
      )
    })

    it("halts when no items extracted", async () => {
      mockExtractDagItems.mockResolvedValueOnce({ items: [] })

      const session = makeSession({
        autoAdvance: makeAutoAdvance({ phase: "plan" }),
      })

      await pipeline.shipAdvanceToDag(session)

      expect(session.autoAdvance!.phase).toBe("done")
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("could not extract work items"),
        session.threadId,
      )
    })

    it("starts DAG with extracted items", async () => {
      const items = [
        { id: "a", title: "Task A", description: "Do A", dependsOn: [] },
      ]
      mockExtractDagItems.mockResolvedValueOnce({ items })

      const session = makeSession({
        autoAdvance: makeAutoAdvance({ phase: "plan" }),
      })

      await pipeline.shipAdvanceToDag(session)

      expect(session.autoAdvance!.phase).toBe("dag")
      expect(ctx.startDag).toHaveBeenCalledWith(session, items, false)
      expect(ctx.persistTopicSessions).toHaveBeenCalled()
    })
  })

  describe("shipAdvanceToVerification", () => {
    it("skips to finalize when no completed nodes", async () => {
      const session = makeSession({
        autoAdvance: makeAutoAdvance({ phase: "dag" }),
        dagId: "dag-1",
      })
      const graph: DagGraph = {
        id: "dag-1",
        parentThreadId: 100,
        repoUrl: "https://github.com/org/repo",
        nodes: [
          { id: "a", title: "Task A", description: "Do A", dependsOn: [], status: "failed" } as DagNode,
        ],
        isStack: false,
      }

      await pipeline.shipAdvanceToVerification(session, graph)

      expect(session.autoAdvance!.phase).toBe("done")
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Ship complete"),
        session.threadId,
      )
    })

    it("skips child without matching session and decrements pending count", async () => {
      const session = makeSession({
        autoAdvance: makeAutoAdvance({ phase: "dag" }),
        dagId: "dag-1",
        childThreadIds: [200],
      })
      const graph: DagGraph = {
        id: "dag-1",
        parentThreadId: 100,
        repoUrl: "https://github.com/org/repo",
        nodes: [
          { id: "a", title: "Task A", description: "Do A", dependsOn: [], status: "done", prUrl: "https://github.com/org/repo/pull/1", branch: "feat-a", threadId: 200 } as DagNode,
        ],
        isStack: false,
      }

      // No child session registered — the node is skipped and verification
      // completes immediately, advancing through shipFinalize
      await pipeline.shipAdvanceToVerification(session, graph)

      expect(session.autoAdvance!.phase).toBe("done")
      expect(ctx.sessions.size).toBe(0)
    })
  })

  describe("shipFinalize", () => {
    it("sends completion message with verification results", async () => {
      const session = makeSession({
        autoAdvance: makeAutoAdvance({ phase: "verify" }),
        dagId: "dag-1",
        verificationState: {
          dagId: "dag-1",
          maxRounds: 1,
          rounds: [{
            round: 1,
            checks: [
              { kind: "completeness-review", status: "passed", nodeId: "a", finishedAt: Date.now() },
              { kind: "completeness-review", status: "passed", nodeId: "b", finishedAt: Date.now() },
            ],
            startedAt: Date.now(),
          }],
          status: "passed",
        },
      })

      await pipeline.shipFinalize(session)

      expect(session.autoAdvance!.phase).toBe("done")
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Ship complete"),
        session.threadId,
      )
      expect(ctx.updateTopicTitle).toHaveBeenCalledWith(session, "✅")
    })

    it("auto-lands when autoLand is true and all passed", async () => {
      const session = makeSession({
        autoAdvance: makeAutoAdvance({ phase: "verify", autoLand: true }),
        dagId: "dag-1",
        verificationState: {
          dagId: "dag-1",
          maxRounds: 1,
          rounds: [{
            round: 1,
            checks: [
              { kind: "completeness-review", status: "passed", nodeId: "a", finishedAt: Date.now() },
            ],
            startedAt: Date.now(),
          }],
          status: "passed",
        },
      })

      await pipeline.shipFinalize(session)

      expect(ctx.handleLandCommand).toHaveBeenCalledWith(session)
      expect(ctx.updateTopicTitle).toHaveBeenCalledWith(session, "✅")
    })

    it("shows land hint when all passed but autoLand is false", async () => {
      const session = makeSession({
        autoAdvance: makeAutoAdvance({ phase: "verify", autoLand: false }),
        dagId: "dag-1",
        verificationState: {
          dagId: "dag-1",
          maxRounds: 1,
          rounds: [{
            round: 1,
            checks: [
              { kind: "completeness-review", status: "passed", nodeId: "a", finishedAt: Date.now() },
            ],
            startedAt: Date.now(),
          }],
          status: "passed",
        },
      })

      await pipeline.shipFinalize(session)

      expect(ctx.handleLandCommand).not.toHaveBeenCalled()
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("/land"),
        session.threadId,
      )
    })

    it("sets warning emoji when verification has failures", async () => {
      const session = makeSession({
        autoAdvance: makeAutoAdvance({ phase: "verify" }),
        dagId: "dag-1",
        verificationState: {
          dagId: "dag-1",
          maxRounds: 1,
          rounds: [{
            round: 1,
            checks: [
              { kind: "completeness-review", status: "passed", nodeId: "a", finishedAt: Date.now() },
              { kind: "completeness-review", status: "failed", nodeId: "b", finishedAt: Date.now() },
            ],
            startedAt: Date.now(),
          }],
          status: "failed",
        },
      })

      await pipeline.shipFinalize(session)

      expect(ctx.updateTopicTitle).toHaveBeenCalledWith(session, "⚠️")
      expect(ctx.handleLandCommand).not.toHaveBeenCalled()
    })

    it("handles no verification state gracefully", async () => {
      const session = makeSession({
        autoAdvance: makeAutoAdvance({ phase: "verify" }),
      })

      await pipeline.shipFinalize(session)

      expect(session.autoAdvance!.phase).toBe("done")
      expect(ctx.updateTopicTitle).toHaveBeenCalledWith(session, "✅")
    })
  })
})
