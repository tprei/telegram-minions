import { describe, it, expect, vi, beforeEach } from "vitest"
import { SplitOrchestrator } from "../src/orchestration/split-orchestrator.js"
import type { DispatcherContext } from "../src/orchestration/dispatcher-context.js"
import type { ActiveSession } from "../src/session/session-manager.js"
import {
  createMockContext,
  makeMockConfig,
  makeMockActiveSession,
  makeMockSessionPort,
  makeMockTopicSession,
  makeMockProfileStore,
} from "./test-helpers.js"

vi.mock("../src/orchestration/split.js", () => ({
  extractSplitItems: vi.fn(),
}))

vi.mock("../src/dag/dag-extract.js", () => ({
  extractStackItems: vi.fn(),
}))

vi.mock("../src/telegram/format.js", () => ({
  formatSplitAnalyzing: vi.fn((slug: string) => `analyzing ${slug}`),
  formatSplitStart: vi.fn(() => "split started"),
  formatSplitChildComplete: vi.fn(() => "child complete"),
  formatSplitAllDone: vi.fn(() => "all done"),
  formatStackAnalyzing: vi.fn((slug: string) => `stack analyzing ${slug}`),
}))

import { extractSplitItems } from "../src/orchestration/split.js"
import { extractStackItems } from "../src/dag/dag-extract.js"
import { formatSplitChildComplete } from "../src/telegram/format.js"

const mockExtractSplitItems = vi.mocked(extractSplitItems)
const mockExtractStackItems = vi.mocked(extractStackItems)

function makeSession(overrides: Partial<import("../src/domain/session-types.js").TopicSession> = {}): import("../src/domain/session-types.js").TopicSession {
  return makeMockTopicSession({
    threadId: 100,
    repo: "org/repo",
    repoUrl: "https://github.com/org/repo",
    cwd: "/tmp/workspace",
    slug: "test-slug",
    conversation: [{ role: "user", text: "plan something" }],
    pendingFeedback: [],
    mode: "think",
    ...overrides,
  })
}

describe("SplitOrchestrator", () => {
  let ctx: DispatcherContext
  let orchestrator: SplitOrchestrator

  beforeEach(() => {
    vi.clearAllMocks()
    ctx = createMockContext()
    orchestrator = new SplitOrchestrator(ctx)
  })

  describe("handleSplitCommand", () => {
    it("kills active session before extracting", async () => {
      const handle = makeMockSessionPort({ kill: vi.fn().mockResolvedValue(undefined) })
      const session = makeSession({ activeSessionId: "abc" })
      ctx.sessions.set(100, makeMockActiveSession({ handle }))

      mockExtractSplitItems.mockResolvedValue({ items: [] })

      await orchestrator.handleSplitCommand(session)

      expect(handle.kill).toHaveBeenCalled()
      expect(ctx.sessions.has(100)).toBe(false)
      expect(session.activeSessionId).toBeUndefined()
    })

    it("reports system error from extraction", async () => {
      const session = makeSession()
      mockExtractSplitItems.mockResolvedValue({ items: [], error: "system", errorMessage: "OOM" })

      await orchestrator.handleSplitCommand(session)

      const sendMsg = vi.mocked(ctx.telegram.sendMessage)
      const calls = sendMsg.mock.calls.map(c => c[0])
      expect(calls.some(c => typeof c === "string" && c.includes("System error"))).toBe(true)
    })

    it("reports when no items extracted", async () => {
      const session = makeSession()
      mockExtractSplitItems.mockResolvedValue({ items: [] })

      await orchestrator.handleSplitCommand(session)

      const sendMsg = vi.mocked(ctx.telegram.sendMessage)
      const calls = sendMsg.mock.calls.map(c => c[0])
      expect(calls.some(c => typeof c === "string" && c.includes("Could not extract"))).toBe(true)
    })

    it("falls back to /execute when only 1 item found", async () => {
      const session = makeSession()
      mockExtractSplitItems.mockResolvedValue({
        items: [{ title: "Only task", description: "do it" }],
      })

      await orchestrator.handleSplitCommand(session)

      expect(ctx.handleExecuteCommand).toHaveBeenCalledWith(session, "do it")
    })

    it("spawns split children and sends summary", async () => {
      const session = makeSession()
      const items = [
        { title: "Task A", description: "do A" },
        { title: "Task B", description: "do B" },
      ]
      mockExtractSplitItems.mockResolvedValue({ items })

      const childA = makeSession({ threadId: 201, slug: "child-a", repo: "org/repo" })
      const childB = makeSession({ threadId: 202, slug: "child-b", repo: "org/repo" })
      ctx.topicSessions.set(201, childA)
      ctx.topicSessions.set(202, childB)

      vi.mocked(ctx.spawnSplitChild)
        .mockResolvedValueOnce(201)
        .mockResolvedValueOnce(202)

      await orchestrator.handleSplitCommand(session)

      expect(ctx.spawnSplitChild).toHaveBeenCalledTimes(2)
      expect(session.childThreadIds).toEqual([201, 202])
      expect(ctx.updateTopicTitle).toHaveBeenCalledWith(session, "🔀")
      expect(ctx.persistTopicSessions).toHaveBeenCalled()
    })

    it("queues excess items when concurrency limit reached", async () => {
      // Fill up sessions to leave only 1 slot
      const sessions = new Map<number, ActiveSession>()
      sessions.set(1, makeMockActiveSession())
      sessions.set(2, makeMockActiveSession())
      sessions.set(3, makeMockActiveSession())
      sessions.set(4, makeMockActiveSession())
      ctx = createMockContext({ sessions })
      orchestrator = new SplitOrchestrator(ctx)

      const session = makeSession()
      const items = [
        { title: "Task A", description: "do A" },
        { title: "Task B", description: "do B" },
        { title: "Task C", description: "do C" },
      ]
      mockExtractSplitItems.mockResolvedValue({ items })

      const childA = makeSession({ threadId: 201, slug: "child-a" })
      ctx.topicSessions.set(201, childA)
      vi.mocked(ctx.spawnSplitChild).mockResolvedValueOnce(201)

      await orchestrator.handleSplitCommand(session)

      expect(ctx.spawnSplitChild).toHaveBeenCalledTimes(1)
      expect(session.pendingSplitItems).toHaveLength(2)
    })

    it("reports failure when no children spawn", async () => {
      const session = makeSession()
      mockExtractSplitItems.mockResolvedValue({
        items: [
          { title: "Task A", description: "do A" },
          { title: "Task B", description: "do B" },
        ],
      })

      vi.mocked(ctx.spawnSplitChild).mockResolvedValue(null)

      await orchestrator.handleSplitCommand(session)

      const sendMsg = vi.mocked(ctx.telegram.sendMessage)
      const calls = sendMsg.mock.calls.map(c => c[0])
      expect(calls.some(c => typeof c === "string" && c.includes("Failed to spawn"))).toBe(true)
    })

    it("truncates items exceeding maxSplitItems", async () => {
      ctx = createMockContext({
        config: makeMockConfig({
          workspace: {
            root: "/tmp/test",
            maxConcurrentSessions: 10,
            maxDagConcurrency: 3,
            maxSplitItems: 2,
            sessionTokenBudget: 100000,
            sessionBudgetUsd: 10,
            sessionTimeoutMs: 300000,
            sessionInactivityTimeoutMs: 60000,
            staleTtlMs: 86400000,
            cleanupIntervalMs: 3600000,
            maxConversationLength: 50,
            maxJudgeOptions: 5,
            judgeAdvocateTimeoutMs: 120000,
            judgeTimeoutMs: 300000,
          },
        }),
      })
      orchestrator = new SplitOrchestrator(ctx)

      const session = makeSession()
      const items = [
        { title: "A", description: "a" },
        { title: "B", description: "b" },
        { title: "C", description: "c" },
      ]
      mockExtractSplitItems.mockResolvedValue({ items })

      const childA = makeSession({ threadId: 201, slug: "child-a" })
      const childB = makeSession({ threadId: 202, slug: "child-b" })
      ctx.topicSessions.set(201, childA)
      ctx.topicSessions.set(202, childB)
      vi.mocked(ctx.spawnSplitChild)
        .mockResolvedValueOnce(201)
        .mockResolvedValueOnce(202)

      await orchestrator.handleSplitCommand(session)

      expect(ctx.spawnSplitChild).toHaveBeenCalledTimes(2)
    })
  })

  describe("handleStackCommand", () => {
    it("kills active session before extracting", async () => {
      const handle = makeMockSessionPort({ kill: vi.fn().mockResolvedValue(undefined) })
      const session = makeSession({ activeSessionId: "abc" })
      ctx.sessions.set(100, makeMockActiveSession({ handle }))

      mockExtractStackItems.mockResolvedValue({ items: [] })

      await orchestrator.handleStackCommand(session)

      expect(handle.kill).toHaveBeenCalled()
      expect(session.activeSessionId).toBeUndefined()
    })

    it("reports system error from extraction", async () => {
      const session = makeSession()
      mockExtractStackItems.mockResolvedValue({ items: [], error: "system", errorMessage: "timeout" })

      await orchestrator.handleStackCommand(session)

      const sendMsg = vi.mocked(ctx.telegram.sendMessage)
      const calls = sendMsg.mock.calls.map(c => c[0])
      expect(calls.some(c => typeof c === "string" && c.includes("System error"))).toBe(true)
    })

    it("reports when no items extracted", async () => {
      const session = makeSession()
      mockExtractStackItems.mockResolvedValue({ items: [] })

      await orchestrator.handleStackCommand(session)

      const sendMsg = vi.mocked(ctx.telegram.sendMessage)
      const calls = sendMsg.mock.calls.map(c => c[0])
      expect(calls.some(c => typeof c === "string" && c.includes("Could not extract"))).toBe(true)
    })

    it("falls back to /execute when only 1 item found", async () => {
      const session = makeSession()
      mockExtractStackItems.mockResolvedValue({
        items: [{ id: "step-0", title: "Only task", description: "do it", dependsOn: [] }],
      })

      await orchestrator.handleStackCommand(session)

      expect(ctx.handleExecuteCommand).toHaveBeenCalledWith(session, "do it")
    })

    it("starts DAG for multiple items", async () => {
      const session = makeSession()
      const items = [
        { id: "step-0", title: "Step 1", description: "first", dependsOn: [] },
        { id: "step-1", title: "Step 2", description: "second", dependsOn: ["step-0"] },
      ]
      mockExtractStackItems.mockResolvedValue({ items })

      await orchestrator.handleStackCommand(session)

      expect(ctx.startDag).toHaveBeenCalledWith(session, items, true)
    })

    it("passes profile from profileStore", async () => {
      const profile = { id: "my-profile", name: "My Profile" }
      ctx = createMockContext({
        profileStore: makeMockProfileStore({
          get: vi.fn().mockReturnValue(profile),
        }),
      })
      orchestrator = new SplitOrchestrator(ctx)

      const session = makeSession({ profileId: "my-profile" })
      mockExtractStackItems.mockResolvedValue({ items: [] })

      await orchestrator.handleStackCommand(session)

      expect(mockExtractStackItems).toHaveBeenCalledWith(
        session.conversation,
        undefined,
        profile,
      )
    })
  })

  describe("notifyParentOfChildComplete", () => {
    it("does nothing when child has no parent", async () => {
      const child = makeSession({ parentThreadId: undefined })

      await orchestrator.notifyParentOfChildComplete(child, "completed")

      expect(ctx.telegram.sendMessage).not.toHaveBeenCalled()
    })

    it("skips DAG children", async () => {
      const child = makeSession({
        parentThreadId: 1,
        dagId: "dag-1",
        dagNodeId: "node-1",
      })

      await orchestrator.notifyParentOfChildComplete(child, "completed")

      expect(ctx.telegram.sendMessage).not.toHaveBeenCalled()
    })

    it("notifies parent and clears child conversation", async () => {
      const parent = makeSession({ threadId: 1, childThreadIds: [100] })
      const child = makeSession({ parentThreadId: 1, splitLabel: "Auth fix" })
      ctx.topicSessions.set(1, parent)
      ctx.topicSessions.set(100, child)

      vi.mocked(ctx.extractPRFromConversation).mockReturnValue("https://github.com/org/repo/pull/42")

      await orchestrator.notifyParentOfChildComplete(child, "completed")

      expect(ctx.telegram.sendMessage).toHaveBeenCalled()
      expect(child.conversation).toEqual([])
      expect(child.prUrl).toBe("https://github.com/org/repo/pull/42")
      expect(ctx.updatePinnedSplitStatus).toHaveBeenCalledWith(parent)
    })

    it("passes threadId and chatId to formatSplitChildComplete", async () => {
      const parent = makeSession({ threadId: 1, childThreadIds: [100] })
      const child = makeSession({ threadId: 100, parentThreadId: 1, splitLabel: "Auth fix" })
      ctx.topicSessions.set(1, parent)
      ctx.topicSessions.set(100, child)

      vi.mocked(ctx.extractPRFromConversation).mockReturnValue("https://github.com/org/repo/pull/42")

      await orchestrator.notifyParentOfChildComplete(child, "completed")

      expect(vi.mocked(formatSplitChildComplete)).toHaveBeenCalledWith(
        "test-slug",
        "completed",
        "Auth fix",
        "https://github.com/org/repo/pull/42",
        100,
        "123",
      )
    })

    it("spawns next queued item when a child completes", async () => {
      const parent = makeSession({
        threadId: 1,
        childThreadIds: [100],
        pendingSplitItems: [{ title: "Next", description: "next task" }],
        allSplitItems: [{ title: "Next", description: "next task" }],
      })
      const child = makeSession({ parentThreadId: 1, activeSessionId: undefined })
      ctx.topicSessions.set(1, parent)
      ctx.topicSessions.set(100, child)

      vi.mocked(ctx.spawnSplitChild).mockResolvedValue(201)

      // Child 201 is still active so not "all done"
      const child201 = makeSession({ threadId: 201, activeSessionId: "xyz" })
      ctx.topicSessions.set(201, child201)

      await orchestrator.notifyParentOfChildComplete(child, "completed")

      expect(ctx.spawnSplitChild).toHaveBeenCalled()
      expect(parent.childThreadIds).toContain(201)
    })

    it("sends all-done message and runs deferred babysit when all children finish", async () => {
      const parent = makeSession({
        threadId: 1,
        childThreadIds: [100, 200],
      })
      const child1 = makeSession({ threadId: 100, parentThreadId: 1 })
      const child2 = makeSession({ threadId: 200, parentThreadId: 1, activeSessionId: undefined })
      ctx.topicSessions.set(1, parent)
      ctx.topicSessions.set(100, child1)
      ctx.topicSessions.set(200, child2)

      vi.mocked(ctx.extractPRFromConversation)
        .mockReturnValueOnce(null) // for child1 in notifyParent
        .mockReturnValueOnce(null) // child1 recheck in all-done loop
        .mockReturnValueOnce("https://github.com/org/repo/pull/2") // child2 recheck

      await orchestrator.notifyParentOfChildComplete(child1, "completed")

      expect(ctx.runDeferredBabysit).toHaveBeenCalledWith(1)
      expect(ctx.updateTopicTitle).toHaveBeenCalledWith(parent, "⚠️")
    })

    it("uses ✅ emoji when all children have PRs", async () => {
      const parent = makeSession({
        threadId: 1,
        childThreadIds: [100, 200],
      })
      const child1 = makeSession({ threadId: 100, parentThreadId: 1 })
      const child2 = makeSession({ threadId: 200, parentThreadId: 1, activeSessionId: undefined })
      ctx.topicSessions.set(1, parent)
      ctx.topicSessions.set(100, child1)
      ctx.topicSessions.set(200, child2)

      vi.mocked(ctx.extractPRFromConversation)
        .mockReturnValueOnce("https://github.com/org/repo/pull/1")  // child1 in notifyParent
        .mockReturnValueOnce("https://github.com/org/repo/pull/1")  // child1 recheck
        .mockReturnValueOnce("https://github.com/org/repo/pull/2")  // child2 recheck

      await orchestrator.notifyParentOfChildComplete(child1, "completed")

      expect(ctx.updateTopicTitle).toHaveBeenCalledWith(parent, "✅")
    })

    it("does not send all-done when pending items remain", async () => {
      const parent = makeSession({
        threadId: 1,
        childThreadIds: [100],
        pendingSplitItems: [{ title: "Queued", description: "task" }],
        allSplitItems: [{ title: "Queued", description: "task" }],
      })
      const child = makeSession({ threadId: 100, parentThreadId: 1, activeSessionId: undefined })
      ctx.topicSessions.set(1, parent)
      ctx.topicSessions.set(100, child)

      vi.mocked(ctx.spawnSplitChild).mockResolvedValue(201)
      const child201 = makeSession({ threadId: 201, activeSessionId: "xyz" })
      ctx.topicSessions.set(201, child201)

      await orchestrator.notifyParentOfChildComplete(child, "completed")

      expect(ctx.runDeferredBabysit).not.toHaveBeenCalled()
    })
  })
})
