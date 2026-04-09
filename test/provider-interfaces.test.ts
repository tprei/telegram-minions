/**
 * Tests for provider interfaces and types.
 *
 * These tests verify that the provider interface contracts are well-defined
 * and that mock implementations can satisfy them. This ensures the interfaces
 * are implementable and type-safe before platform adapters are built.
 */

import { describe, it, expect, vi } from "vitest"
import type {
  ChatProvider,
  ThreadManager,
  ChatInputSource,
  InteractiveUI,
  FileHandler,
  MessageFormatter,
  ContentBlock,
  ChatPlatform,
  ThreadId,
  MessageId,
  SendResult,
  ThreadInfo,
  KeyboardButton,
  ChatUser,
  ChatPhoto,
  IncomingMessage,
  CallbackQuery,
  ChatUpdate,
} from "../src/provider/index.js"

// ── Mock implementations ──────────────────────────────────────────────

function makeMockChatProvider(overrides: Partial<ChatProvider> = {}): ChatProvider {
  return {
    sendMessage: vi.fn(async () => ({ ok: true, messageId: "msg-1" })),
    editMessage: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => {}),
    pinMessage: vi.fn(async () => {}),
    ...overrides,
  }
}

function makeMockThreadManager(overrides: Partial<ThreadManager> = {}): ThreadManager {
  return {
    createThread: vi.fn(async () => ({ threadId: "thread-1", name: "test" })),
    editThread: vi.fn(async () => {}),
    closeThread: vi.fn(async () => {}),
    deleteThread: vi.fn(async () => {}),
    ...overrides,
  }
}

function makeMockInputSource(overrides: Partial<ChatInputSource> = {}): ChatInputSource {
  return {
    poll: vi.fn(async () => []),
    getCursor: vi.fn(() => "0"),
    advanceCursor: vi.fn(),
    ...overrides,
  }
}

function makeMockInteractiveUI(overrides: Partial<InteractiveUI> = {}): InteractiveUI {
  return {
    sendMessageWithKeyboard: vi.fn(async () => "msg-kb-1"),
    answerCallbackQuery: vi.fn(async () => {}),
    ...overrides,
  }
}

function makeMockFileHandler(overrides: Partial<FileHandler> = {}): FileHandler {
  return {
    sendPhoto: vi.fn(async () => "msg-photo-1"),
    sendPhotoBuffer: vi.fn(async () => "msg-photo-2"),
    downloadFile: vi.fn(async () => true),
    ...overrides,
  }
}

function makeMockFormatter(overrides: Partial<MessageFormatter> = {}): MessageFormatter {
  return {
    format: vi.fn((blocks: ContentBlock[]) =>
      blocks.map((b) => (b.type === "raw" ? b.markup : b.type === "text" ? b.text : "")).join(""),
    ),
    escapeText: vi.fn((s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")),
    maxMessageLength: 4096,
    ...overrides,
  }
}

function makeMockChatPlatform(overrides: Partial<ChatPlatform> = {}): ChatPlatform {
  return {
    name: "test",
    chat: makeMockChatProvider(),
    threads: makeMockThreadManager(),
    input: makeMockInputSource(),
    ui: makeMockInteractiveUI(),
    files: makeMockFileHandler(),
    formatter: makeMockFormatter(),
    chatId: "test-chat-123",
    threadLink: vi.fn(() => undefined),
    ...overrides,
  }
}

// ── Type-level tests ──────────────────────────────────────────────────

describe("Provider types", () => {
  it("ThreadId and MessageId are string aliases", () => {
    const threadId: ThreadId = "t-123"
    const messageId: MessageId = "m-456"
    expect(typeof threadId).toBe("string")
    expect(typeof messageId).toBe("string")
  })

  it("SendResult has ok and nullable messageId", () => {
    const success: SendResult = { ok: true, messageId: "m-1" }
    const failure: SendResult = { ok: false, messageId: null }
    expect(success.ok).toBe(true)
    expect(success.messageId).toBe("m-1")
    expect(failure.ok).toBe(false)
    expect(failure.messageId).toBeNull()
  })

  it("ThreadInfo carries threadId and name", () => {
    const info: ThreadInfo = { threadId: "t-1", name: "my-topic" }
    expect(info.threadId).toBe("t-1")
    expect(info.name).toBe("my-topic")
  })

  it("KeyboardButton has text and callbackData", () => {
    const btn: KeyboardButton = { text: "Yes", callbackData: "confirm" }
    expect(btn.text).toBe("Yes")
    expect(btn.callbackData).toBe("confirm")
  })

  it("ChatUser has required and optional fields", () => {
    const minimal: ChatUser = { id: "u-1", isBot: false }
    const full: ChatUser = { id: "u-2", isBot: true, username: "bot", displayName: "Bot User" }
    expect(minimal.username).toBeUndefined()
    expect(full.username).toBe("bot")
  })

  it("IncomingMessage carries message data", () => {
    const msg: IncomingMessage = {
      messageId: "m-1",
      threadId: "t-1",
      from: { id: "u-1", isBot: false },
      text: "hello",
      timestamp: Date.now(),
    }
    expect(msg.text).toBe("hello")
    expect(msg.photos).toBeUndefined()
  })

  it("IncomingMessage supports photo attachments", () => {
    const photo: ChatPhoto = { fileId: "f-1", width: 800, height: 600 }
    const msg: IncomingMessage = {
      messageId: "m-2",
      timestamp: Date.now(),
      photos: [photo],
    }
    expect(msg.photos).toHaveLength(1)
    expect(msg.photos![0].fileId).toBe("f-1")
  })

  it("CallbackQuery carries button press data", () => {
    const query: CallbackQuery = {
      queryId: "q-1",
      from: { id: "u-1", isBot: false },
      messageId: "m-1",
      threadId: "t-1",
      data: "repo:my-repo",
    }
    expect(query.data).toBe("repo:my-repo")
  })

  it("ChatUpdate discriminates message vs callback", () => {
    const msgUpdate: ChatUpdate = {
      type: "message",
      message: { messageId: "m-1", timestamp: Date.now(), text: "/task do something" },
    }
    const cbUpdate: ChatUpdate = {
      type: "callback_query",
      query: { queryId: "q-1", from: { id: "u-1", isBot: false }, data: "yes" },
    }

    expect(msgUpdate.type).toBe("message")
    expect(cbUpdate.type).toBe("callback_query")

    if (msgUpdate.type === "message") {
      expect(msgUpdate.message.text).toBe("/task do something")
    }
    if (cbUpdate.type === "callback_query") {
      expect(cbUpdate.query.data).toBe("yes")
    }
  })
})

// ── Interface contract tests ──────────────────────────────────────────

describe("ChatProvider", () => {
  it("sendMessage returns SendResult", async () => {
    const provider = makeMockChatProvider()
    const result = await provider.sendMessage("hello", "t-1")
    expect(result.ok).toBe(true)
    expect(result.messageId).toBe("msg-1")
    expect(provider.sendMessage).toHaveBeenCalledWith("hello", "t-1")
  })

  it("sendMessage works without optional threadId", async () => {
    const provider = makeMockChatProvider()
    await provider.sendMessage("global message")
    expect(provider.sendMessage).toHaveBeenCalledWith("global message")
  })

  it("sendMessage accepts replyToMessageId", async () => {
    const provider = makeMockChatProvider()
    await provider.sendMessage("reply", "t-1", "m-parent")
    expect(provider.sendMessage).toHaveBeenCalledWith("reply", "t-1", "m-parent")
  })

  it("editMessage returns boolean success", async () => {
    const provider = makeMockChatProvider()
    const ok = await provider.editMessage("m-1", "updated", "t-1")
    expect(ok).toBe(true)
  })

  it("deleteMessage is fire-and-forget", async () => {
    const provider = makeMockChatProvider()
    await provider.deleteMessage("m-1")
    expect(provider.deleteMessage).toHaveBeenCalledWith("m-1")
  })

  it("pinMessage is fire-and-forget", async () => {
    const provider = makeMockChatProvider()
    await provider.pinMessage("m-1")
    expect(provider.pinMessage).toHaveBeenCalledWith("m-1")
  })
})

describe("ThreadManager", () => {
  it("createThread returns ThreadInfo", async () => {
    const manager = makeMockThreadManager()
    const info = await manager.createThread("new-task")
    expect(info.threadId).toBe("thread-1")
    expect(info.name).toBe("test")
  })

  it("editThread renames a thread", async () => {
    const manager = makeMockThreadManager()
    await manager.editThread("t-1", "renamed")
    expect(manager.editThread).toHaveBeenCalledWith("t-1", "renamed")
  })

  it("closeThread and deleteThread are fire-and-forget", async () => {
    const manager = makeMockThreadManager()
    await manager.closeThread("t-1")
    await manager.deleteThread("t-1")
    expect(manager.closeThread).toHaveBeenCalled()
    expect(manager.deleteThread).toHaveBeenCalled()
  })
})

describe("ChatInputSource", () => {
  it("poll returns ChatUpdate array", async () => {
    const source = makeMockInputSource({
      poll: vi.fn(async () => [
        { type: "message" as const, message: { messageId: "m-1", timestamp: 1000, text: "hi" } },
      ]),
    })
    const updates = await source.poll("0", 30)
    expect(updates).toHaveLength(1)
    expect(updates[0].type).toBe("message")
  })

  it("getCursor returns current cursor", () => {
    const source = makeMockInputSource()
    expect(source.getCursor()).toBe("0")
  })

  it("advanceCursor updates internal state", () => {
    const source = makeMockInputSource()
    const updates: ChatUpdate[] = [
      { type: "message", message: { messageId: "m-1", timestamp: 1000 } },
    ]
    source.advanceCursor(updates)
    expect(source.advanceCursor).toHaveBeenCalledWith(updates)
  })
})

describe("InteractiveUI", () => {
  it("sendMessageWithKeyboard returns message ID", async () => {
    const ui = makeMockInteractiveUI()
    const keyboard: KeyboardButton[][] = [[{ text: "Yes", callbackData: "y" }, { text: "No", callbackData: "n" }]]
    const msgId = await ui.sendMessageWithKeyboard("Choose:", keyboard, "t-1")
    expect(msgId).toBe("msg-kb-1")
  })

  it("answerCallbackQuery sends acknowledgement", async () => {
    const ui = makeMockInteractiveUI()
    await ui.answerCallbackQuery("q-1", "Selected!")
    expect(ui.answerCallbackQuery).toHaveBeenCalledWith("q-1", "Selected!")
  })

  it("answerCallbackQuery works without text", async () => {
    const ui = makeMockInteractiveUI()
    await ui.answerCallbackQuery("q-1")
    expect(ui.answerCallbackQuery).toHaveBeenCalledWith("q-1")
  })
})

describe("FileHandler", () => {
  it("sendPhoto returns message ID", async () => {
    const handler = makeMockFileHandler()
    const msgId = await handler.sendPhoto("/tmp/screenshot.png", "t-1", "Screenshot")
    expect(msgId).toBe("msg-photo-1")
  })

  it("sendPhotoBuffer returns message ID", async () => {
    const handler = makeMockFileHandler()
    const buf = Buffer.from("fake-png-data")
    const msgId = await handler.sendPhotoBuffer(buf, "image.png", "t-1")
    expect(msgId).toBe("msg-photo-2")
  })

  it("downloadFile returns boolean success", async () => {
    const handler = makeMockFileHandler()
    const ok = await handler.downloadFile("file-abc", "/tmp/download.jpg")
    expect(ok).toBe(true)
  })
})

describe("MessageFormatter", () => {
  it("format converts content blocks to markup", () => {
    const formatter = makeMockFormatter()
    const blocks: ContentBlock[] = [
      { type: "text", text: "Hello " },
      { type: "bold", text: "world" },
    ]
    const result = formatter.format(blocks)
    expect(typeof result).toBe("string")
  })

  it("escapeText sanitizes special characters", () => {
    const formatter = makeMockFormatter()
    expect(formatter.escapeText("<script>")).toBe("&lt;script&gt;")
    expect(formatter.escapeText("a & b")).toBe("a &amp; b")
  })

  it("maxMessageLength is exposed as a number", () => {
    const formatter = makeMockFormatter()
    expect(formatter.maxMessageLength).toBe(4096)
  })

  it("raw blocks pass through as-is", () => {
    const formatter = makeMockFormatter()
    const blocks: ContentBlock[] = [{ type: "raw", markup: "<b>pre-formatted</b>" }]
    const result = formatter.format(blocks)
    expect(result).toBe("<b>pre-formatted</b>")
  })
})

// ── ChatPlatform bundle tests ─────────────────────────────────────────

describe("ChatPlatform", () => {
  it("exposes all required capabilities", () => {
    const platform = makeMockChatPlatform()
    expect(platform.name).toBe("test")
    expect(platform.chat).toBeDefined()
    expect(platform.threads).toBeDefined()
    expect(platform.input).toBeDefined()
    expect(platform.chatId).toBe("test-chat-123")
  })

  it("optional capabilities can be null", () => {
    const platform = makeMockChatPlatform({
      ui: null,
      files: null,
      formatter: null,
    })
    expect(platform.ui).toBeNull()
    expect(platform.files).toBeNull()
    expect(platform.formatter).toBeNull()
  })

  it("threadLink returns undefined for unsupported platforms", () => {
    const platform = makeMockChatPlatform()
    expect(platform.threadLink("t-1")).toBeUndefined()
  })

  it("threadLink returns a URL for supported platforms", () => {
    const platform = makeMockChatPlatform({
      threadLink: vi.fn((threadId: string) => `https://example.com/thread/${threadId}`),
    })
    expect(platform.threadLink("t-42")).toBe("https://example.com/thread/t-42")
  })

  it("composes capabilities for full workflow", async () => {
    const platform = makeMockChatPlatform()

    // Create a thread
    const thread = await platform.threads.createThread("task-brave-fox")
    expect(thread.threadId).toBe("thread-1")

    // Send a message
    const result = await platform.chat.sendMessage("Starting task...", thread.threadId)
    expect(result.ok).toBe(true)

    // Send a keyboard
    if (platform.ui) {
      const kbMsgId = await platform.ui.sendMessageWithKeyboard(
        "Select repo:",
        [[{ text: "repo-a", callbackData: "repo:a" }]],
        thread.threadId,
      )
      expect(kbMsgId).toBeTruthy()
    }

    // Edit a message
    await platform.chat.editMessage(result.messageId!, "Updated status", thread.threadId)

    // Send a screenshot
    if (platform.files) {
      await platform.files.sendPhoto("/tmp/screenshot.png", thread.threadId, "Result")
    }

    // Close the thread
    await platform.threads.closeThread(thread.threadId)
  })

  it("works with minimal platform (no optional capabilities)", async () => {
    const platform = makeMockChatPlatform({
      ui: null,
      files: null,
      formatter: null,
    })

    const thread = await platform.threads.createThread("minimal-task")
    const result = await platform.chat.sendMessage("hello", thread.threadId)
    expect(result.ok).toBe(true)

    // Optional capabilities are safely skipped
    expect(platform.ui).toBeNull()
    expect(platform.files).toBeNull()
    expect(platform.formatter).toBeNull()
  })
})
