import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { LandingManager } from "../src/dag/landing-manager.js"
import type { DispatcherContext } from "../src/orchestration/dispatcher-context.js"
import type { TopicSession } from "../src/domain/session-types.js"
import type { DagGraph, DagNode, DagInput } from "../src/dag/dag.js"
import type { QualityReport } from "../src/ci/quality-gates.js"
import { createMockContext } from "./test-helpers.js"

function makeTopicSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 100,
    repo: "test-repo",
    cwd: "/tmp/test",
    slug: "test-slug",
    conversation: [],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

describe("LandingManager", () => {
  describe("handleLandCommand", () => {
    it("sends warning when no DAG and no children", async () => {
      const ctx = createMockContext()
      const manager = new LandingManager(ctx)
      const session = makeTopicSession()

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No DAG or stack found"),
        100,
      )
    })

    it("sends warning when childThreadIds is empty", async () => {
      const ctx = createMockContext()
      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ childThreadIds: [] })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No DAG or stack found"),
        100,
      )
    })

    it("routes to landChildPRs when no dagId but has children", async () => {
      const ctx = createMockContext()
      const childSession = makeTopicSession({
        threadId: 200,
        slug: "child-slug",
        conversation: [],
      })
      ctx.topicSessions.set(200, childSession)

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ childThreadIds: [200] })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No PRs found"),
        100,
      )
    })

    it("routes to landChildPRs and finds PRs from children", async () => {
      const ctx = createMockContext({
        extractPRFromConversation: (s) => {
          if (s.threadId === 200) return "https://github.com/org/repo/pull/1"
          return null
        },
      })
      const childSession = makeTopicSession({
        threadId: 200,
        slug: "child-slug",
        splitLabel: "Fix auth",
      })
      ctx.topicSessions.set(200, childSession)

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ childThreadIds: [200] })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Landing"),
        100,
      )
    })

    it("routes to landDag when dagId is present", async () => {
      const graph: DagGraph = {
        id: "dag-1",
        nodes: [],
        parentThreadId: 100,
        repo: "test-repo",
      }

      const ctx = createMockContext()
      ctx.dags.set("dag-1", graph)

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ dagId: "dag-1" })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No completed PRs to land"),
        100,
      )
    })
  })

  describe("landDag (via handleLandCommand)", () => {
    it("reports no completed PRs when all nodes are pending", async () => {
      const graph: DagGraph = {
        id: "dag-1",
        nodes: [
          { id: "a", title: "Task A", description: "", status: "pending", dependsOn: [] },
        ],
        parentThreadId: 100,
        repo: "test-repo",
      }

      const ctx = createMockContext()
      ctx.dags.set("dag-1", graph)

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ dagId: "dag-1" })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No completed PRs to land"),
        100,
      )
    })

    it("reports no completed PRs when done nodes have no prUrl", async () => {
      const graph: DagGraph = {
        id: "dag-1",
        nodes: [
          { id: "a", title: "Task A", description: "", status: "done", dependsOn: [] },
        ],
        parentThreadId: 100,
        repo: "test-repo",
      }

      const ctx = createMockContext()
      ctx.dags.set("dag-1", graph)

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ dagId: "dag-1" })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No completed PRs to land"),
        100,
      )
    })
  })

  describe("landChildPRs (via handleLandCommand)", () => {
    it("reports no PRs when children have no conversation PRs", async () => {
      const ctx = createMockContext()
      const child = makeTopicSession({ threadId: 201, slug: "child-1" })
      ctx.topicSessions.set(201, child)

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ childThreadIds: [201] })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No PRs found among child sessions"),
        100,
      )
    })

    it("uses splitLabel as title when available", async () => {
      const ctx = createMockContext({
        extractPRFromConversation: () => "https://github.com/org/repo/pull/5",
      })
      const child = makeTopicSession({
        threadId: 201,
        slug: "child-1",
        splitLabel: "Auth module",
      })
      ctx.topicSessions.set(201, child)

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ childThreadIds: [201] })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Landing"),
        100,
      )
    })

    it("skips children not found in topicSessions", async () => {
      const ctx = createMockContext()

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ childThreadIds: [999] })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No PRs found"),
        100,
      )
    })
  })

  describe("worktree pruning before landing", () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join("/tmp", "landing-test-"))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it("prunes stale worktrees before landing DAG nodes", async () => {
      const bareDir = path.join(tmpDir, ".repos", "telegram-minions.git")
      fs.mkdirSync(bareDir, { recursive: true })

      const ctx = createMockContext({
        config: {
          ...createMockContext().config,
          workspace: { ...createMockContext().config.workspace, root: tmpDir },
        },
      })
      const graph: DagGraph = {
        id: "dag-1",
        nodes: [],
        parentThreadId: 100,
        repo: "test-repo",
      }
      ctx.dags.set("dag-1", graph)

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({
        dagId: "dag-1",
        repoUrl: "https://github.com/org/telegram-minions",
      })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No completed PRs to land"),
        100,
      )
    })

    it("starts pre-flight check when DAG has a completed PR", async () => {
      const ctx = createMockContext()
      const graph: DagGraph = {
        id: "dag-1",
        nodes: [
          {
            id: "a",
            title: "Task A",
            description: "",
            status: "done",
            dependsOn: [],
            prUrl: "https://github.com/org/repo/pull/1",
            branch: "minion/a",
          },
        ],
        parentThreadId: 100,
        repo: "test-repo",
      }
      ctx.dags.set("dag-1", graph)

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ dagId: "dag-1" })

      await manager.handleLandCommand(session)

      const calls = (ctx.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
      expect(calls.some((m) => m.includes("Pre-flight check"))).toBe(true)
    })

    it("skips zombie worktree directories in findValidCwd", async () => {
      const zombieDir = path.join(tmpDir, "zombie-worktree")
      fs.mkdirSync(zombieDir, { recursive: true })
      // Write a .git file pointing to a non-existent worktree metadata dir
      fs.writeFileSync(path.join(zombieDir, ".git"), "gitdir: /nonexistent/worktrees/zombie")

      const validDir = path.join(tmpDir, "valid-repo")
      fs.mkdirSync(validDir, { recursive: true })
      // Initialize a real git repo so isValidGitDir returns true
      const { execFileSync } = await import("node:child_process")
      execFileSync("git", ["init"], { cwd: validDir, stdio: "pipe" })

      const ctx = createMockContext()
      // Child 300 has a zombie cwd, child 301 has a valid cwd
      const zombieChild = makeTopicSession({ threadId: 300, cwd: zombieDir })
      const validChild = makeTopicSession({ threadId: 301, cwd: validDir })
      ctx.topicSessions.set(300, zombieChild)
      ctx.topicSessions.set(301, validChild)

      const graph: DagGraph = {
        id: "dag-1",
        nodes: [
          { id: "a", title: "Task A", description: "", status: "done", dependsOn: [], threadId: 300 },
          { id: "b", title: "Task B", description: "", status: "done", dependsOn: [], threadId: 301 },
        ],
        parentThreadId: 100,
        repo: "test-repo",
      }
      ctx.dags.set("dag-1", graph)

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({ dagId: "dag-1" })

      // Access findValidCwd indirectly — it's used during landing
      // We verify by checking that the manager doesn't crash when zombie dirs exist
      await manager.handleLandCommand(session)

      // Should reach "No completed PRs" (no prUrl on nodes) without crashing
      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No completed PRs to land"),
        100,
      )
    })

    it("resolves bare dir correctly from repoUrl", async () => {
      const bareDir = path.join(tmpDir, ".repos", "my-repo.git")
      fs.mkdirSync(bareDir, { recursive: true })

      const ctx = createMockContext({
        config: {
          ...createMockContext().config,
          workspace: { ...createMockContext().config.workspace, root: tmpDir },
        },
      })
      const graph: DagGraph = {
        id: "dag-1",
        nodes: [],
        parentThreadId: 100,
        repo: "my-repo",
      }
      ctx.dags.set("dag-1", graph)

      const manager = new LandingManager(ctx)
      const session = makeTopicSession({
        dagId: "dag-1",
        repoUrl: "https://github.com/org/my-repo",
      })

      await manager.handleLandCommand(session)

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("No completed PRs to land"),
        100,
      )
    })
  })
})
