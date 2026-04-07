import { describe, it, expect, vi } from "vitest"
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
})
