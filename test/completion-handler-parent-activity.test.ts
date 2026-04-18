import { describe, it, expect, vi } from "vitest"
import { CompletionHandlerChain } from "../src/handlers/completion-handler-chain.js"
import type { TopicSession } from "../src/domain/session-types.js"
import type { SessionCompletedEvent } from "../src/events/domain-events.js"

function makeSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 100,
    repo: "test-repo",
    cwd: "/tmp/test",
    slug: "test-slug",
    conversation: [],
    pendingFeedback: [],
    mode: "task" as const,
    lastActivityAt: Date.now() - 60_000,
    ...overrides,
  }
}

function makeEvent(threadId: number, sessionId: string): SessionCompletedEvent {
  return {
    type: "session.completed",
    state: "completed",
    meta: {
      threadId,
      sessionId,
      startedAt: Date.now() - 10_000,
      tokenUsage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.01,
    },
  }
}

describe("CompletionHandlerChain parent lastActivityAt bubbling", () => {
  it("updates parent lastActivityAt when a child session completes", async () => {
    const parentSession = makeSession({ threadId: 1, lastActivityAt: Date.now() - 120_000 })
    const childSession = makeSession({
      threadId: 2,
      parentThreadId: 1,
      activeSessionId: "child-session-1",
      lastActivityAt: Date.now() - 5_000,
    })

    const topicSessions = new Map<number, TopicSession>([
      [1, parentSession],
      [2, childSession],
    ])

    const chain = new CompletionHandlerChain(
      { get: (id) => topicSessions.get(id) },
      { delete: vi.fn() },
      { broadcastSession: vi.fn() },
      { updatePinnedSummary: vi.fn() },
      { persistTopicSessions: vi.fn().mockResolvedValue(undefined) },
      { getQueue: vi.fn().mockReturnValue(undefined) },
    )

    const parentTimeBefore = parentSession.lastActivityAt
    const event = makeEvent(2, "child-session-1")

    await (chain as unknown as { onSessionCompleted(e: SessionCompletedEvent): Promise<void> })
      .onSessionCompleted(event)

    expect(parentSession.lastActivityAt).toBeGreaterThan(parentTimeBefore)
    expect(childSession.lastActivityAt).toBeGreaterThan(parentTimeBefore)
  })

  it("does not crash when child has no parent", async () => {
    const orphanSession = makeSession({
      threadId: 3,
      activeSessionId: "orphan-session-1",
    })

    const topicSessions = new Map<number, TopicSession>([[3, orphanSession]])

    const chain = new CompletionHandlerChain(
      { get: (id) => topicSessions.get(id) },
      { delete: vi.fn() },
      { broadcastSession: vi.fn() },
      { updatePinnedSummary: vi.fn() },
      { persistTopicSessions: vi.fn().mockResolvedValue(undefined) },
      { getQueue: vi.fn().mockReturnValue(undefined) },
    )

    const event = makeEvent(3, "orphan-session-1")

    // Should not throw
    await (chain as unknown as { onSessionCompleted(e: SessionCompletedEvent): Promise<void> })
      .onSessionCompleted(event)

    expect(orphanSession.activeSessionId).toBeUndefined()
  })

  it("does not crash when parent session no longer exists", async () => {
    const childSession = makeSession({
      threadId: 4,
      parentThreadId: 999,
      activeSessionId: "child-session-2",
    })

    const topicSessions = new Map<number, TopicSession>([[4, childSession]])

    const chain = new CompletionHandlerChain(
      { get: (id) => topicSessions.get(id) },
      { delete: vi.fn() },
      { broadcastSession: vi.fn() },
      { updatePinnedSummary: vi.fn() },
      { persistTopicSessions: vi.fn().mockResolvedValue(undefined) },
      { getQueue: vi.fn().mockReturnValue(undefined) },
    )

    const event = makeEvent(4, "child-session-2")

    // Should not throw even though parent 999 doesn't exist
    await (chain as unknown as { onSessionCompleted(e: SessionCompletedEvent): Promise<void> })
      .onSessionCompleted(event)

    expect(childSession.activeSessionId).toBeUndefined()
  })
})
