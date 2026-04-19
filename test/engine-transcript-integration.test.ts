import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { MinionEngine } from "../src/engine/engine.js"
import type { TelegramClient } from "../src/telegram/telegram.js"
import { TelegramPlatform } from "../src/telegram/telegram-platform.js"
import { Observer } from "../src/telegram/observer.js"
import type { MinionConfig } from "../src/config/config-types.js"
import type { TopicSession, TopicMessage } from "../src/domain/session-types.js"
import type { GooseStreamEvent } from "../src/domain/goose-types.js"
import type { EngineEvent } from "../src/engine/events.js"
import type { TranscriptEvent } from "../src/transcript/types.js"
import { EventBus } from "../src/events/event-bus.js"

vi.mock("../src/session/session-log.js", () => ({
  writeSessionLog: vi.fn(),
}))

let workspaceRoot = ""

function makeMockTelegram(): TelegramClient {
  return {
    deleteForumTopic: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: 1 }),
    editMessage: vi.fn().mockResolvedValue(true),
    createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 42, name: "test" }),
    getUpdates: vi.fn().mockResolvedValue([]),
    downloadFile: vi.fn().mockResolvedValue(false),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    pinMessage: vi.fn().mockResolvedValue(true),
    sendChatAction: vi.fn().mockResolvedValue(true),
    pinChatMessage: vi.fn().mockResolvedValue(true),
    editForumTopic: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    sendMessageWithKeyboard: vi.fn().mockResolvedValue(1),
  } as unknown as TelegramClient
}

function makeConfig(): MinionConfig {
  return {
    telegram: { token: "test", chatId: "123", allowedUserIds: [1] },
    telegramQueue: { minSendIntervalMs: 0 },
    workspace: {
      root: workspaceRoot,
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
      flyEnabled: false,
      flyOrg: "",
      zaiEnabled: false,
    },
    goose: { provider: "test", model: "test" },
    claude: { planModel: "test", thinkModel: "test", reviewModel: "test", taskModel: "test" },
    observer: { activityThrottleMs: 0, textFlushDebounceMs: 0, activityEditDebounceMs: 0 },
    repos: {},
    quota: { retryMax: 3, defaultSleepMs: 1000 },
  } as unknown as MinionConfig
}

function makeSession(overrides: Partial<TopicSession> = {}): TopicSession {
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
  } as TopicSession
}

function createEngine() {
  const telegram = makeMockTelegram()
  const config = makeConfig()
  const platform = new TelegramPlatform(telegram, String(config.telegram.chatId))
  const observer = new Observer(platform, 123)
  const eventBus = new EventBus()
  const engine = new MinionEngine(platform, observer, config, eventBus)
  return { engine, platform, observer, config, eventBus }
}

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minion-transcript-"))
})

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
})

describe("MinionEngine transcript integration", () => {
  it("exposes a TranscriptStore", () => {
    const { engine } = createEngine()
    expect(engine.transcriptStore).toBeDefined()
    expect(typeof engine.transcriptStore.append).toBe("function")
  })

  it("mirrors user messages from pushToConversation into the transcript", async () => {
    const { engine } = createEngine()
    const session = makeSession({ slug: "happy-badger" })

    const emitted: EngineEvent[] = []
    engine.events.onAny((e) => { emitted.push(e) })

    const e = engine as unknown as {
      pushToConversation(s: TopicSession, m: TopicMessage): void
    }
    e.pushToConversation(session, { role: "user", text: "implement feature" })

    await new Promise((r) => setTimeout(r, 10))

    const transcriptEnvelopes = emitted.filter(
      (ev): ev is Extract<EngineEvent, { type: "transcript_event" }> => ev.type === "transcript_event",
    )
    const turnStarted = transcriptEnvelopes.find((ev) => ev.event.type === "turn_started")
    const userMessage = transcriptEnvelopes.find((ev) => ev.event.type === "user_message")
    expect(turnStarted).toBeDefined()
    expect(userMessage).toBeDefined()
    expect(userMessage?.sessionId).toBe("happy-badger")
    if (userMessage?.event.type !== "user_message") throw new Error("type guard")
    expect(userMessage.event.text).toBe("implement feature")
    expect(userMessage.event.turn).toBe(0)

    await engine.transcriptStore.flush("happy-badger")
    const stored = engine.transcriptStore.get("happy-badger")
    expect(stored.map((ev) => ev.type)).toEqual(["turn_started", "user_message"])
  })

  it("does not mirror assistant messages into the transcript", async () => {
    const { engine } = createEngine()
    const session = makeSession({ slug: "shy-deer" })

    const emitted: EngineEvent[] = []
    engine.events.onAny((e) => { emitted.push(e) })

    const e = engine as unknown as {
      pushToConversation(s: TopicSession, m: TopicMessage): void
    }
    e.pushToConversation(session, { role: "assistant", text: "working on it" })

    await new Promise((r) => setTimeout(r, 10))

    const transcriptEnvelopes = emitted.filter((ev) => ev.type === "transcript_event")
    expect(transcriptEnvelopes).toHaveLength(0)
    expect(engine.transcriptStore.get("shy-deer")).toHaveLength(0)
  })

  it("emits transcript_event envelopes via the TranscriptBuilder helper", async () => {
    const { engine } = createEngine()
    const slug = "brisk-otter"

    const emitted: EngineEvent[] = []
    engine.events.onAny((e) => { emitted.push(e) })

    const e = engine as unknown as {
      getOrCreateTranscriptBuilder(id: string): {
        userMessage(t: string): TranscriptEvent[]
        handleEvent(ev: GooseStreamEvent): TranscriptEvent[]
      }
      emitTranscriptEvents(id: string, events: TranscriptEvent[]): void
    }
    const builder = e.getOrCreateTranscriptBuilder(slug)
    const events = builder.userMessage("hello")
    e.emitTranscriptEvents(slug, events)

    const gooseEvent: GooseStreamEvent = {
      type: "message",
      message: {
        role: "assistant",
        created: 0,
        content: [{ type: "text", text: "Hi!" }],
      },
    }
    const textEvents = builder.handleEvent(gooseEvent)
    e.emitTranscriptEvents(slug, textEvents)
    const completeEvents = builder.handleEvent({
      type: "complete",
      total_tokens: 10,
      total_cost_usd: 0.001,
      num_turns: 1,
    })
    e.emitTranscriptEvents(slug, completeEvents)

    await new Promise((r) => setTimeout(r, 10))

    const transcriptEnvelopes = emitted.filter((ev) => ev.type === "transcript_event")
    const types = transcriptEnvelopes.map((ev) => {
      if (ev.type !== "transcript_event") throw new Error("unreachable")
      return ev.event.type
    })
    expect(types).toContain("turn_started")
    expect(types).toContain("user_message")
    expect(types).toContain("assistant_text")
    expect(types).toContain("turn_completed")

    await engine.transcriptStore.flush(slug)
    expect(engine.transcriptStore.has(slug)).toBe(true)
    const stored = engine.transcriptStore.get(slug)
    expect(stored.length).toBeGreaterThanOrEqual(4)
    stored.forEach((ev, i) => { expect(ev.seq).toBe(i) })
  })

  it("persists transcript events as NDJSON alongside the slug file", async () => {
    const { engine } = createEngine()
    const session = makeSession({ slug: "loud-heron" })

    const e = engine as unknown as {
      pushToConversation(s: TopicSession, m: TopicMessage): void
    }
    e.pushToConversation(session, { role: "user", text: "persist me" })

    await engine.transcriptStore.flush("loud-heron")
    const filePath = path.join(workspaceRoot, ".transcripts", "loud-heron.ndjson")
    const raw = await fs.readFile(filePath, "utf-8")
    const lines = raw.split("\n").filter(Boolean)
    expect(lines.length).toBe(2)
    const parsed = lines.map((l) => JSON.parse(l))
    expect(parsed[0].type).toBe("turn_started")
    expect(parsed[1].type).toBe("user_message")
    expect(parsed[1].text).toBe("persist me")
  })

  it("clears the transcript builder when a session is deleted", async () => {
    const { engine } = createEngine()
    const session = makeSession({ slug: "calm-fox" })

    const e = engine as unknown as {
      pushToConversation(s: TopicSession, m: TopicMessage): void
      broadcastSessionDeleted(slug: string): void
      transcriptBuilders: Map<string, unknown>
    }
    e.pushToConversation(session, { role: "user", text: "hi" })
    expect(e.transcriptBuilders.has("calm-fox")).toBe(true)

    e.broadcastSessionDeleted("calm-fox")
    expect(e.transcriptBuilders.has("calm-fox")).toBe(false)
  })

  it("consumes Goose stream events through the transcript builder and persists them", async () => {
    const { engine } = createEngine()
    const slug = "gentle-lark"

    const emitted: EngineEvent[] = []
    engine.events.onAny((e) => { emitted.push(e) })

    const e = engine as unknown as {
      getOrCreateTranscriptBuilder(id: string): { handleEvent(ev: GooseStreamEvent): TranscriptEvent[] }
      emitTranscriptEvents(id: string, events: TranscriptEvent[]): void
    }
    const builder = e.getOrCreateTranscriptBuilder(slug)
    const toolReqEvents = builder.handleEvent({
      type: "message",
      message: {
        role: "assistant",
        created: 0,
        content: [
          {
            type: "toolRequest",
            id: "tc_1",
            toolCall: { name: "Read", arguments: { file_path: "/tmp/a.txt" } },
          },
        ],
      },
    })
    e.emitTranscriptEvents(slug, toolReqEvents)

    const toolResEvents = builder.handleEvent({
      type: "message",
      message: {
        role: "user",
        created: 0,
        content: [{ type: "toolResponse", id: "tc_1", toolResult: "hello world" }],
      },
    })
    e.emitTranscriptEvents(slug, toolResEvents)

    await new Promise((r) => setTimeout(r, 10))

    const envelopes = emitted.filter((ev) => ev.type === "transcript_event")
    const typedTypes = envelopes.map((ev) => {
      if (ev.type !== "transcript_event") throw new Error("unreachable")
      return ev.event.type
    })
    expect(typedTypes).toContain("tool_call")
    expect(typedTypes).toContain("tool_result")
  })
})
