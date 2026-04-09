import { describe, it, expect, vi } from "vitest"
import {
  makeMockTelegram,
  makeMockObserver,
  makeMockStats,
  makeMockProfileStore,
  makeMockSessionPort,
  makeMockActiveSession,
  makeMockTopicSession,
  makeMockPendingTask,
  makeMockConfig,
  createMockContext,
  mockExecFileSuccess,
  mockExecFileError,
  mockExecFileResponses,
} from "./test-helpers.js"
import type { DispatcherContext } from "../src/orchestration/dispatcher-context.js"

describe("makeMockTelegram", () => {
  it("returns a mock with all TelegramClient methods", async () => {
    const tg = makeMockTelegram()
    expect(await tg.sendMessage("hi")).toEqual({ ok: true, messageId: "1" })
    expect(await tg.editMessage(1, "hi")).toBe(true)
    expect(await tg.getUpdates(0, 1)).toEqual([])
    const topic = await tg.createForumTopic("test")
    expect(topic).toEqual({ message_thread_id: 100, name: "test", icon_color: 0 })
  })

  it("accepts overrides", async () => {
    const tg = makeMockTelegram({
      sendMessage: vi.fn(async () => ({ ok: false, messageId: null })),
    })
    expect(await tg.sendMessage("hi")).toEqual({ ok: false, messageId: null })
  })
})

describe("makeMockObserver", () => {
  it("returns a mock with observer methods", async () => {
    const obs = makeMockObserver()
    await expect(obs.onSessionStart({} as Parameters<typeof obs.onSessionStart>[0], "task")).resolves.toBeUndefined()
  })
})

describe("makeMockStats", () => {
  it("returns sensible defaults", async () => {
    const stats = makeMockStats()
    const agg = await stats.aggregate()
    expect(agg.totalSessions).toBe(0)
    expect(await stats.load()).toEqual([])
  })
})

describe("makeMockProfileStore", () => {
  it("lists default profile", () => {
    const store = makeMockProfileStore()
    const profiles = store.list()
    expect(profiles).toHaveLength(1)
    expect(profiles[0].id).toBe("claude-acp")
  })
})

describe("makeMockSessionPort", () => {
  it("has sensible defaults", async () => {
    const port = makeMockSessionPort()
    expect(port.meta.sessionId).toBe("test-session-1")
    expect(port.isClosed()).toBe(false)
    expect(port.isActive()).toBe(true)
    expect(port.injectReply("hi")).toBe(true)
    expect(await port.waitForCompletion()).toBe("completed")
  })

  it("accepts partial overrides", () => {
    const port = makeMockSessionPort({
      meta: {
        sessionId: "custom",
        threadId: 42,
        topicName: "custom-topic",
        repo: "my-repo",
        cwd: "/custom",
        startedAt: 0,
        mode: "plan",
      },
    })
    expect(port.meta.sessionId).toBe("custom")
    expect(port.meta.threadId).toBe(42)
  })
})

describe("makeMockActiveSession", () => {
  it("creates a complete ActiveSession with defaults", () => {
    const session = makeMockActiveSession()
    expect(session.handle).toBeDefined()
    expect(session.meta).toBe(session.handle.meta)
    expect(session.task).toBe("test task")
  })

  it("accepts task override", () => {
    const session = makeMockActiveSession({ task: "custom task" })
    expect(session.task).toBe("custom task")
  })
})

describe("makeMockTopicSession", () => {
  it("creates a minimal TopicSession", () => {
    const ts = makeMockTopicSession()
    expect(ts.threadId).toBe("1")
    expect(ts.slug).toBe("test-slug")
    expect(ts.conversation).toEqual([])
    expect(ts.pendingFeedback).toEqual([])
    expect(ts.mode).toBe("task")
  })

  it("accepts overrides", () => {
    const ts = makeMockTopicSession({
      threadId: "99",
      mode: "plan",
      childThreadIds: ["10", "20"],
    })
    expect(ts.threadId).toBe("99")
    expect(ts.mode).toBe("plan")
    expect(ts.childThreadIds).toEqual(["10", "20"])
  })
})

describe("makeMockPendingTask", () => {
  it("creates a minimal PendingTask", () => {
    const pt = makeMockPendingTask()
    expect(pt.task).toBe("test task")
    expect(pt.mode).toBe("task")
  })

  it("accepts overrides", () => {
    const pt = makeMockPendingTask({ mode: "plan", repoSlug: "my-repo" })
    expect(pt.mode).toBe("plan")
    expect(pt.repoSlug).toBe("my-repo")
  })
})

describe("makeMockConfig", () => {
  it("produces a complete MinionConfig", () => {
    const cfg = makeMockConfig()
    expect(cfg.telegram.botToken).toBe("test")
    expect(cfg.workspace.maxConcurrentSessions).toBe(5)
    expect(cfg.ci.dagCiPolicy).toBe("skip")
    expect(cfg.quota.retryMax).toBe(2)
  })

  it("accepts partial overrides", () => {
    const cfg = makeMockConfig({ repos: { myrepo: "https://github.com/org/repo" } })
    expect(cfg.repos.myrepo).toBe("https://github.com/org/repo")
    expect(cfg.telegram.botToken).toBe("test")
  })
})

describe("createMockContext", () => {
  it("produces a complete DispatcherContext with all required properties", () => {
    const ctx = createMockContext()
    expect(ctx.config).toBeDefined()
    expect(ctx.chat).toBeDefined()
    expect(ctx.threads).toBeDefined()
    expect(ctx.ui).toBeDefined()
    expect(ctx.observer).toBeDefined()
    expect(ctx.stats).toBeDefined()
    expect(ctx.profileStore).toBeDefined()
    expect(ctx.sessions).toBeInstanceOf(Map)
    expect(ctx.topicSessions).toBeInstanceOf(Map)
    expect(ctx.dags).toBeInstanceOf(Map)
    expect(ctx.pendingTasks).toBeInstanceOf(Map)
    expect(ctx.abortControllers).toBeInstanceOf(Map)
  })

  it("has all methods callable", async () => {
    const ctx = createMockContext()
    await expect(ctx.refreshGitToken()).resolves.toBeUndefined()
    await expect(ctx.spawnTopicAgent(makeMockTopicSession(), "task")).resolves.toBe(true)
    expect(ctx.mergeUpstreamBranches("/tmp", ["b"])).toEqual({ ok: true, conflictFiles: [] })
    expect(ctx.extractPRFromConversation(makeMockTopicSession())).toBeNull()
    await expect(ctx.babysitDagChildCI(makeMockTopicSession(), "url")).resolves.toBe(true)
    await expect(ctx.spawnSplitChild(makeMockTopicSession(), { title: "t", description: "d" }, [])).resolves.toBeNull()
    await expect(ctx.spawnDagChild(makeMockTopicSession(), {} as Parameters<typeof ctx.spawnDagChild>[1], {} as Parameters<typeof ctx.spawnDagChild>[2], false)).resolves.toBeNull()
  })

  it("methods are vi.fn() spies", () => {
    const ctx = createMockContext()
    ctx.updatePinnedSummary()
    expect(vi.isMockFunction(ctx.updatePinnedSummary)).toBe(true)
    expect(ctx.updatePinnedSummary).toHaveBeenCalledOnce()
  })

  it("allows overriding individual methods", async () => {
    let called = false
    const ctx = createMockContext({
      prepareWorkspace: vi.fn(async () => {
        called = true
        return "/custom/path"
      }),
    })
    const result = await ctx.prepareWorkspace("slug")
    expect(called).toBe(true)
    expect(result).toBe("/custom/path")
  })

  it("exposes shared mutable state by reference", () => {
    const ctx = createMockContext()
    const ts = makeMockTopicSession({ threadId: 42 })
    ctx.topicSessions.set(42, ts)
    expect(ctx.topicSessions.get(42)).toBe(ts)
  })
})

describe("execFile mock helpers", () => {
  it("mockExecFileSuccess calls back with output", () => {
    const mock = vi.fn()
    mockExecFileSuccess(mock, '{"login":"user"}')

    let result = ""
    mock("gh", ["api", "user"], (err: Error | null, stdout: string) => {
      result = stdout
    })
    expect(result).toBe('{"login":"user"}')
  })

  it("mockExecFileError calls back with error", () => {
    const mock = vi.fn()
    mockExecFileError(mock, "not found")

    let error: Error | null = null
    mock("gh", ["pr", "view"], (err: Error | null) => {
      error = err
    })
    expect(error).toBeInstanceOf(Error)
    expect((error as unknown as { stderr: string }).stderr).toBe("not found")
  })

  it("mockExecFileResponses matches commands selectively", () => {
    const mock = vi.fn()
    mockExecFileResponses(mock, [
      { match: "pr checks", output: "pass" },
      { match: /api.*user/, output: '{"login":"bot"}' },
      { match: "pr merge", error: "merge failed" },
    ])

    let out = ""
    mock("gh", ["pr", "checks"], (err: Error | null, stdout: string) => { out = stdout })
    expect(out).toBe("pass")

    mock("gh", ["api", "/user"], (err: Error | null, stdout: string) => { out = stdout })
    expect(out).toBe('{"login":"bot"}')

    let mergeErr: Error | null = null
    mock("gh", ["pr", "merge"], (err: Error | null) => { mergeErr = err })
    expect(mergeErr).toBeInstanceOf(Error)

    // Unmatched commands return empty output
    mock("gh", ["unknown"], (err: Error | null, stdout: string) => { out = stdout })
    expect(out).toBe("")
  })
})
