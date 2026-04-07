import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { ConfigManager } from "../src/config/config-manager.js"
import type { DispatcherContext } from "../src/orchestration/dispatcher-context.js"
import type { TopicSession } from "../src/domain/session-types.js"
import {
  createMockContext,
  makeMockConfig,
  makeMockProfileStore,
  makeMockTopicSession,
} from "./test-helpers.js"

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
        profileStore: makeMockProfileStore({
          add: vi.fn(() => false),
        }),
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
        config: makeMockConfig({
          workspace: {
            ...makeMockConfig().workspace,
            root,
          },
        }),
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
        config: makeMockConfig({
          workspace: {
            ...makeMockConfig().workspace,
            root,
          },
        }),
      })

      const idleSession = makeMockTopicSession({
        threadId: 42,
        repo: "test",
        cwd: sessionDir,
        slug: "test-slug",
        mode: "task",
      })
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
        config: makeMockConfig({
          workspace: {
            ...makeMockConfig().workspace,
            root,
          },
        }),
      })

      const activeSession = makeMockTopicSession({
        threadId: 99,
        repo: "test",
        cwd: "/tmp/active",
        slug: "active-slug",
        mode: "task",
        activeSessionId: "running-session",
      })
      ctx.topicSessions.set(99, activeSession)

      const mgr = new ConfigManager(ctx)
      await mgr.handleCleanCommand()

      expect(ctx.topicSessions.has(99)).toBe(true)
      expect(ctx.telegram.deleteForumTopic).not.toHaveBeenCalled()

      fs.rmSync(root, { recursive: true, force: true })
    })
  })
})
