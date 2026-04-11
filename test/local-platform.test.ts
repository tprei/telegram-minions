import { describe, it, expect, vi, beforeEach } from "vitest"
import { LocalPlatform } from "../src/local/local-platform.js"
import type { ChatPlatform } from "../src/provider/chat-platform.js"
import type { KeyboardButton, ChatUpdate } from "../src/provider/types.js"
import type {
  MessageSentEvent,
  MessageEditedEvent,
  MessageDeletedEvent,
  MessagePinnedEvent,
  ThreadCreatedEvent,
  ThreadEditedEvent,
  ThreadClosedEvent,
  ThreadDeletedEvent,
  KeyboardSentEvent,
} from "../src/local/local-platform.js"

describe("LocalPlatform", () => {
  let platform: LocalPlatform

  beforeEach(() => {
    platform = new LocalPlatform("local-test-1")
  })

  it("implements ChatPlatform interface", () => {
    const p: ChatPlatform = platform
    expect(p.name).toBe("local")
    expect(p.chatId).toBe("local-test-1")
    expect(p.chat).toBeDefined()
    expect(p.threads).toBeDefined()
    expect(p.input).toBeDefined()
    expect(p.ui).not.toBeNull()
    expect(p.files).toBeNull()
    expect(p.formatter).not.toBeNull()
  })

  describe("threadLink", () => {
    it("generates a local deep link", () => {
      expect(platform.threadLink("42")).toBe("local://thread/42")
    })
  })

  describe("pushUpdate", () => {
    it("delegates to input.push", async () => {
      const update: ChatUpdate = {
        type: "message",
        message: {
          messageId: "1",
          text: "/task hello",
          timestamp: Date.now(),
        },
      }
      platform.pushUpdate(update)
      const updates = await platform.input.poll("0", 0)
      expect(updates).toHaveLength(1)
      expect(updates[0]).toEqual(update)
    })
  })

  describe("chat (ChatProvider)", () => {
    it("sendMessage returns incrementing message IDs", async () => {
      const r1 = await platform.chat.sendMessage("hello")
      const r2 = await platform.chat.sendMessage("world")
      expect(r1).toEqual({ ok: true, messageId: "1" })
      expect(r2).toEqual({ ok: true, messageId: "2" })
    })

    it("sendMessage emits message_sent event", async () => {
      const handler = vi.fn()
      platform.events.on("message_sent", handler)

      await platform.chat.sendMessage("hello", "10", "5")

      expect(handler).toHaveBeenCalledWith({
        messageId: "1",
        threadId: "10",
        content: "hello",
        replyToMessageId: "5",
      } satisfies MessageSentEvent)
    })

    it("sendMessage works without optional params", async () => {
      const handler = vi.fn()
      platform.events.on("message_sent", handler)

      await platform.chat.sendMessage("hello")

      expect(handler).toHaveBeenCalledWith({
        messageId: "1",
        threadId: undefined,
        content: "hello",
        replyToMessageId: undefined,
      } satisfies MessageSentEvent)
    })

    it("editMessage emits message_edited event and returns true", async () => {
      const handler = vi.fn()
      platform.events.on("message_edited", handler)

      const ok = await platform.chat.editMessage("42", "updated", "10")

      expect(ok).toBe(true)
      expect(handler).toHaveBeenCalledWith({
        messageId: "42",
        content: "updated",
        threadId: "10",
      } satisfies MessageEditedEvent)
    })

    it("deleteMessage emits message_deleted event", async () => {
      const handler = vi.fn()
      platform.events.on("message_deleted", handler)

      await platform.chat.deleteMessage("42")

      expect(handler).toHaveBeenCalledWith({
        messageId: "42",
      } satisfies MessageDeletedEvent)
    })

    it("pinMessage emits message_pinned event", async () => {
      const handler = vi.fn()
      platform.events.on("message_pinned", handler)

      await platform.chat.pinMessage("42")

      expect(handler).toHaveBeenCalledWith({
        messageId: "42",
      } satisfies MessagePinnedEvent)
    })
  })

  describe("threads (ThreadManager)", () => {
    it("createThread returns ThreadInfo with incrementing IDs", async () => {
      const t1 = await platform.threads.createThread("task-1")
      const t2 = await platform.threads.createThread("task-2")
      expect(t1).toEqual({ threadId: "1", name: "task-1" })
      expect(t2).toEqual({ threadId: "2", name: "task-2" })
    })

    it("createThread emits thread_created event", async () => {
      const handler = vi.fn()
      platform.events.on("thread_created", handler)

      await platform.threads.createThread("my-task")

      expect(handler).toHaveBeenCalledWith({
        threadId: "1",
        name: "my-task",
      } satisfies ThreadCreatedEvent)
    })

    it("editThread emits thread_edited event", async () => {
      const handler = vi.fn()
      platform.events.on("thread_edited", handler)

      await platform.threads.editThread("1", "renamed")

      expect(handler).toHaveBeenCalledWith({
        threadId: "1",
        name: "renamed",
      } satisfies ThreadEditedEvent)
    })

    it("closeThread emits thread_closed event", async () => {
      const handler = vi.fn()
      platform.events.on("thread_closed", handler)

      await platform.threads.closeThread("1")

      expect(handler).toHaveBeenCalledWith({
        threadId: "1",
      } satisfies ThreadClosedEvent)
    })

    it("deleteThread emits thread_deleted event", async () => {
      const handler = vi.fn()
      platform.events.on("thread_deleted", handler)

      await platform.threads.deleteThread("1")

      expect(handler).toHaveBeenCalledWith({
        threadId: "1",
      } satisfies ThreadDeletedEvent)
    })
  })

  describe("input (ChatInputSource)", () => {
    it("poll returns queued updates immediately", async () => {
      const update: ChatUpdate = {
        type: "message",
        message: { messageId: "1", text: "hello", timestamp: 1700000000 },
      }
      platform.pushUpdate(update)

      const updates = await platform.input.poll("0", 30)
      expect(updates).toHaveLength(1)
      expect(updates[0]).toEqual(update)
    })

    it("poll returns empty array when queue is empty and timeout is 0", async () => {
      const updates = await platform.input.poll("0", 0)
      expect(updates).toHaveLength(0)
    })

    it("poll resolves when update is pushed during wait", async () => {
      const update: ChatUpdate = {
        type: "message",
        message: { messageId: "1", text: "delayed", timestamp: 1700000000 },
      }

      const pollPromise = platform.input.poll("0", 5)

      // Push after poll starts waiting
      setTimeout(() => platform.pushUpdate(update), 10)

      const updates = await pollPromise
      expect(updates).toHaveLength(1)
      expect(updates[0]).toEqual(update)
    })

    it("poll times out and returns empty array", async () => {
      const updates = await platform.input.poll("0", 0.01)
      expect(updates).toHaveLength(0)
    })

    it("getCursor starts at 0", () => {
      expect(platform.input.getCursor()).toBe("0")
    })

    it("getCursor advances after polling updates", async () => {
      platform.pushUpdate({
        type: "message",
        message: { messageId: "1", text: "a", timestamp: 1 },
      })
      platform.pushUpdate({
        type: "message",
        message: { messageId: "2", text: "b", timestamp: 2 },
      })

      await platform.input.poll("0", 0)
      expect(platform.input.getCursor()).toBe("2")
    })

    it("getCursor advances by 1 when update resolves a waiting poll", async () => {
      const pollPromise = platform.input.poll("0", 5)
      setTimeout(() => platform.pushUpdate({
        type: "message",
        message: { messageId: "1", text: "x", timestamp: 1 },
      }), 10)

      await pollPromise
      expect(platform.input.getCursor()).toBe("1")
    })

    it("advanceCursor is a no-op", () => {
      platform.input.advanceCursor([])
      expect(platform.input.getCursor()).toBe("0")
    })

    it("drains multiple queued updates in one poll", async () => {
      for (let i = 0; i < 5; i++) {
        platform.pushUpdate({
          type: "message",
          message: { messageId: String(i), text: `msg-${i}`, timestamp: i },
        })
      }

      const updates = await platform.input.poll("0", 0)
      expect(updates).toHaveLength(5)
      expect(platform.input.getCursor()).toBe("5")
    })

    it("handles callback_query updates", async () => {
      const update: ChatUpdate = {
        type: "callback_query",
        query: {
          queryId: "cb-1",
          from: { id: "user-1", isBot: false, username: "alice" },
          data: "repo:my-repo",
        },
      }
      platform.pushUpdate(update)

      const updates = await platform.input.poll("0", 0)
      expect(updates).toHaveLength(1)
      expect(updates[0].type).toBe("callback_query")
      if (updates[0].type === "callback_query") {
        expect(updates[0].query.queryId).toBe("cb-1")
        expect(updates[0].query.data).toBe("repo:my-repo")
      }
    })
  })

  describe("ui (InteractiveUI)", () => {
    it("sendMessageWithKeyboard emits keyboard_sent event", async () => {
      const handler = vi.fn()
      platform.events.on("keyboard_sent", handler)

      const keyboard: KeyboardButton[][] = [
        [{ text: "Yes", callbackData: "y" }, { text: "No", callbackData: "n" }],
      ]
      const msgId = await platform.ui!.sendMessageWithKeyboard("Choose:", keyboard, "10")

      expect(msgId).toBeDefined()
      expect(typeof msgId).toBe("string")
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: msgId,
          threadId: "10",
          content: "Choose:",
          keyboard,
        } satisfies KeyboardSentEvent),
      )
    })

    it("answerCallbackQuery is a no-op", async () => {
      await expect(platform.ui!.answerCallbackQuery("cb-1", "Done!")).resolves.toBeUndefined()
    })
  })

  describe("files (FileHandler)", () => {
    it("is null — local platform does not support file operations", () => {
      expect(platform.files).toBeNull()
    })
  })

  describe("formatter (MessageFormatter)", () => {
    it("has a large maxMessageLength", () => {
      expect(platform.formatter!.maxMessageLength).toBe(65536)
    })

    it("escapeText returns text unchanged", () => {
      expect(platform.formatter!.escapeText("<b>hi</b> & 'bye'")).toBe("<b>hi</b> & 'bye'")
    })

    it("format converts text blocks without escaping", () => {
      const result = platform.formatter!.format([{ type: "text", text: "hello <world>" }])
      expect(result).toBe("hello <world>")
    })

    it("format converts code blocks to markdown", () => {
      const inline = platform.formatter!.format([{ type: "code", code: "x = 1" }])
      expect(inline).toBe("`x = 1`")

      const block = platform.formatter!.format([{ type: "code", language: "python", code: "x = 1" }])
      expect(block).toBe("```python\nx = 1\n```")
    })

    it("format converts bold and italic to markdown", () => {
      expect(platform.formatter!.format([{ type: "bold", text: "strong" }])).toBe("**strong**")
      expect(platform.formatter!.format([{ type: "italic", text: "em" }])).toBe("_em_")
    })

    it("format converts links to markdown", () => {
      expect(platform.formatter!.format([{ type: "link", url: "https://example.com", label: "Click" }]))
        .toBe("[Click](https://example.com)")
      expect(platform.formatter!.format([{ type: "link", url: "https://example.com" }]))
        .toBe("https://example.com")
    })

    it("format passes raw blocks through", () => {
      expect(platform.formatter!.format([{ type: "raw", markup: "**raw**" }])).toBe("**raw**")
    })

    it("format concatenates multiple blocks", () => {
      const result = platform.formatter!.format([
        { type: "text", text: "Hello " },
        { type: "bold", text: "world" },
        { type: "text", text: "!" },
      ])
      expect(result).toBe("Hello **world**!")
    })
  })

  describe("integration: full lifecycle", () => {
    it("can create a thread, send messages, and receive input", async () => {
      const sentMessages: MessageSentEvent[] = []
      platform.events.on("message_sent", (evt: MessageSentEvent) => sentMessages.push(evt))

      // Create a thread
      const thread = await platform.threads.createThread("test-task")
      expect(thread.threadId).toBe("1")

      // Send a message to the thread
      const result = await platform.chat.sendMessage("Task started", thread.threadId)
      expect(result.ok).toBe(true)
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].threadId).toBe("1")

      // Simulate user input
      platform.pushUpdate({
        type: "message",
        message: {
          messageId: "100",
          threadId: thread.threadId,
          from: { id: "user-1", isBot: false, username: "alice" },
          text: "/task do something",
          timestamp: Date.now(),
        },
      })

      // Poll for input
      const updates = await platform.input.poll("0", 0)
      expect(updates).toHaveLength(1)
      if (updates[0].type === "message") {
        expect(updates[0].message.text).toBe("/task do something")
        expect(updates[0].message.threadId).toBe("1")
      }

      // Edit the message
      const edited = await platform.chat.editMessage(result.messageId!, "Task completed", thread.threadId)
      expect(edited).toBe(true)

      // Close the thread
      await platform.threads.closeThread(thread.threadId)
    })
  })
})
