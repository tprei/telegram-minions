import { describe, it, expect } from "vitest"
import type { TopicSession } from "../src/domain/session-types.js"
import type { DagGraph } from "../src/dag/dag.js"
import {
  summarizeThread,
  extractConversationTail,
  gatherDiagnosticEvidence,
  buildDoctorPrompt,
} from "../src/commands/doctor.js"
import type { GatherEvidenceOptions } from "../src/commands/doctor.js"

function makeSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 1,
    repo: "test-repo",
    cwd: "/tmp/test",
    slug: "brave-penguin",
    conversation: [],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

function makeDag(overrides: Partial<DagGraph> = {}): DagGraph {
  return {
    id: "dag-1",
    nodes: [],
    parentThreadId: 1,
    repo: "test-repo",
    createdAt: Date.now(),
    ...overrides,
  }
}

describe("extractConversationTail", () => {
  it("returns empty array for empty conversation", () => {
    expect(extractConversationTail([])).toEqual([])
  })

  it("extracts last N messages with role labels", () => {
    const conversation = [
      { role: "user" as const, text: "Do the thing" },
      { role: "assistant" as const, text: "Working on it" },
      { role: "user" as const, text: "How's it going?" },
      { role: "assistant" as const, text: "Almost done" },
    ]
    const tail = extractConversationTail(conversation, 2)
    expect(tail).toHaveLength(2)
    expect(tail[0]).toBe("User: How's it going?")
    expect(tail[1]).toBe("Agent: Almost done")
  })

  it("truncates long messages", () => {
    const longText = "x".repeat(1000)
    const conversation = [{ role: "user" as const, text: longText }]
    const tail = extractConversationTail(conversation, 6, 100)
    expect(tail).toHaveLength(1)
    expect(tail[0].length).toBeLessThan(200)
    expect(tail[0]).toContain("…")
  })

  it("strips tool noise from messages", () => {
    const conversation = [
      { role: "assistant" as const, text: "Here is the fix:\n```typescript\nconst x = 1\n```\nDone." },
    ]
    const tail = extractConversationTail(conversation)
    expect(tail[0]).toContain("[code block]")
    expect(tail[0]).not.toContain("const x = 1")
  })

  it("defaults to 6 messages max", () => {
    const conversation = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `Message ${i}`,
    }))
    const tail = extractConversationTail(conversation)
    expect(tail).toHaveLength(6)
    expect(tail[0]).toContain("Message 4")
  })
})

describe("summarizeThread", () => {
  it("returns a ThreadSummary from a TopicSession", () => {
    const session = makeSession({
      threadId: 42,
      slug: "cool-fox",
      mode: "plan",
      repo: "my-repo",
      lastState: "completed",
      branch: "minion/cool-fox",
      prUrl: "https://github.com/org/repo/pull/1",
      dagNodeId: "step-0",
      splitLabel: "Auth flow",
      conversation: [
        { role: "user", text: "Fix the bug" },
        { role: "assistant", text: "Done" },
      ],
    })

    const summary = summarizeThread(session, true)

    expect(summary.threadId).toBe(42)
    expect(summary.slug).toBe("cool-fox")
    expect(summary.mode).toBe("plan")
    expect(summary.repo).toBe("my-repo")
    expect(summary.lastState).toBe("completed")
    expect(summary.branch).toBe("minion/cool-fox")
    expect(summary.prUrl).toBe("https://github.com/org/repo/pull/1")
    expect(summary.dagNodeId).toBe("step-0")
    expect(summary.splitLabel).toBe("Auth flow")
    expect(summary.isActive).toBe(true)
    expect(summary.conversationTail).toHaveLength(2)
  })

  it("handles minimal session", () => {
    const summary = summarizeThread(makeSession(), false)
    expect(summary.isActive).toBe(false)
    expect(summary.conversationTail).toEqual([])
    expect(summary.lastState).toBeUndefined()
  })
})

describe("gatherDiagnosticEvidence", () => {
  function buildOpts(overrides: Partial<GatherEvidenceOptions> = {}): GatherEvidenceOptions {
    return {
      currentSession: makeSession(),
      isCurrentActive: false,
      getSession: () => undefined,
      isSessionActive: () => false,
      getDag: () => undefined,
      chatId: -1001234,
      ...overrides,
    }
  }

  it("gathers evidence for a standalone thread", () => {
    const evidence = gatherDiagnosticEvidence(buildOpts())

    expect(evidence.currentThread.slug).toBe("brave-penguin")
    expect(evidence.parentThread).toBeUndefined()
    expect(evidence.childThreads).toEqual([])
    expect(evidence.dagStatus).toBeUndefined()
    expect(evidence.dagFailedNodes).toEqual([])
  })

  it("resolves parent thread", () => {
    const parent = makeSession({ threadId: 100, slug: "parent-owl", childThreadIds: [1] })
    const child = makeSession({ threadId: 1, slug: "child-fox", parentThreadId: 100 })

    const evidence = gatherDiagnosticEvidence(buildOpts({
      currentSession: child,
      getSession: (id) => id === 100 ? parent : undefined,
      isSessionActive: (id) => id === 100,
    }))

    expect(evidence.parentThread).toBeDefined()
    expect(evidence.parentThread!.slug).toBe("parent-owl")
    expect(evidence.parentThread!.isActive).toBe(true)
  })

  it("resolves child threads from parent", () => {
    const child1 = makeSession({ threadId: 10, slug: "child-a", parentThreadId: 1, splitLabel: "Task A" })
    const child2 = makeSession({ threadId: 20, slug: "child-b", parentThreadId: 1, splitLabel: "Task B" })
    const parent = makeSession({ threadId: 1, slug: "parent-owl", childThreadIds: [10, 20] })

    const sessions = new Map<number, TopicSession>([
      [1, parent], [10, child1], [20, child2],
    ])

    const evidence = gatherDiagnosticEvidence(buildOpts({
      currentSession: parent,
      getSession: (id) => sessions.get(id),
    }))

    expect(evidence.childThreads).toHaveLength(2)
    expect(evidence.childThreads[0].slug).toBe("child-a")
    expect(evidence.childThreads[1].slug).toBe("child-b")
  })

  it("resolves child threads when invoked from a child", () => {
    const child1 = makeSession({ threadId: 10, slug: "child-a", parentThreadId: 1 })
    const child2 = makeSession({ threadId: 20, slug: "child-b", parentThreadId: 1 })
    const parent = makeSession({ threadId: 1, slug: "parent-owl", childThreadIds: [10, 20] })

    const sessions = new Map<number, TopicSession>([
      [1, parent], [10, child1], [20, child2],
    ])

    const evidence = gatherDiagnosticEvidence(buildOpts({
      currentSession: child1,
      getSession: (id) => sessions.get(id),
    }))

    expect(evidence.parentThread).toBeDefined()
    expect(evidence.childThreads).toHaveLength(2)
  })

  it("collects DAG status and failed nodes", () => {
    const graph = makeDag({
      nodes: [
        { id: "a", title: "Setup DB", description: "...", dependsOn: [], status: "done" },
        { id: "b", title: "Add API", description: "...", dependsOn: ["a"], status: "failed", error: "Timeout" },
        { id: "c", title: "Add UI", description: "...", dependsOn: ["b"], status: "skipped" },
      ],
    })

    const session = makeSession({ dagId: "dag-1" })

    const evidence = gatherDiagnosticEvidence(buildOpts({
      currentSession: session,
      getDag: (id) => id === "dag-1" ? graph : undefined,
    }))

    expect(evidence.dagStatus).toBeDefined()
    expect(evidence.dagProgress).toBeDefined()
    expect(evidence.dagProgress!.done).toBe(1)
    expect(evidence.dagProgress!.failed).toBe(1)
    expect(evidence.dagProgress!.skipped).toBe(1)
    expect(evidence.dagFailedNodes).toHaveLength(2)
    expect(evidence.dagFailedNodes[0].id).toBe("b")
    expect(evidence.dagFailedNodes[0].error).toBe("Timeout")
    expect(evidence.dagFailedNodes[1].id).toBe("c")
  })

  it("resolves DAG from parent thread", () => {
    const parent = makeSession({ threadId: 1, slug: "parent", dagId: "dag-1", childThreadIds: [10] })
    const child = makeSession({ threadId: 10, slug: "child", parentThreadId: 1 })
    const graph = makeDag({ id: "dag-1" })

    const sessions = new Map<number, TopicSession>([[1, parent], [10, child]])

    const evidence = gatherDiagnosticEvidence(buildOpts({
      currentSession: child,
      getSession: (id) => sessions.get(id),
      getDag: (id) => id === "dag-1" ? graph : undefined,
    }))

    expect(evidence.dagStatus).toBeDefined()
  })

  it("handles missing DAG gracefully", () => {
    const session = makeSession({ dagId: "nonexistent" })
    const evidence = gatherDiagnosticEvidence(buildOpts({
      currentSession: session,
      getDag: () => undefined,
    }))

    expect(evidence.dagStatus).toBeUndefined()
    expect(evidence.dagFailedNodes).toEqual([])
  })

  it("includes ci-failed nodes in dagFailedNodes", () => {
    const graph = makeDag({
      nodes: [
        { id: "a", title: "Build", description: "...", dependsOn: [], status: "done" },
        { id: "b", title: "Deploy", description: "...", dependsOn: ["a"], status: "ci-failed", error: "lint failed" },
      ],
    })
    const session = makeSession({ dagId: "dag-1" })

    const evidence = gatherDiagnosticEvidence(buildOpts({
      currentSession: session,
      getDag: (id) => id === "dag-1" ? graph : undefined,
    }))

    expect(evidence.dagFailedNodes).toHaveLength(1)
    expect(evidence.dagFailedNodes[0].id).toBe("b")
    expect(evidence.dagFailedNodes[0].status).toBe("ci-failed")
    expect(evidence.dagFailedNodes[0].error).toBe("lint failed")
  })

  it("passes chatId through to evidence", () => {
    const evidence = gatherDiagnosticEvidence(buildOpts({
      chatId: -1009999,
    }))

    expect(evidence.chatId).toBe(-1009999)
  })

  it("skips missing child sessions gracefully", () => {
    const parent = makeSession({ threadId: 1, slug: "parent", childThreadIds: [10, 20, 30] })

    const evidence = gatherDiagnosticEvidence(buildOpts({
      currentSession: parent,
      getSession: (id) => id === 10 ? makeSession({ threadId: 10, slug: "only-child", parentThreadId: 1 }) : undefined,
    }))

    expect(evidence.childThreads).toHaveLength(1)
    expect(evidence.childThreads[0].slug).toBe("only-child")
  })
})

describe("buildDoctorPrompt", () => {
  it("builds a prompt with current thread only", () => {
    const evidence = gatherDiagnosticEvidence({
      currentSession: makeSession({
        conversation: [
          { role: "user", text: "Fix the login bug" },
          { role: "assistant", text: "I've identified the issue" },
        ],
      }),
      isCurrentActive: false,
      getSession: () => undefined,
      isSessionActive: () => false,
      getDag: () => undefined,
    })

    const prompt = buildDoctorPrompt(evidence)

    expect(prompt).toContain("## Diagnostic report")
    expect(prompt).toContain("### Current thread")
    expect(prompt).toContain("brave-penguin")
    expect(prompt).toContain("task mode")
    expect(prompt).toContain("### Instructions")
    expect(prompt).not.toContain("### Parent thread")
    expect(prompt).not.toContain("### Child threads")
    expect(prompt).not.toContain("### DAG status")
  })

  it("includes parent, children, and DAG sections when present", () => {
    const parent = makeSession({ threadId: 1, slug: "parent-owl", dagId: "dag-1", childThreadIds: [10, 20] })
    const child1 = makeSession({ threadId: 10, slug: "child-a", parentThreadId: 1, lastState: "completed", prUrl: "https://github.com/org/repo/pull/1" })
    const child2 = makeSession({ threadId: 20, slug: "child-b", parentThreadId: 1, lastState: "errored" })
    const graph = makeDag({
      id: "dag-1",
      nodes: [
        { id: "a", title: "Task A", description: "...", dependsOn: [], status: "done", threadId: 10 },
        { id: "b", title: "Task B", description: "...", dependsOn: ["a"], status: "failed", threadId: 20, error: "Session crashed" },
      ],
    })

    const sessions = new Map<number, TopicSession>([[1, parent], [10, child1], [20, child2]])

    const evidence = gatherDiagnosticEvidence({
      currentSession: parent,
      isCurrentActive: false,
      getSession: (id) => sessions.get(id),
      isSessionActive: () => false,
      getDag: (id) => id === "dag-1" ? graph : undefined,
      chatId: -1001234,
    })

    const prompt = buildDoctorPrompt(evidence)

    expect(prompt).toContain("### Current thread")
    expect(prompt).toContain("parent-owl")
    expect(prompt).not.toContain("### Parent thread")
    expect(prompt).toContain("### Child threads")
    expect(prompt).toContain("child-a")
    expect(prompt).toContain("child-b")
    expect(prompt).toContain("### DAG status")
    expect(prompt).toContain("### Failed/problematic nodes")
    expect(prompt).toContain("Session crashed")
    expect(prompt).toContain("root cause")
  })

  it("includes thread links when chatId is provided", () => {
    const evidence = gatherDiagnosticEvidence({
      currentSession: makeSession({ threadId: 42 }),
      isCurrentActive: false,
      getSession: () => undefined,
      isSessionActive: () => false,
      getDag: () => undefined,
      chatId: -1001234567,
    })

    const prompt = buildDoctorPrompt(evidence)
    expect(prompt).toContain("https://t.me/c/")
  })

  it("formats failed node errors without error field", () => {
    const graph = makeDag({
      nodes: [
        { id: "x", title: "Broken", description: "...", dependsOn: [], status: "skipped" },
      ],
    })
    const evidence = gatherDiagnosticEvidence({
      currentSession: makeSession({ dagId: "dag-1" }),
      isCurrentActive: false,
      getSession: () => undefined,
      isSessionActive: () => false,
      getDag: (id) => id === "dag-1" ? graph : undefined,
    })
    const prompt = buildDoctorPrompt(evidence)

    expect(prompt).toContain("**x** (Broken): status=skipped")
    expect(prompt).not.toContain("error:")
  })

  it("produces well-structured markdown", () => {
    const evidence = gatherDiagnosticEvidence({
      currentSession: makeSession(),
      isCurrentActive: false,
      getSession: () => undefined,
      isSessionActive: () => false,
      getDag: () => undefined,
    })

    const prompt = buildDoctorPrompt(evidence)

    // Should have the standard sections
    expect(prompt).toMatch(/^## Diagnostic report/)
    expect(prompt).toContain("### Instructions")
    expect(prompt).toContain("1. Identify the root cause")
    expect(prompt).toContain("2. Propose a concrete fix")
  })
})
