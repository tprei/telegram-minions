import { describe, it, expect } from "vitest"
import type {
  TelegramUser,
  TelegramPhotoSize,
  TelegramMessage,
  TelegramCallbackQuery,
  TelegramUpdate,
  TelegramForumTopic,
} from "../src/domain/telegram-types.js"
import type {
  GooseContentType,
  GooseTextContent,
  GooseToolRequestContent,
  GooseToolResponseContent,
  GooseThinkingContent,
  GooseSystemNotificationContent,
  GooseNotificationContent,
  GooseMessage,
  GooseStreamEvent,
} from "../src/domain/goose-types.js"
import type {
  SessionDoneState,
  SessionState,
  SessionPort,
  SessionMode,
  SessionMeta,
  TopicMessage,
  TopicSession,
  PendingDagItem,
} from "../src/domain/session-types.js"
import type {
  ShipPhase,
  AutoAdvance,
  VerificationCheckKind,
  VerificationCheckStatus,
  VerificationCheck,
  VerificationRound,
  VerificationState,
} from "../src/domain/workflow-types.js"

// Also verify the barrel re-exports work
import type {
  TelegramUser as BarrelTelegramUser,
  GooseMessage as BarrelGooseMessage,
  SessionMeta as BarrelSessionMeta,
  AutoAdvance as BarrelAutoAdvance,
} from "../src/domain/index.js"

// And verify the backwards-compat shim re-exports work
import type {
  TelegramUser as ShimTelegramUser,
  GooseMessage as ShimGooseMessage,
  SessionMeta as ShimSessionMeta,
  AutoAdvance as ShimAutoAdvance,
} from "../src/types.js"

describe("domain/telegram-types", () => {
  it("TelegramUser has required fields", () => {
    const user: TelegramUser = { id: 123, is_bot: false, username: "alice" }
    expect(user.id).toBe(123)
    expect(user.is_bot).toBe(false)
  })

  it("TelegramPhotoSize has required fields", () => {
    const photo: TelegramPhotoSize = {
      file_id: "abc",
      file_unique_id: "def",
      width: 640,
      height: 480,
    }
    expect(photo.width).toBe(640)
  })

  it("TelegramMessage has required and optional fields", () => {
    const msg: TelegramMessage = {
      message_id: 1,
      chat: { id: 100, type: "supergroup" },
      date: 1700000000,
      text: "hello",
      message_thread_id: 42,
    }
    expect(msg.message_id).toBe(1)
    expect(msg.message_thread_id).toBe(42)
  })

  it("TelegramCallbackQuery references TelegramUser", () => {
    const cb: TelegramCallbackQuery = {
      id: "cb1",
      from: { id: 1, is_bot: false },
      data: "approve",
    }
    expect(cb.from.id).toBe(1)
  })

  it("TelegramUpdate wraps message and callback_query", () => {
    const update: TelegramUpdate = {
      update_id: 999,
      message: {
        message_id: 1,
        chat: { id: 100, type: "supergroup" },
        date: 1700000000,
      },
    }
    expect(update.update_id).toBe(999)
  })

  it("TelegramForumTopic has thread id and name", () => {
    const topic: TelegramForumTopic = {
      message_thread_id: 42,
      name: "test-topic",
      icon_color: 0x6fb9f0,
    }
    expect(topic.name).toBe("test-topic")
  })
})

describe("domain/goose-types", () => {
  it("GooseTextContent has text field", () => {
    const content: GooseTextContent = { type: "text", text: "hello" }
    expect(content.type).toBe("text")
  })

  it("GooseToolRequestContent has toolCall", () => {
    const content: GooseToolRequestContent = {
      type: "toolRequest",
      id: "req1",
      toolCall: { name: "read_file", arguments: { path: "/tmp/x" } },
    }
    expect(content.type).toBe("toolRequest")
  })

  it("GooseToolResponseContent has toolResult", () => {
    const content: GooseToolResponseContent = {
      type: "toolResponse",
      id: "req1",
      toolResult: { success: true },
    }
    expect(content.type).toBe("toolResponse")
  })

  it("GooseThinkingContent has thinking and signature", () => {
    const content: GooseThinkingContent = {
      type: "thinking",
      thinking: "Let me consider...",
      signature: "sig123",
    }
    expect(content.type).toBe("thinking")
  })

  it("GooseSystemNotificationContent has notificationType", () => {
    const content: GooseSystemNotificationContent = {
      type: "systemNotification",
      notificationType: "creditsExhausted",
      msg: "Out of credits",
    }
    expect(content.notificationType).toBe("creditsExhausted")
  })

  it("GooseNotificationContent has extensionId", () => {
    const content: GooseNotificationContent = {
      type: "notification",
      extensionId: "ext1",
      message: "Loading...",
      progress: 50,
      total: 100,
    }
    expect(content.extensionId).toBe("ext1")
  })

  it("GooseMessage wraps content array", () => {
    const msg: GooseMessage = {
      role: "assistant",
      created: 1700000000,
      content: [{ type: "text", text: "hello" }],
    }
    expect(msg.role).toBe("assistant")
    expect(msg.content).toHaveLength(1)
  })

  it("GooseContentType accepts all content subtypes", () => {
    const items: GooseContentType[] = [
      { type: "text", text: "hi" },
      { type: "toolRequest", id: "1", toolCall: { name: "x", arguments: {} } },
      { type: "toolResponse", id: "1", toolResult: null },
      { type: "thinking", thinking: "hmm", signature: "s" },
      { type: "systemNotification", notificationType: "inlineMessage", msg: "ok" },
      { type: "notification", extensionId: "e1" },
      { type: "custom", data: 42 },
    ]
    expect(items).toHaveLength(7)
  })

  it("GooseStreamEvent supports all event types", () => {
    const events: GooseStreamEvent[] = [
      { type: "message", message: { role: "assistant", created: 0, content: [] } },
      { type: "notification", extensionId: "e1" },
      { type: "error", error: "something broke" },
      { type: "complete", total_tokens: 500 },
      { type: "quota_exhausted", rawMessage: "quota exceeded" },
    ]
    expect(events).toHaveLength(5)
  })
})

describe("domain/session-types", () => {
  it("SessionDoneState covers terminal states", () => {
    const states: SessionDoneState[] = ["completed", "errored", "quota_exhausted"]
    expect(states).toHaveLength(3)
  })

  it("SessionState covers all lifecycle states", () => {
    const states: SessionState[] = ["spawning", "working", "idle", "completed", "errored"]
    expect(states).toHaveLength(5)
  })

  it("SessionMode covers all modes including ship modes", () => {
    const modes: SessionMode[] = [
      "task", "plan", "think", "review", "ci-fix",
      "dag-review", "ship-think", "ship-plan", "ship-verify",
    ]
    expect(modes).toHaveLength(9)
  })

  it("SessionMeta has required fields", () => {
    const meta: SessionMeta = {
      sessionId: "s1",
      threadId: 42,
      topicName: "test-topic",
      repo: "org/repo",
      cwd: "/tmp/work",
      startedAt: 1700000000,
      mode: "task",
    }
    expect(meta.sessionId).toBe("s1")
    expect(meta.mode).toBe("task")
  })

  it("TopicMessage has role and text", () => {
    const msg: TopicMessage = { role: "user", text: "hello", images: ["img1.png"] }
    expect(msg.role).toBe("user")
    expect(msg.images).toHaveLength(1)
  })

  it("TopicSession has required and optional fields", () => {
    const session: TopicSession = {
      threadId: 1,
      repo: "test-repo",
      cwd: "/tmp/test",
      slug: "bold-lion",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    expect(session.slug).toBe("bold-lion")
    expect(session.autoAdvance).toBeUndefined()
    expect(session.verificationState).toBeUndefined()
  })

  it("PendingDagItem has id, title, description, and dependsOn", () => {
    const item: PendingDagItem = {
      id: "item-1",
      title: "Auth module",
      description: "Implement auth",
      dependsOn: ["item-0"],
    }
    expect(item.dependsOn).toEqual(["item-0"])
  })
})

describe("domain/workflow-types", () => {
  it("ShipPhase covers all phases", () => {
    const phases: ShipPhase[] = ["think", "plan", "judge", "dag", "verify", "done"]
    expect(phases).toHaveLength(6)
  })

  it("AutoAdvance holds ship pipeline state", () => {
    const aa: AutoAdvance = {
      phase: "plan",
      featureDescription: "add auth",
      autoLand: true,
    }
    expect(aa.phase).toBe("plan")
  })

  it("VerificationCheck has kind, status, and nodeId", () => {
    const check: VerificationCheck = {
      kind: "ci",
      status: "running",
      nodeId: "node-1",
    }
    expect(check.kind).toBe("ci")
  })

  it("VerificationCheckKind covers all kinds", () => {
    const kinds: VerificationCheckKind[] = ["quality-gates", "ci", "completeness-review"]
    expect(kinds).toHaveLength(3)
  })

  it("VerificationCheckStatus covers all statuses", () => {
    const statuses: VerificationCheckStatus[] = ["pending", "running", "passed", "failed", "skipped"]
    expect(statuses).toHaveLength(5)
  })

  it("VerificationRound groups checks", () => {
    const round: VerificationRound = {
      round: 1,
      checks: [{ kind: "ci", status: "passed", nodeId: "a" }],
      startedAt: 1000,
      finishedAt: 2000,
    }
    expect(round.checks).toHaveLength(1)
  })

  it("VerificationState tracks multi-round verification", () => {
    const state: VerificationState = {
      dagId: "dag-1",
      maxRounds: 3,
      rounds: [],
      status: "running",
    }
    expect(state.dagId).toBe("dag-1")
  })
})

describe("barrel re-exports (domain/index)", () => {
  it("exports Telegram types via barrel", () => {
    const user: BarrelTelegramUser = { id: 1, is_bot: false }
    expect(user.id).toBe(1)
  })

  it("exports Goose types via barrel", () => {
    const msg: BarrelGooseMessage = { role: "assistant", created: 0, content: [] }
    expect(msg.role).toBe("assistant")
  })

  it("exports Session types via barrel", () => {
    const meta: BarrelSessionMeta = {
      sessionId: "s1",
      threadId: 1,
      topicName: "t",
      repo: "r",
      cwd: "/",
      startedAt: 0,
      mode: "task",
    }
    expect(meta.sessionId).toBe("s1")
  })

  it("exports Workflow types via barrel", () => {
    const aa: BarrelAutoAdvance = { phase: "think", featureDescription: "f", autoLand: false }
    expect(aa.phase).toBe("think")
  })
})

describe("backwards-compat shim (types.ts)", () => {
  it("re-exports Telegram types from shim", () => {
    const user: ShimTelegramUser = { id: 1, is_bot: false }
    expect(user.id).toBe(1)
  })

  it("re-exports Goose types from shim", () => {
    const msg: ShimGooseMessage = { role: "assistant", created: 0, content: [] }
    expect(msg.role).toBe("assistant")
  })

  it("re-exports Session types from shim", () => {
    const meta: ShimSessionMeta = {
      sessionId: "s1",
      threadId: 1,
      topicName: "t",
      repo: "r",
      cwd: "/",
      startedAt: 0,
      mode: "task",
    }
    expect(meta.sessionId).toBe("s1")
  })

  it("re-exports Workflow types from shim", () => {
    const aa: ShimAutoAdvance = { phase: "dag", featureDescription: "f", autoLand: true }
    expect(aa.phase).toBe("dag")
  })
})
