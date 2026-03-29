import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { ConfigManager } from "../src/config-manager.js"
import type { DispatcherContext } from "../src/dispatcher-context.js"
import type { TopicSession } from "../src/types.js"

function createMockContext(overrides: Partial<DispatcherContext> = {}): DispatcherContext {
  const sessions = new Map()
  const topicSessions = new Map()
  const dags = new Map()

  return {
    config: {
      telegram: { botToken: "test", chatId: "123", allowedUserIds: [1] },
      telegramQueue: { minSendIntervalMs: 0 },
      goose: { provider: "test", model: "test" },
      claude: { planModel: "test", thinkModel: "test", reviewModel: "test" },
      workspace: {
        root: "/tmp/test-config-manager",
        maxConcurrentSessions: 5,
        maxDagConcurrency: 3,
        maxSplitItems: 10,
        sessionTokenBudget: 100000,
        sessionBudgetUsd: 10,
        sessionTimeoutMs: 300000,
        sessionInactivityTimeoutMs: 60000,
        staleTtlMs: 86400000,
        cleanupIntervalMs: 3600000,
        maxConversationLength: 50,
      },
      ci: {
        babysitEnabled: false,
        maxRetries: 2,
        pollIntervalMs: 5000,
        pollTimeoutMs: 300000,
        dagCiPolicy: "skip",
      },
      mcp: {
        browserEnabled: false,
        githubEnabled: false,
        context7Enabled: false,
        sentryEnabled: false,
        sentryOrgSlug: "",
        sentryProjectSlug: "",
        supabaseEnabled: false,
        supabaseProjectRef: "",
        zaiEnabled: false,
      },
      observer: { activityThrottleMs: 0, textFlushDebounceMs: 0, activityEditDebounceMs: 0 },
      repos: {},
    } as any,
    telegram: {
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      deleteForumTopic: vi.fn(async () => {}),
    } as any,
    observer: {} as any,
    stats: {} as any,
    profileStore: {
      list: vi.fn(() => []),
      getDefaultId: vi.fn(() => undefined),
      add: vi.fn(() => true),
      update: vi.fn(() => true),
      remove: vi.fn(() => true),
      get: vi.fn(() => ({ id: "test", name: "Test" })),
      setDefaultId: vi.fn(() => true),
      clearDefault: vi.fn(),
    } as any,
    broadcaster: undefined,
    sessions,
    topicSessions,
    dags,
    spawnTopicAgent: async () => {},
    spawnCIFixAgent: async () => {},
    prepareWorkspace: async () => "/tmp/test/workspace",
    removeWorkspace: vi.fn(async () => {}),
    cleanBuildArtifacts: () => {},
    prepareFanInBranch: async () => null,
    mergeUpstreamBranches: () => true,
    downloadPhotos: async () => [],
    pushToConversation: () => {},
    extractPRFromConversation: () => null,
    persistTopicSessions: vi.fn(async () => {}),
    updatePinnedSummary: vi.fn(),
    updateTopicTitle: async () => {},
    pinThreadMessage: async () => {},
    updatePinnedSplitStatus: async () => {},
    updatePinnedDagStatus: async () => {},
    broadcastSession: () => {},
    broadcastSessionDeleted: () => {},
    broadcastDag: () => {},
    broadcastDagDeleted: () => {},
    closeChildSessions: async () => {},
    closeSingleChild: async () => {},
    startDag: async () => {},
    shipAdvanceToVerification: async () => {},
    handleExecuteCommand: async () => {},
    notifyParentOfChildComplete: async () => {},
    postSessionDigest: () => {},
    runDeferredBabysit: async () => {},
    babysitPR: async () => {},
    babysitDagChildCI: async () => true,
    updateDagPRDescriptions: async () => {},
    scheduleDagNodes: async () => {},
    spawnSplitChild: async () => null,
    spawnDagChild: async () => null,
    ...overrides,
  }
}

describe("ConfigManager", () => {
  describe("handleConfigCommand", () => {
    it("lists profiles when called with no args", async () => {
      const ctx = createMockContext()
      const mgr = new ConfigManager(ctx)
      await mgr.handleConfigCommand("")
      expect(ctx.profileStore.list).toHaveBeenCalled()
      expect(ctx.profileStore.getDefaultId).toHaveBeenCalled()
      expect(ctx.telegram.sendMessage).toHaveBeenCalled()
    })

    it("adds a profile", async () => {
      const ctx = createMockContext()
      const mgr = new ConfigManager(ctx)
      await mgr.handleConfigCommand("add myprofile My Profile Name")
      expect(ctx.profileStore.add).toHaveBeenCalledWith({ id: "myprofile", name: "My Profile Name" })
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Added profile"),
      )
    })

    it("reports error when profile already exists", async () => {
      const ctx = createMockContext({
        profileStore: {
          ...createMockContext().profileStore,
          add: vi.fn(() => false),
        } as any,
      })
      const mgr = new ConfigManager(ctx)
      await mgr.handleConfigCommand("add existing Existing")
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("already exists"),
      )
    })

    it("sets a profile field", async () => {
      const ctx = createMockContext()
      const mgr = new ConfigManager(ctx)
      await mgr.handleConfigCommand("set myprofile name New Name")
      expect(ctx.profileStore.update).toHaveBeenCalledWith("myprofile", { name: "New Name" })
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Updated"),
      )
    })

    it("rejects invalid field names", async () => {
      const ctx = createMockContext()
      const mgr = new ConfigManager(ctx)
      await mgr.handleConfigCommand("set myprofile invalidField value")
      expect(ctx.profileStore.update).not.toHaveBeenCalled()
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Invalid field"),
      )
    })

    it("removes a profile", async () => {
      const ctx = createMockContext()
      const mgr = new ConfigManager(ctx)
      await mgr.handleConfigCommand("remove myprofile")
      expect(ctx.profileStore.remove).toHaveBeenCalledWith("myprofile")
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Removed profile"),
      )
    })

    it("sets default profile", async () => {
      const ctx = createMockContext()
      const mgr = new ConfigManager(ctx)
      await mgr.handleConfigCommand("default myprofile")
      expect(ctx.profileStore.setDefaultId).toHaveBeenCalledWith("myprofile")
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Default profile set"),
      )
    })

    it("clears default profile with 'default' alone", async () => {
      const ctx = createMockContext()
      const mgr = new ConfigManager(ctx)
      await mgr.handleConfigCommand("default")
      expect(ctx.profileStore.clearDefault).toHaveBeenCalled()
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Cleared default"),
      )
    })

    it("clears default profile with 'default clear'", async () => {
      const ctx = createMockContext()
      const mgr = new ConfigManager(ctx)
      await mgr.handleConfigCommand("default clear")
      expect(ctx.profileStore.clearDefault).toHaveBeenCalled()
    })

    it("shows help for unknown subcommand", async () => {
      const ctx = createMockContext()
      const mgr = new ConfigManager(ctx)
      await mgr.handleConfigCommand("unknown")
      expect(ctx.telegram.sendMessage).toHaveBeenCalled()
    })
  })

  describe("handleCleanCommand", () => {
    it("reports nothing to clean when no idle sessions or orphans exist", async () => {
      const root = "/tmp/test-config-manager-empty"
      fs.mkdirSync(root, { recursive: true })
      const ctx = createMockContext({
        config: {
          ...createMockContext().config,
          workspace: { ...createMockContext().config.workspace, root },
        } as any,
      })
      const mgr = new ConfigManager(ctx)
      await mgr.handleCleanCommand()
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Nothing to clean"),
      )
      expect(ctx.persistTopicSessions).toHaveBeenCalled()
      expect(ctx.updatePinnedSummary).toHaveBeenCalled()
      fs.rmSync(root, { recursive: true, force: true })
    })

    it("cleans idle sessions", async () => {
      const root = "/tmp/test-config-manager-idle"
      const sessionDir = path.join(root, "test-session")
      fs.mkdirSync(sessionDir, { recursive: true })
      fs.writeFileSync(path.join(sessionDir, "file.txt"), "data")

      const ctx = createMockContext({
        config: {
          ...createMockContext().config,
          workspace: { ...createMockContext().config.workspace, root },
        } as any,
      })

      const idleSession: TopicSession = {
        threadId: 42,
        repo: "test",
        cwd: sessionDir,
        slug: "test-slug",
        conversation: [],
        pendingFeedback: [],
        mode: "task",
        lastActivityAt: Date.now(),
      }
      ctx.topicSessions.set(42, idleSession)

      const mgr = new ConfigManager(ctx)
      await mgr.handleCleanCommand()

      expect(ctx.telegram.deleteForumTopic).toHaveBeenCalledWith(42)
      expect(ctx.removeWorkspace).toHaveBeenCalledWith(idleSession)
      expect(ctx.topicSessions.has(42)).toBe(false)
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("idle session"),
      )

      fs.rmSync(root, { recursive: true, force: true })
    })

    it("skips active sessions", async () => {
      const root = "/tmp/test-config-manager-active"
      fs.mkdirSync(root, { recursive: true })

      const ctx = createMockContext({
        config: {
          ...createMockContext().config,
          workspace: { ...createMockContext().config.workspace, root },
        } as any,
      })

      const activeSession: TopicSession = {
        threadId: 99,
        repo: "test",
        cwd: "/tmp/active",
        slug: "active-slug",
        conversation: [],
        pendingFeedback: [],
        mode: "task",
        lastActivityAt: Date.now(),
        activeSessionId: "running-session",
      }
      ctx.topicSessions.set(99, activeSession)

      const mgr = new ConfigManager(ctx)
      await mgr.handleCleanCommand()

      expect(ctx.topicSessions.has(99)).toBe(true)
      expect(ctx.telegram.deleteForumTopic).not.toHaveBeenCalled()

      fs.rmSync(root, { recursive: true, force: true })
    })
  })
})
