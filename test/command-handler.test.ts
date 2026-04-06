import { describe, it, expect, vi, beforeEach } from "vitest"
import { CommandHandler } from "../src/commands/command-handler.js"
import type { DispatcherContext } from "../src/orchestration/dispatcher-context.js"
import type { TopicSession } from "../src/domain/session-types.js"
vi.mock("../src/dag/dag-extract.js", () => ({
  extractDagItems: vi.fn(),
}))

vi.mock("../src/telegram/format.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/telegram/format.js")>()
  return {
    ...actual,
    formatStatus: vi.fn(() => "status"),
    formatStats: vi.fn(() => "stats"),
    formatUsage: vi.fn(() => "usage"),
    formatHelp: vi.fn(() => "help"),
    formatProfileList: vi.fn(() => "profiles"),
    formatConfigHelp: vi.fn(() => "config help"),
    formatDagAnalyzing: vi.fn((slug: string) => `dag analyzing ${slug}`),
    formatPlanExecuting: vi.fn(() => "executing"),
    formatDoctorAnalyzing: vi.fn((slug: string) => `doctor analyzing ${slug}`),
  }
})

vi.mock("../src/claude-usage.js", () => ({
  fetchClaudeUsage: vi.fn().mockResolvedValue(null),
}))

vi.mock("../src/session/session-manager.js", () => ({
  buildExecutionPrompt: vi.fn(() => "execution prompt"),
  dirSizeBytes: vi.fn(() => 0),
}))

import { extractDagItems } from "../src/dag/dag-extract.js"

const mockExtractDagItems = vi.mocked(extractDagItems)

function makeSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 100,
    repo: "org/repo",
    repoUrl: "https://github.com/org/repo",
    cwd: "/tmp/workspace",
    slug: "test-slug",
    conversation: [{ role: "user", text: "plan something" }],
    pendingFeedback: [],
    mode: "think",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

function makeContext(overrides: Partial<DispatcherContext> = {}): DispatcherContext {
  return {
    config: {
      telegram: { chatId: "-1001234567890" },
      workspace: { maxConcurrentSessions: 5, root: "/tmp", staleTtlMs: 86400000 },
      repos: {},
      ci: { babysitEnabled: true, maxRetries: 2, pollIntervalMs: 100, pollTimeoutMs: 1000, dagCiPolicy: "skip" },
    } as any,
    telegram: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendMessageWithKeyboard: vi.fn().mockResolvedValue(1),
      deleteForumTopic: vi.fn().mockResolvedValue(undefined),
    } as any,
    observer: {} as any,
    stats: {
      aggregate: vi.fn().mockResolvedValue({}),
      breakdownByMode: vi.fn().mockResolvedValue([]),
      recentSessions: vi.fn().mockResolvedValue([]),
    } as any,
    profileStore: {
      list: vi.fn().mockReturnValue([]),
      getDefaultId: vi.fn().mockReturnValue(undefined),
      get: vi.fn().mockReturnValue(undefined),
      add: vi.fn().mockReturnValue(true),
      update: vi.fn().mockReturnValue(true),
      remove: vi.fn().mockReturnValue(true),
      setDefaultId: vi.fn().mockReturnValue(true),
      clearDefault: vi.fn(),
    } as any,
    broadcaster: undefined,
    sessions: new Map(),
    topicSessions: new Map(),
    dags: new Map(),
    abortControllers: new Map(),
    pendingTasks: new Map(),
    refreshGitToken: vi.fn().mockResolvedValue(undefined),
    spawnTopicAgent: vi.fn().mockResolvedValue(true),
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
    startWithProfileSelection: vi.fn().mockResolvedValue(undefined),
    startDag: vi.fn().mockResolvedValue(undefined),
    shipAdvanceToVerification: vi.fn().mockResolvedValue(undefined),
    handleLandCommand: vi.fn().mockResolvedValue(undefined),
    handleShipAdvance: vi.fn().mockResolvedValue(undefined),
    shipAdvanceToDag: vi.fn().mockResolvedValue(undefined),
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

describe("CommandHandler", () => {
  let ctx: DispatcherContext
  let handler: CommandHandler

  beforeEach(() => {
    vi.clearAllMocks()
    ctx = makeContext()
    handler = new CommandHandler(ctx)
  })

  describe("handleStatusCommand", () => {
    it("sends formatted status message", async () => {
      await handler.handleStatusCommand()
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith("status")
    })
  })

  describe("handleStatsCommand", () => {
    it("sends formatted stats message", async () => {
      await handler.handleStatsCommand()
      expect(ctx.stats.aggregate).toHaveBeenCalledWith(7)
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith("stats")
    })
  })

  describe("handleUsageCommand", () => {
    it("sends formatted usage message", async () => {
      await handler.handleUsageCommand()
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith("usage")
    })
  })

  describe("handleHelpCommand", () => {
    it("sends formatted help message", async () => {
      await handler.handleHelpCommand()
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith("help")
    })
  })

  describe("handleConfigCommand", () => {
    it("lists profiles when called with no args", async () => {
      await handler.handleConfigCommand("")
      expect(ctx.profileStore.list).toHaveBeenCalled()
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith("profiles")
    })

    it("adds a new profile", async () => {
      await handler.handleConfigCommand("add test-id Test Name")
      expect(ctx.profileStore.add).toHaveBeenCalledWith({ id: "test-id", name: "Test Name" })
    })

    it("sets a profile field", async () => {
      await handler.handleConfigCommand("set test-id name New Name")
      expect(ctx.profileStore.update).toHaveBeenCalledWith("test-id", { name: "New Name" })
    })

    it("rejects invalid set field", async () => {
      await handler.handleConfigCommand("set test-id invalidField value")
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(expect.stringContaining("Invalid field"))
    })

    it("removes a profile", async () => {
      await handler.handleConfigCommand("remove test-id")
      expect(ctx.profileStore.remove).toHaveBeenCalledWith("test-id")
    })

    it("sets default profile", async () => {
      await handler.handleConfigCommand("default test-id")
      expect(ctx.profileStore.setDefaultId).toHaveBeenCalledWith("test-id")
    })

    it("clears default profile", async () => {
      await handler.handleConfigCommand("default clear")
      expect(ctx.profileStore.clearDefault).toHaveBeenCalled()
    })

    it("clears default when no id given", async () => {
      await handler.handleConfigCommand("default")
      expect(ctx.profileStore.clearDefault).toHaveBeenCalled()
    })

    it("shows config help for unknown subcommand", async () => {
      await handler.handleConfigCommand("unknown")
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith("config help")
    })
  })

  describe("handleTaskCommand", () => {
    it("rejects when max concurrent sessions reached", async () => {
      ctx.sessions.set(1, {} as any)
      ctx.sessions.set(2, {} as any)
      ctx.sessions.set(3, {} as any)
      ctx.sessions.set(4, {} as any)
      ctx.sessions.set(5, {} as any)
      await handler.handleTaskCommand("do something", 42)
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Max concurrent sessions"),
        42,
      )
    })

    it("shows usage when no task provided", async () => {
      await handler.handleTaskCommand("", 42)
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Usage"),
        42,
      )
    })

    it("shows repo keyboard when no repo specified and multiple repos configured", async () => {
      ;(ctx.config as any).repos = {
        repo1: "https://github.com/org/repo1",
        repo2: "https://github.com/org/repo2",
      }
      await handler.handleTaskCommand("do something", 42)
      expect(ctx.telegram.sendMessageWithKeyboard).toHaveBeenCalled()
    })

    it("delegates to startWithProfileSelection when repo resolved", async () => {
      await handler.handleTaskCommand("https://github.com/org/repo do something", 42)
      expect(ctx.startWithProfileSelection).toHaveBeenCalledWith(
        "https://github.com/org/repo",
        "do something",
        "task",
        42,
        undefined,
      )
    })
  })

  describe("handleReviewCommand", () => {
    it("shows usage when no repos and no args", async () => {
      await handler.handleReviewCommand("", 42)
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Usage"),
        42,
      )
    })

    it("delegates to startWithProfileSelection with repo and task", async () => {
      await handler.handleReviewCommand("https://github.com/org/repo 123", 42)
      expect(ctx.startWithProfileSelection).toHaveBeenCalledWith(
        "https://github.com/org/repo",
        "Review PR #123",
        "review",
        42,
      )
    })
  })

  describe("handleExecuteCommand", () => {
    it("kills active session and spawns execution task", async () => {
      const session = makeSession({ activeSessionId: "abc", mode: "plan" })
      const mockHandle = { kill: vi.fn().mockResolvedValue(undefined) }
      ctx.sessions.set(100, { handle: mockHandle } as any)

      await handler.handleExecuteCommand(session)

      expect(mockHandle.kill).toHaveBeenCalled()
      expect(session.mode).toBe("task")
      expect(session.autoAdvance).toBeUndefined()
      expect(ctx.spawnTopicAgent).toHaveBeenCalled()
    })

    it("clears autoAdvance when breaking out of ship pipeline", async () => {
      const session = makeSession({
        mode: "ship-plan",
        autoAdvance: { phase: "plan", featureDescription: "test", autoLand: false },
      })

      await handler.handleExecuteCommand(session)

      expect(session.mode).toBe("task")
      expect(session.autoAdvance).toBeUndefined()
      expect(session.pendingFeedback).toEqual([])
    })
  })

  describe("handleDagCommand", () => {
    it("sends error when extraction fails", async () => {
      const session = makeSession()
      mockExtractDagItems.mockResolvedValue({ items: [], error: "system", errorMessage: "boom" })

      await handler.handleDagCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("System error"),
        100,
      )
    })

    it("sends fallback message when no items extracted", async () => {
      const session = makeSession()
      mockExtractDagItems.mockResolvedValue({ items: [] })

      await handler.handleDagCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Could not extract"),
        100,
      )
    })

    it("falls back to execute for single item", async () => {
      const session = makeSession()
      mockExtractDagItems.mockResolvedValue({
        items: [{ id: "1", title: "only item", description: "do it", dependsOn: [] }],
      })

      await handler.handleDagCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("1 item found"),
        100,
      )
      expect(ctx.spawnTopicAgent).toHaveBeenCalled()
    })

    it("starts DAG for multiple items", async () => {
      const session = makeSession()
      mockExtractDagItems.mockResolvedValue({
        items: [
          { id: "1", title: "a", description: "aa", dependsOn: [] },
          { id: "2", title: "b", description: "bb", dependsOn: ["1"] },
        ],
      })

      await handler.handleDagCommand(session)

      expect(ctx.startDag).toHaveBeenCalledWith(session, expect.any(Array), false)
    })
  })

  describe("handleDoctorCommand", () => {
    it("kills active session and starts plan-mode diagnostic", async () => {
      const session = makeSession({ activeSessionId: "abc" })
      const mockHandle = { kill: vi.fn().mockResolvedValue(undefined) }
      ctx.sessions.set(100, { handle: mockHandle } as any)

      await handler.handleDoctorCommand(session)

      expect(mockHandle.kill).toHaveBeenCalled()
      expect(ctx.sessions.has(100)).toBe(false)
      expect(session.activeSessionId).toBeUndefined()
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("doctor analyzing"),
        100,
      )
      expect(ctx.startWithProfileSelection).toHaveBeenCalledWith(
        session.repoUrl,
        expect.stringContaining("Diagnostic report"),
        "plan",
        100,
      )
    })

    it("works when no active session exists", async () => {
      const session = makeSession({ activeSessionId: undefined })

      await handler.handleDoctorCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("doctor analyzing"),
        100,
      )
      expect(ctx.startWithProfileSelection).toHaveBeenCalledWith(
        session.repoUrl,
        expect.stringContaining("Diagnostic report"),
        "plan",
        100,
      )
    })

    it("appends user directive to prompt", async () => {
      const session = makeSession()

      await handler.handleDoctorCommand(session, "The DAG is stuck on node B")

      expect(ctx.startWithProfileSelection).toHaveBeenCalledWith(
        session.repoUrl,
        expect.stringContaining("The DAG is stuck on node B"),
        "plan",
        100,
      )
    })

    it("includes DAG evidence when dagId is present", async () => {
      const session = makeSession({ dagId: "dag-1" })
      const graph = {
        id: "dag-1",
        nodes: [
          { id: "a", title: "Task A", description: "...", dependsOn: [], status: "failed", error: "Timeout" },
        ],
        parentThreadId: 100,
        repo: "org/repo",
        createdAt: Date.now(),
      }
      ctx.dags.set("dag-1", graph as any)

      await handler.handleDoctorCommand(session)

      const prompt = (ctx.startWithProfileSelection as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
      expect(prompt).toContain("Diagnostic report")
      expect(prompt).toContain("Failed/problematic nodes")
    })
  })

  describe("handleDoneCommand", () => {
    it("rejects child sessions", async () => {
      const session = makeSession({ parentThreadId: 50 })
      await handler.handleDoneCommand(session)
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("not available on child sessions"),
        100,
      )
    })

    it("rejects when no PR found", async () => {
      const session = makeSession()
      await handler.handleDoneCommand(session)
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No PR found"),
        100,
      )
    })
  })
})
