import { describe, it, expect } from "vitest"
import type { TopicMessage } from "../src/domain/session-types.js"
import {
  createMockContext,
  makeMockTopicSession,
  makeMockDagGraph,
  makeMockDagNode,
} from "./test-helpers.js"

describe("DispatcherContext", () => {
  it("can be constructed with createMockContext", () => {
    const ctx = createMockContext()
    expect(ctx.config).toBeDefined()
    expect(ctx.sessions).toBeInstanceOf(Map)
    expect(ctx.topicSessions).toBeInstanceOf(Map)
    expect(ctx.dags).toBeInstanceOf(Map)
  })

  it("exposes shared mutable state by reference", () => {
    const ctx = createMockContext()

    const session = makeMockTopicSession({ threadId: 1 })

    ctx.topicSessions.set(1, session)
    expect(ctx.topicSessions.get(1)).toBe(session)
    expect(ctx.topicSessions.size).toBe(1)
  })

  it("allows overriding specific methods", () => {
    let called = false
    const ctx = createMockContext({
      pushToConversation: (session, msg) => {
        called = true
        session.conversation.push(msg)
      },
    })

    const session = makeMockTopicSession({ threadId: 1, conversation: [] })

    ctx.pushToConversation(session, { role: "user", text: "hello" })
    expect(called).toBe(true)
    expect(session.conversation).toHaveLength(1)
    expect(session.conversation[0].text).toBe("hello")
  })

  it("workspace methods return sensible defaults", async () => {
    const ctx = createMockContext()
    const cwd = await ctx.prepareWorkspace("slug-1", "https://github.com/org/repo")
    expect(cwd).toBe("/tmp/test/workspace")

    const session = makeMockTopicSession()
    await expect(ctx.removeWorkspace(session)).resolves.toBeUndefined()
    expect(ctx.mergeUpstreamBranches("/tmp", ["branch-1"])).toEqual({ ok: true, conflictFiles: [] })
  })

  it("extractPRFromConversation returns null by default", () => {
    const ctx = createMockContext()
    const session = makeMockTopicSession()
    const result = ctx.extractPRFromConversation(session)
    expect(result).toBeNull()
  })

  it("cross-module callbacks are callable", async () => {
    let dagStarted = false
    let verificationStarted = false

    const ctx = createMockContext({
      startDag: async () => { dagStarted = true },
      shipAdvanceToVerification: async () => { verificationStarted = true },
    })

    const session = makeMockTopicSession()
    const graph = makeMockDagGraph()

    await ctx.startDag(session, [], false)
    expect(dagStarted).toBe(true)

    await ctx.shipAdvanceToVerification(session, graph)
    expect(verificationStarted).toBe(true)
  })

  it("babysitDagChildCI returns true by default", async () => {
    const ctx = createMockContext()
    const session = makeMockTopicSession()
    const result = await ctx.babysitDagChildCI(session, "https://github.com/org/repo/pull/1")
    expect(result).toBe(true)
  })

  it("spawnSplitChild and spawnDagChild return null by default", async () => {
    const ctx = createMockContext()
    const session = makeMockTopicSession()
    const graph = makeMockDagGraph()
    const node = makeMockDagNode()
    expect(await ctx.spawnSplitChild(session, { title: "t", description: "d" }, [])).toBeNull()
    expect(await ctx.spawnDagChild(session, graph, node, false)).toBeNull()
  })
})
