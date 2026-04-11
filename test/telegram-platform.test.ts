import { describe, it, expect, vi, beforeEach } from "vitest"
import { TelegramPlatform } from "../src/telegram/telegram-platform.js"
import type { TelegramClient } from "../src/telegram/telegram.js"
import type { ChatPlatform } from "../src/provider/chat-platform.js"
import type { KeyboardButton } from "../src/provider/types.js"

function makeMockClient(): TelegramClient {
  return {
    sendMessage: vi.fn(async () => ({ ok: true, messageId: 42 })),
    editMessage: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => {}),
    pinChatMessage: vi.fn(async () => {}),
    createForumTopic: vi.fn(async () => ({ message_thread_id: 100, name: "test-topic", icon_color: 0 })),
    editForumTopic: vi.fn(async () => {}),
    closeForumTopic: vi.fn(async () => {}),
    deleteForumTopic: vi.fn(async () => {}),
    getUpdates: vi.fn(async () => []),
    sendMessageWithKeyboard: vi.fn(async () => 99),
    answerCallbackQuery: vi.fn(async () => {}),
    sendPhoto: vi.fn(async () => 55),
    sendPhotoBuffer: vi.fn(async () => 56),
    downloadFile: vi.fn(async () => true),
  } as unknown as TelegramClient
}

describe("TelegramPlatform", () => {
  let client: ReturnType<typeof makeMockClient>
  let platform: TelegramPlatform

  beforeEach(() => {
    client = makeMockClient()
    platform = new TelegramPlatform(client as unknown as TelegramClient, "-1001234567890")
  })

  it("implements ChatPlatform interface", () => {
    const p: ChatPlatform = platform
    expect(p.name).toBe("telegram")
    expect(p.chatId).toBe("-1001234567890")
    expect(p.chat).toBeDefined()
    expect(p.threads).toBeDefined()
    expect(p.input).toBeDefined()
    expect(p.ui).not.toBeNull()
    expect(p.files).not.toBeNull()
    expect(p.formatter).not.toBeNull()
  })

  describe("threadLink", () => {
    it("generates a deep link to a telegram topic", () => {
      expect(platform.threadLink("999")).toBe("https://t.me/c/1234567890/999")
    })

    it("handles chatId without -100 prefix", () => {
      const p = new TelegramPlatform(client as unknown as TelegramClient, "5555")
      expect(p.threadLink("1")).toBe("https://t.me/c/5555/1")
    })
  })

  describe("chat (ChatProvider)", () => {
    it("sendMessage converts numeric IDs to strings", async () => {
      const result = await platform.chat.sendMessage("hello", "10", "5")
      expect(result).toEqual({ ok: true, messageId: "42" })
      expect((client.sendMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("hello", 10, 5)
    })

    it("sendMessage works without optional params", async () => {
      await platform.chat.sendMessage("hello")
      expect((client.sendMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("hello", undefined, undefined)
    })

    it("sendMessage returns null messageId on failure", async () => {
      ;(client.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, messageId: null })
      const result = await platform.chat.sendMessage("fail")
      expect(result).toEqual({ ok: false, messageId: null })
    })

    it("editMessage converts IDs", async () => {
      const ok = await platform.chat.editMessage("42", "updated", "10")
      expect(ok).toBe(true)
      expect((client.editMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(42, "updated", 10)
    })

    it("deleteMessage converts ID", async () => {
      await platform.chat.deleteMessage("42")
      expect((client.deleteMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(42)
    })

    it("pinMessage calls pinChatMessage", async () => {
      await platform.chat.pinMessage("42")
      expect((client.pinChatMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(42)
    })
  })

  describe("threads (ThreadManager)", () => {
    it("createThread returns ThreadInfo with string IDs", async () => {
      const info = await platform.threads.createThread("my-task")
      expect(info).toEqual({ threadId: "100", name: "test-topic" })
      expect((client.createForumTopic as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("my-task")
    })

    it("editThread converts threadId", async () => {
      await platform.threads.editThread("100", "renamed")
      expect((client.editForumTopic as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(100, "renamed")
    })

    it("closeThread converts threadId", async () => {
      await platform.threads.closeThread("100")
      expect((client.closeForumTopic as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(100)
    })

    it("deleteThread converts threadId", async () => {
      await platform.threads.deleteThread("100")
      expect((client.deleteForumTopic as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(100)
    })
  })

  describe("input (ChatInputSource)", () => {
    it("poll converts TelegramUpdates to ChatUpdates", async () => {
      ;(client.getUpdates as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          update_id: 1001,
          message: {
            message_id: 50,
            from: { id: 123, is_bot: false, username: "alice", first_name: "Alice" },
            chat: { id: -100999, type: "supergroup" },
            date: 1700000000,
            text: "/task do something",
            message_thread_id: 10,
          },
        },
      ])

      const updates = await platform.input.poll("0", 30)
      expect(updates).toHaveLength(1)
      expect(updates[0].type).toBe("message")
      if (updates[0].type === "message") {
        expect(updates[0].message.messageId).toBe("50")
        expect(updates[0].message.threadId).toBe("10")
        expect(updates[0].message.text).toBe("/task do something")
        expect(updates[0].message.from).toEqual({
          id: "123",
          isBot: false,
          username: "alice",
          displayName: "Alice",
        })
        expect(updates[0].message.timestamp).toBe(1700000000)
      }
    })

    it("poll converts callback queries", async () => {
      ;(client.getUpdates as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          update_id: 1002,
          callback_query: {
            id: "cb-999",
            from: { id: 456, is_bot: false, username: "bob", first_name: "Bob" },
            message: { message_id: 60, chat: { id: -100999, type: "supergroup" }, date: 1700000000, message_thread_id: 20 },
            data: "repo:my-repo",
          },
        },
      ])

      const updates = await platform.input.poll("0", 30)
      expect(updates).toHaveLength(1)
      expect(updates[0].type).toBe("callback_query")
      if (updates[0].type === "callback_query") {
        expect(updates[0].query.queryId).toBe("cb-999")
        expect(updates[0].query.from.id).toBe("456")
        expect(updates[0].query.messageId).toBe("60")
        expect(updates[0].query.threadId).toBe("20")
        expect(updates[0].query.data).toBe("repo:my-repo")
      }
    })

    it("poll skips updates with neither message nor callback_query", async () => {
      ;(client.getUpdates as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { update_id: 1003 },
      ])
      const updates = await platform.input.poll("0", 30)
      expect(updates).toHaveLength(0)
    })

    it("getCursor returns initial cursor", () => {
      expect(platform.input.getCursor()).toBe("0")
    })

    it("advanceCursor updates cursor from message updates", () => {
      platform.input.advanceCursor([
        { type: "message", message: { messageId: "50", timestamp: 1700000000 } },
        { type: "message", message: { messageId: "55", timestamp: 1700000001 } },
      ])
      expect(Number(platform.input.getCursor())).toBeGreaterThanOrEqual(56)
    })

    it("advanceCursor is a no-op for empty updates", () => {
      platform.input.advanceCursor([])
      expect(platform.input.getCursor()).toBe("0")
    })

    it("poll converts photos on messages", async () => {
      ;(client.getUpdates as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          update_id: 1004,
          message: {
            message_id: 70,
            chat: { id: -100999, type: "supergroup" },
            date: 1700000000,
            photo: [
              { file_id: "photo-small", file_unique_id: "u1", width: 100, height: 100 },
              { file_id: "photo-large", file_unique_id: "u2", width: 800, height: 600, file_size: 50000 },
            ],
            caption: "Look at this",
          },
        },
      ])

      const updates = await platform.input.poll("0", 30)
      expect(updates).toHaveLength(1)
      if (updates[0].type === "message") {
        expect(updates[0].message.photos).toHaveLength(2)
        expect(updates[0].message.photos![1]).toEqual({
          fileId: "photo-large",
          width: 800,
          height: 600,
          fileSize: 50000,
        })
        expect(updates[0].message.caption).toBe("Look at this")
      }
    })
  })

  describe("ui (InteractiveUI)", () => {
    it("sendMessageWithKeyboard converts KeyboardButton format", async () => {
      const keyboard: KeyboardButton[][] = [
        [{ text: "Yes", callbackData: "y" }, { text: "No", callbackData: "n" }],
      ]
      const msgId = await platform.ui!.sendMessageWithKeyboard("Choose:", keyboard, "10")
      expect(msgId).toBe("99")
      expect((client.sendMessageWithKeyboard as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        "Choose:",
        [[{ text: "Yes", callback_data: "y" }, { text: "No", callback_data: "n" }]],
        10,
      )
    })

    it("sendMessageWithKeyboard returns null on failure", async () => {
      ;(client.sendMessageWithKeyboard as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
      const msgId = await platform.ui!.sendMessageWithKeyboard("fail", [[]], "10")
      expect(msgId).toBeNull()
    })

    it("answerCallbackQuery delegates to client", async () => {
      await platform.ui!.answerCallbackQuery("cb-1", "Done!")
      expect((client.answerCallbackQuery as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("cb-1", "Done!")
    })
  })

  describe("files (FileHandler)", () => {
    it("sendPhoto converts threadId and returns string messageId", async () => {
      const msgId = await platform.files!.sendPhoto("/tmp/img.png", "10", "Screenshot")
      expect(msgId).toBe("55")
      expect((client.sendPhoto as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("/tmp/img.png", 10, "Screenshot")
    })

    it("sendPhotoBuffer converts IDs", async () => {
      const buf = Buffer.from("fake-png")
      const msgId = await platform.files!.sendPhotoBuffer(buf, "img.png", "10", "Caption")
      expect(msgId).toBe("56")
      expect((client.sendPhotoBuffer as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(buf, "img.png", 10, "Caption")
    })

    it("downloadFile delegates to client", async () => {
      const ok = await platform.files!.downloadFile("file-abc", "/tmp/out.jpg")
      expect(ok).toBe(true)
      expect((client.downloadFile as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("file-abc", "/tmp/out.jpg")
    })
  })

  describe("formatter (MessageFormatter)", () => {
    it("has maxMessageLength of 4096", () => {
      expect(platform.formatter!.maxMessageLength).toBe(4096)
    })

    it("escapeText escapes HTML entities", () => {
      expect(platform.formatter!.escapeText("<b>hi</b> & 'bye'")).toBe("&lt;b&gt;hi&lt;/b&gt; &amp; 'bye'")
    })

    it("format converts text blocks with escaping", () => {
      const result = platform.formatter!.format([{ type: "text", text: "hello <world>" }])
      expect(result).toBe("hello &lt;world&gt;")
    })

    it("format converts code blocks", () => {
      const inline = platform.formatter!.format([{ type: "code", code: "x = 1" }])
      expect(inline).toBe("<code>x = 1</code>")

      const block = platform.formatter!.format([{ type: "code", language: "python", code: "x = 1" }])
      expect(block).toBe('<pre><code class="language-python">x = 1</code></pre>')
    })

    it("format converts bold and italic", () => {
      expect(platform.formatter!.format([{ type: "bold", text: "strong" }])).toBe("<b>strong</b>")
      expect(platform.formatter!.format([{ type: "italic", text: "em" }])).toBe("<i>em</i>")
    })

    it("format converts links", () => {
      expect(platform.formatter!.format([{ type: "link", url: "https://example.com", label: "Click" }]))
        .toBe('<a href="https://example.com">Click</a>')
      expect(platform.formatter!.format([{ type: "link", url: "https://example.com" }]))
        .toBe('<a href="https://example.com">https://example.com</a>')
    })

    it("format passes raw blocks through", () => {
      expect(platform.formatter!.format([{ type: "raw", markup: "<b>raw</b>" }])).toBe("<b>raw</b>")
    })

    it("format concatenates multiple blocks", () => {
      const result = platform.formatter!.format([
        { type: "text", text: "Hello " },
        { type: "bold", text: "world" },
        { type: "text", text: "!" },
      ])
      expect(result).toBe("Hello <b>world</b>!")
    })
  })
})
