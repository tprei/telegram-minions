import { describe, it, expect, vi } from "vitest"
import { makeMockTelegram } from "./test-helpers.js"
import {
  TelegramPlatform,
  TelegramChatProvider,
  TelegramThreadManager,
  TelegramInputSource,
  TelegramInteractiveUI,
  TelegramFileHandler,
  TelegramFormatter,
  createTelegramPlatform,
} from "../src/telegram/platform.js"
import type { TelegramClient } from "../src/telegram/telegram.js"
import type { ChatPlatform } from "../src/provider/chat-platform.js"
import type { ContentBlock } from "../src/provider/message-formatter.js"

function client(overrides: Partial<TelegramClient> = {}): TelegramClient {
  return makeMockTelegram(overrides)
}

// ── TelegramChatProvider ─────────────────────────────────────────────

describe("TelegramChatProvider", () => {
  it("sendMessage converts string IDs to numbers and returns string result", async () => {
    const tg = client()
    const provider = new TelegramChatProvider(tg)

    const result = await provider.sendMessage("<b>hi</b>", "42", "10")

    expect(tg.sendMessage).toHaveBeenCalledWith("<b>hi</b>", 42, 10)
    expect(result).toEqual({ ok: true, messageId: "1" })
  })

  it("sendMessage works without optional params", async () => {
    const tg = client()
    const provider = new TelegramChatProvider(tg)

    await provider.sendMessage("hello")

    expect(tg.sendMessage).toHaveBeenCalledWith("hello", undefined, undefined)
  })

  it("sendMessage returns null messageId on failure", async () => {
    const tg = client({
      sendMessage: vi.fn(async () => ({ ok: false, messageId: null })),
    })
    const provider = new TelegramChatProvider(tg)

    const result = await provider.sendMessage("fail")
    expect(result).toEqual({ ok: false, messageId: null })
  })

  it("editMessage converts IDs and returns boolean", async () => {
    const tg = client()
    const provider = new TelegramChatProvider(tg)

    const ok = await provider.editMessage("99", "updated", "42")

    expect(tg.editMessage).toHaveBeenCalledWith(99, "updated", 42)
    expect(ok).toBe(true)
  })

  it("deleteMessage converts ID", async () => {
    const tg = client()
    const provider = new TelegramChatProvider(tg)

    await provider.deleteMessage("55")

    expect(tg.deleteMessage).toHaveBeenCalledWith(55)
  })

  it("pinMessage delegates to pinChatMessage", async () => {
    const tg = client()
    const provider = new TelegramChatProvider(tg)

    await provider.pinMessage("77")

    expect(tg.pinChatMessage).toHaveBeenCalledWith(77)
  })
})

// ── TelegramThreadManager ────────────────────────────────────────────

describe("TelegramThreadManager", () => {
  it("createThread returns string threadId", async () => {
    const tg = client()
    const manager = new TelegramThreadManager(tg)

    const info = await manager.createThread("test-task")

    expect(tg.createForumTopic).toHaveBeenCalledWith("test-task")
    expect(info).toEqual({ threadId: "100", name: "test" })
  })

  it("editThread converts threadId to number", async () => {
    const tg = client()
    const manager = new TelegramThreadManager(tg)

    await manager.editThread("200", "renamed")

    expect(tg.editForumTopic).toHaveBeenCalledWith(200, "renamed")
  })

  it("closeThread converts threadId", async () => {
    const tg = client()
    const manager = new TelegramThreadManager(tg)

    await manager.closeThread("300")

    expect(tg.closeForumTopic).toHaveBeenCalledWith(300)
  })

  it("deleteThread converts threadId", async () => {
    const tg = client()
    const manager = new TelegramThreadManager(tg)

    await manager.deleteThread("400")

    expect(tg.deleteForumTopic).toHaveBeenCalledWith(400)
  })
})

// ── TelegramInputSource ──────────────────────────────────────────────

describe("TelegramInputSource", () => {
  it("poll converts TelegramUpdates to ChatUpdates", async () => {
    const tg = client({
      getUpdates: vi.fn(async () => [
        {
          update_id: 101,
          message: {
            message_id: 5,
            from: { id: 123, is_bot: false, username: "alice", first_name: "Alice" },
            chat: { id: -100999, type: "supergroup" },
            date: 1700000000,
            text: "/task do something",
            message_thread_id: 42,
          },
        },
      ]),
    })
    const source = new TelegramInputSource(tg)

    const updates = await source.poll("0", 30)

    expect(tg.getUpdates).toHaveBeenCalledWith(0, 30)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toEqual({
      type: "message",
      message: {
        messageId: "5",
        threadId: "42",
        from: { id: "123", isBot: false, username: "alice", displayName: "Alice" },
        text: "/task do something",
        caption: undefined,
        photos: undefined,
        timestamp: 1700000000,
      },
    })
  })

  it("poll converts callback_query updates", async () => {
    const tg = client({
      getUpdates: vi.fn(async () => [
        {
          update_id: 102,
          callback_query: {
            id: "cb-1",
            from: { id: 456, is_bot: false, username: "bob", first_name: "Bob" },
            message: {
              message_id: 10,
              chat: { id: -100999, type: "supergroup" },
              date: 1700000000,
              message_thread_id: 50,
            },
            data: "repo:my-repo",
          },
        },
      ]),
    })
    const source = new TelegramInputSource(tg)

    const updates = await source.poll("5", 10)

    expect(updates).toHaveLength(1)
    expect(updates[0]).toEqual({
      type: "callback_query",
      query: {
        queryId: "cb-1",
        from: { id: "456", isBot: false, username: "bob", displayName: "Bob" },
        messageId: "10",
        threadId: "50",
        data: "repo:my-repo",
      },
    })
  })

  it("poll skips updates with neither message nor callback_query", async () => {
    const tg = client({
      getUpdates: vi.fn(async () => [{ update_id: 103 }]),
    })
    const source = new TelegramInputSource(tg)

    const updates = await source.poll("0", 5)
    expect(updates).toHaveLength(0)
  })

  it("getCursor returns current offset as string", () => {
    const source = new TelegramInputSource(client())
    expect(source.getCursor()).toBe("0")
  })

  it("advanceCursor increments offset by batch size", async () => {
    const tg = client({ getUpdates: vi.fn(async () => []) })
    const source = new TelegramInputSource(tg)

    await source.poll("10", 1)
    expect(source.getCursor()).toBe("10")

    source.advanceCursor([
      { type: "message", message: { messageId: "1", timestamp: 0 } },
      { type: "message", message: { messageId: "2", timestamp: 0 } },
    ])
    expect(source.getCursor()).toBe("12")
  })

  it("poll converts photo attachments", async () => {
    const tg = client({
      getUpdates: vi.fn(async () => [
        {
          update_id: 104,
          message: {
            message_id: 7,
            chat: { id: -100999, type: "supergroup" },
            date: 1700000000,
            caption: "screenshot",
            photo: [
              { file_id: "f-small", file_unique_id: "u1", width: 100, height: 100 },
              { file_id: "f-large", file_unique_id: "u2", width: 800, height: 600, file_size: 50000 },
            ],
          },
        },
      ]),
    })
    const source = new TelegramInputSource(tg)

    const updates = await source.poll("0", 5)
    expect(updates[0].type).toBe("message")
    if (updates[0].type === "message") {
      expect(updates[0].message.caption).toBe("screenshot")
      expect(updates[0].message.photos).toHaveLength(2)
      expect(updates[0].message.photos![1]).toEqual({
        fileId: "f-large",
        width: 800,
        height: 600,
        fileSize: 50000,
      })
    }
  })
})

// ── TelegramInteractiveUI ────────────────────────────────────────────

describe("TelegramInteractiveUI", () => {
  it("sendMessageWithKeyboard converts keyboard format and IDs", async () => {
    const tg = client()
    const ui = new TelegramInteractiveUI(tg)

    const msgId = await ui.sendMessageWithKeyboard(
      "Pick one:",
      [[{ text: "A", callbackData: "a" }, { text: "B", callbackData: "b" }]],
      "42",
    )

    expect(tg.sendMessageWithKeyboard).toHaveBeenCalledWith(
      "Pick one:",
      [[{ text: "A", callback_data: "a" }, { text: "B", callback_data: "b" }]],
      42,
    )
    expect(msgId).toBe("1")
  })

  it("sendMessageWithKeyboard returns null on failure", async () => {
    const tg = client({
      sendMessageWithKeyboard: vi.fn(async () => null),
    })
    const ui = new TelegramInteractiveUI(tg)

    const msgId = await ui.sendMessageWithKeyboard("fail", [[]], "1")
    expect(msgId).toBeNull()
  })

  it("answerCallbackQuery delegates with text", async () => {
    const tg = client()
    const ui = new TelegramInteractiveUI(tg)

    await ui.answerCallbackQuery("q-1", "Done!")

    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("q-1", "Done!")
  })

  it("answerCallbackQuery works without text", async () => {
    const tg = client()
    const ui = new TelegramInteractiveUI(tg)

    await ui.answerCallbackQuery("q-2")

    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("q-2", undefined)
  })
})

// ── TelegramFileHandler ──────────────────────────────────────────────

describe("TelegramFileHandler", () => {
  it("sendPhoto converts threadId and returns string messageId", async () => {
    const tg = client()
    const handler = new TelegramFileHandler(tg)

    const msgId = await handler.sendPhoto("/tmp/shot.png", "42", "Screenshot")

    expect(tg.sendPhoto).toHaveBeenCalledWith("/tmp/shot.png", 42, "Screenshot")
    expect(msgId).toBe("1")
  })

  it("sendPhotoBuffer converts threadId and returns string messageId", async () => {
    const tg = client()
    const handler = new TelegramFileHandler(tg)
    const buf = Buffer.from("fake-png")

    const msgId = await handler.sendPhotoBuffer(buf, "image.png", "42", "Caption")

    expect(tg.sendPhotoBuffer).toHaveBeenCalledWith(buf, "image.png", 42, "Caption")
    expect(msgId).toBe("1")
  })

  it("downloadFile delegates directly", async () => {
    const tg = client()
    const handler = new TelegramFileHandler(tg)

    const ok = await handler.downloadFile("file-abc", "/tmp/out.jpg")

    expect(tg.downloadFile).toHaveBeenCalledWith("file-abc", "/tmp/out.jpg")
    expect(ok).toBe(true)
  })
})

// ── TelegramFormatter ────────────────────────────────────────────────

describe("TelegramFormatter", () => {
  it("maxMessageLength is 4096", () => {
    const fmt = new TelegramFormatter()
    expect(fmt.maxMessageLength).toBe(4096)
  })

  it("escapeText escapes HTML entities", () => {
    const fmt = new TelegramFormatter()
    expect(fmt.escapeText("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert('xss')&lt;/script&gt;",
    )
    expect(fmt.escapeText("a & b")).toBe("a &amp; b")
  })

  it("format handles text blocks with escaping", () => {
    const fmt = new TelegramFormatter()
    const blocks: ContentBlock[] = [{ type: "text", text: "Hello <world>" }]
    expect(fmt.format(blocks)).toBe("Hello &lt;world&gt;")
  })

  it("format handles inline code blocks", () => {
    const fmt = new TelegramFormatter()
    const blocks: ContentBlock[] = [{ type: "code", code: "x < 5" }]
    expect(fmt.format(blocks)).toBe("<code>x &lt; 5</code>")
  })

  it("format handles code blocks with language", () => {
    const fmt = new TelegramFormatter()
    const blocks: ContentBlock[] = [{ type: "code", language: "ts", code: "const x = 1" }]
    expect(fmt.format(blocks)).toBe('<pre><code class="language-ts">const x = 1</code></pre>')
  })

  it("format handles bold blocks", () => {
    const fmt = new TelegramFormatter()
    const blocks: ContentBlock[] = [{ type: "bold", text: "important" }]
    expect(fmt.format(blocks)).toBe("<b>important</b>")
  })

  it("format handles italic blocks", () => {
    const fmt = new TelegramFormatter()
    const blocks: ContentBlock[] = [{ type: "italic", text: "emphasis" }]
    expect(fmt.format(blocks)).toBe("<i>emphasis</i>")
  })

  it("format handles link blocks with label", () => {
    const fmt = new TelegramFormatter()
    const blocks: ContentBlock[] = [{ type: "link", url: "https://example.com", label: "Example" }]
    expect(fmt.format(blocks)).toBe('<a href="https://example.com">Example</a>')
  })

  it("format handles link blocks without label", () => {
    const fmt = new TelegramFormatter()
    const blocks: ContentBlock[] = [{ type: "link", url: "https://example.com" }]
    expect(fmt.format(blocks)).toBe("https://example.com")
  })

  it("format handles raw blocks as passthrough", () => {
    const fmt = new TelegramFormatter()
    const blocks: ContentBlock[] = [{ type: "raw", markup: "<b>already formatted</b>" }]
    expect(fmt.format(blocks)).toBe("<b>already formatted</b>")
  })

  it("format concatenates multiple blocks", () => {
    const fmt = new TelegramFormatter()
    const blocks: ContentBlock[] = [
      { type: "text", text: "Hello " },
      { type: "bold", text: "world" },
      { type: "text", text: "!" },
    ]
    expect(fmt.format(blocks)).toBe("Hello <b>world</b>!")
  })

  it("format escapes HTML in language attribute", () => {
    const fmt = new TelegramFormatter()
    const blocks: ContentBlock[] = [{ type: "code", language: "a<b>", code: "x" }]
    expect(fmt.format(blocks)).toBe('<pre><code class="language-a&lt;b&gt;">x</code></pre>')
  })
})

// ── TelegramPlatform (bundle) ────────────────────────────────────────

describe("TelegramPlatform", () => {
  it("exposes all capabilities", () => {
    const tg = client()
    const platform = new TelegramPlatform(tg, "-1001234567890")

    expect(platform.name).toBe("telegram")
    expect(platform.chatId).toBe("-1001234567890")
    expect(platform.chat).toBeInstanceOf(TelegramChatProvider)
    expect(platform.threads).toBeInstanceOf(TelegramThreadManager)
    expect(platform.input).toBeInstanceOf(TelegramInputSource)
    expect(platform.ui).toBeInstanceOf(TelegramInteractiveUI)
    expect(platform.files).toBeInstanceOf(TelegramFileHandler)
    expect(platform.formatter).toBeInstanceOf(TelegramFormatter)
  })

  it("satisfies ChatPlatform interface", () => {
    const tg = client()
    const platform: ChatPlatform = new TelegramPlatform(tg, "-1001234567890")

    expect(platform.chat).toBeDefined()
    expect(platform.threads).toBeDefined()
    expect(platform.input).toBeDefined()
    expect(platform.ui).not.toBeNull()
    expect(platform.files).not.toBeNull()
    expect(platform.formatter).not.toBeNull()
  })

  it("threadLink generates Telegram deep link", () => {
    const tg = client()
    const platform = new TelegramPlatform(tg, "-1001234567890")

    expect(platform.threadLink("42")).toBe("https://t.me/c/1234567890/42")
  })

  it("threadLink strips -100 prefix from chatId", () => {
    const tg = client()
    const platform = new TelegramPlatform(tg, "-1009876543210")

    expect(platform.threadLink("99")).toBe("https://t.me/c/9876543210/99")
  })

  it("threadLink returns undefined for empty threadId", () => {
    const tg = client()
    const platform = new TelegramPlatform(tg, "-1001234567890")

    expect(platform.threadLink("")).toBeUndefined()
  })

  it("threadLink returns undefined for empty chatId", () => {
    const tg = client()
    const platform = new TelegramPlatform(tg, "")

    expect(platform.threadLink("42")).toBeUndefined()
  })
})

// ── createTelegramPlatform factory ───────────────────────────────────

describe("createTelegramPlatform", () => {
  it("returns a TelegramPlatform instance", () => {
    const tg = client()
    const platform = createTelegramPlatform(tg, "-1001234567890")

    expect(platform).toBeInstanceOf(TelegramPlatform)
    expect(platform.chatId).toBe("-1001234567890")
  })
})

// ── Integration: full workflow through platform ──────────────────────

describe("TelegramPlatform integration", () => {
  it("runs a complete task lifecycle through the adapter", async () => {
    const tg = client()
    const platform = createTelegramPlatform(tg, "-1001234567890")

    // Create thread
    const thread = await platform.threads.createThread("task-brave-fox")
    expect(thread.threadId).toBe("100")

    // Send initial message
    const result = await platform.chat.sendMessage("Starting task...", thread.threadId)
    expect(result.ok).toBe(true)
    expect(result.messageId).toBe("1")

    // Send keyboard
    const kbMsgId = await platform.ui.sendMessageWithKeyboard(
      "Select repo:",
      [[{ text: "repo-a", callbackData: "repo:a" }]],
      thread.threadId,
    )
    expect(kbMsgId).toBe("1")

    // Edit message
    const editOk = await platform.chat.editMessage(result.messageId!, "Task in progress...", thread.threadId)
    expect(editOk).toBe(true)

    // Pin message
    await platform.chat.pinMessage(result.messageId!)
    expect(tg.pinChatMessage).toHaveBeenCalledWith(1)

    // Send photo
    const photoMsgId = await platform.files.sendPhoto("/tmp/screenshot.png", thread.threadId, "Result")
    expect(photoMsgId).toBe("1")

    // Delete a message
    await platform.chat.deleteMessage(result.messageId!)
    expect(tg.deleteMessage).toHaveBeenCalledWith(1)

    // Close thread
    await platform.threads.closeThread(thread.threadId)
    expect(tg.closeForumTopic).toHaveBeenCalledWith(100)
  })
})
