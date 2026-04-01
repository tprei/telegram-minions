import { describe, it, expect, beforeEach } from "vitest"
import { FakeTelegram } from "./fake-telegram.js"

describe("FakeTelegram", () => {
  let tg: FakeTelegram

  beforeEach(() => {
    tg = new FakeTelegram()
  })

  // ---------------------------------------------------------------------------
  // sendMessage
  // ---------------------------------------------------------------------------

  describe("sendMessage", () => {
    it("returns ok with a unique messageId", async () => {
      const r1 = await tg.sendMessage("hello")
      const r2 = await tg.sendMessage("world")
      expect(r1).toEqual({ ok: true, messageId: expect.any(Number) })
      expect(r2.messageId).not.toBe(r1.messageId)
    })

    it("stores the message in the messages map", async () => {
      const { messageId } = await tg.sendMessage("<b>hi</b>", 42, 7)
      const stored = tg.messages.get(messageId!)
      expect(stored).toBeDefined()
      expect(stored!.html).toBe("<b>hi</b>")
      expect(stored!.threadId).toBe(42)
      expect(stored!.replyToMessageId).toBe(7)
      expect(stored!.editHistory).toEqual([])
    })

    it("records the call", async () => {
      await tg.sendMessage("test", 1)
      expect(tg.callsTo("sendMessage")).toHaveLength(1)
      expect(tg.callsTo("sendMessage")[0].args).toEqual(["test", 1, undefined])
    })
  })

  // ---------------------------------------------------------------------------
  // editMessage
  // ---------------------------------------------------------------------------

  describe("editMessage", () => {
    it("updates html and pushes old value to editHistory", async () => {
      const { messageId } = await tg.sendMessage("v1", 10)
      await tg.editMessage(messageId!, "v2", 10)
      await tg.editMessage(messageId!, "v3", 10)

      const stored = tg.messages.get(messageId!)!
      expect(stored.html).toBe("v3")
      expect(stored.editHistory).toEqual(["v1", "v2"])
    })

    it("returns true even for unknown messageId", async () => {
      expect(await tg.editMessage(999, "nope")).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // createForumTopic / editForumTopic / closeForumTopic / deleteForumTopic
  // ---------------------------------------------------------------------------

  describe("forum topics", () => {
    it("creates a topic with a unique threadId", async () => {
      const t1 = await tg.createForumTopic("Topic A")
      const t2 = await tg.createForumTopic("Topic B")
      expect(t1.message_thread_id).not.toBe(t2.message_thread_id)
      expect(t1.name).toBe("Topic A")
    })

    it("truncates topic name to 128 chars", async () => {
      const longName = "x".repeat(200)
      const topic = await tg.createForumTopic(longName)
      expect(topic.name).toHaveLength(128)
    })

    it("stores the topic and allows edits", async () => {
      const topic = await tg.createForumTopic("Original")
      await tg.editForumTopic(topic.message_thread_id, "Renamed")
      expect(tg.topics.get(topic.message_thread_id)!.name).toBe("Renamed")
    })

    it("closes a topic", async () => {
      const topic = await tg.createForumTopic("Open")
      await tg.closeForumTopic(topic.message_thread_id)
      expect(tg.topics.get(topic.message_thread_id)!.closed).toBe(true)
    })

    it("marks topic as deleted", async () => {
      const topic = await tg.createForumTopic("Doomed")
      await tg.deleteForumTopic(topic.message_thread_id)
      expect(tg.topics.get(topic.message_thread_id)!.deleted).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // pinChatMessage
  // ---------------------------------------------------------------------------

  describe("pinChatMessage", () => {
    it("tracks pinned message IDs", async () => {
      await tg.pinChatMessage(42)
      await tg.pinChatMessage(99)
      expect(tg.pinnedMessageIds.has(42)).toBe(true)
      expect(tg.pinnedMessageIds.has(99)).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // sendMessageWithKeyboard
  // ---------------------------------------------------------------------------

  describe("sendMessageWithKeyboard", () => {
    it("stores the keyboard alongside the message", async () => {
      const kb = [[{ text: "Yes", callback_data: "yes" }]]
      const id = await tg.sendMessageWithKeyboard("Pick one", kb, 5)
      expect(id).toBeTypeOf("number")
      const stored = tg.messages.get(id!)!
      expect(stored.keyboard).toEqual(kb)
      expect(stored.threadId).toBe(5)
    })
  })

  // ---------------------------------------------------------------------------
  // answerCallbackQuery
  // ---------------------------------------------------------------------------

  describe("answerCallbackQuery", () => {
    it("records the call", async () => {
      await tg.answerCallbackQuery("cb-123", "Done!")
      expect(tg.callsTo("answerCallbackQuery")).toHaveLength(1)
      expect(tg.callsTo("answerCallbackQuery")[0].args).toEqual(["cb-123", "Done!"])
    })
  })

  // ---------------------------------------------------------------------------
  // deleteMessage
  // ---------------------------------------------------------------------------

  describe("deleteMessage", () => {
    it("removes from messages map and adds to deletedMessageIds", async () => {
      const { messageId } = await tg.sendMessage("bye")
      await tg.deleteMessage(messageId!)
      expect(tg.messages.has(messageId!)).toBe(false)
      expect(tg.deletedMessageIds.has(messageId!)).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // sendPhoto / sendPhotoBuffer
  // ---------------------------------------------------------------------------

  describe("photos", () => {
    it("sendPhoto stores a path-based photo", async () => {
      const id = await tg.sendPhoto("/tmp/img.png", 10, "Screenshot")
      expect(id).toBeTypeOf("number")
      const stored = tg.photos.get(id!)!
      expect(stored.source).toBe("path")
      expect(stored.ref).toBe("/tmp/img.png")
      expect(stored.caption).toBe("Screenshot")
    })

    it("sendPhotoBuffer stores a buffer-based photo", async () => {
      const buf = Buffer.from("fake-png")
      const id = await tg.sendPhotoBuffer(buf, "shot.png", 10)
      expect(id).toBeTypeOf("number")
      const stored = tg.photos.get(id!)!
      expect(stored.source).toBe("buffer")
      expect(stored.ref).toBe("shot.png")
    })
  })

  // ---------------------------------------------------------------------------
  // downloadFile
  // ---------------------------------------------------------------------------

  describe("downloadFile", () => {
    it("returns false and records the call", async () => {
      const ok = await tg.downloadFile("file-abc", "/tmp/out.dat")
      expect(ok).toBe(false)
      expect(tg.callsTo("downloadFile")).toHaveLength(1)
    })
  })

  // ---------------------------------------------------------------------------
  // getUpdates + enqueueUpdates
  // ---------------------------------------------------------------------------

  describe("getUpdates", () => {
    it("returns empty array when no updates queued", async () => {
      expect(await tg.getUpdates(0, 1)).toEqual([])
    })

    it("returns enqueued batches in FIFO order", async () => {
      const u1 = tg.makeTextUpdate("/task repo Do stuff")
      const u2 = tg.makeTextUpdate("/stop")
      tg.enqueueUpdates(u1)
      tg.enqueueUpdates(u2)

      const batch1 = await tg.getUpdates(0, 1)
      expect(batch1).toEqual([u1])

      const batch2 = await tg.getUpdates(0, 1)
      expect(batch2).toEqual([u2])

      const batch3 = await tg.getUpdates(0, 1)
      expect(batch3).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // makeTextUpdate / makeCallbackUpdate helpers
  // ---------------------------------------------------------------------------

  describe("update builders", () => {
    it("makeTextUpdate produces a valid TelegramUpdate", () => {
      const u = tg.makeTextUpdate("/task repo Hello", { threadId: 42, userId: 7 })
      expect(u.update_id).toBeTypeOf("number")
      expect(u.message!.text).toBe("/task repo Hello")
      expect(u.message!.message_thread_id).toBe(42)
      expect(u.message!.is_topic_message).toBe(true)
      expect(u.message!.from!.id).toBe(7)
    })

    it("makeCallbackUpdate produces a valid TelegramUpdate", () => {
      const u = tg.makeCallbackUpdate("repo:myrepo", { messageId: 55, userId: 3 })
      expect(u.callback_query!.data).toBe("repo:myrepo")
      expect(u.callback_query!.message!.message_id).toBe(55)
      expect(u.callback_query!.from.id).toBe(3)
    })

    it("makeTextUpdate without options uses defaults", () => {
      const u = tg.makeTextUpdate("hi")
      expect(u.message!.from!.id).toBe(1)
      expect(u.message!.message_thread_id).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Query helpers
  // ---------------------------------------------------------------------------

  describe("query helpers", () => {
    it("callsTo filters by method name", async () => {
      await tg.sendMessage("a")
      await tg.editMessage(1, "b")
      await tg.sendMessage("c")
      expect(tg.callsTo("sendMessage")).toHaveLength(2)
      expect(tg.callsTo("editMessage")).toHaveLength(1)
    })

    it("messagesInThread returns only messages for that thread", async () => {
      await tg.sendMessage("a", 1)
      await tg.sendMessage("b", 2)
      await tg.sendMessage("c", 1)
      expect(tg.messagesInThread(1)).toHaveLength(2)
      expect(tg.messagesInThread(2)).toHaveLength(1)
    })

    it("lastMessage returns the most recently sent message", async () => {
      await tg.sendMessage("first")
      await tg.sendMessage("second")
      expect(tg.lastMessage()!.html).toBe("second")
    })

    it("sentHtml returns flat list of html strings", async () => {
      await tg.sendMessage("<b>A</b>")
      await tg.sendMessage("<i>B</i>")
      expect(tg.sentHtml()).toEqual(["<b>A</b>", "<i>B</i>"])
    })

    it("hasSentContaining checks substring match", async () => {
      await tg.sendMessage("Session started for repo-x")
      expect(tg.hasSentContaining("repo-x")).toBe(true)
      expect(tg.hasSentContaining("repo-y")).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // waitFor* helpers
  // ---------------------------------------------------------------------------

  describe("waitFor", () => {
    it("resolves immediately if a past call matches", async () => {
      await tg.sendMessage("already here")
      const call = await tg.waitFor((c) => c.method === "sendMessage")
      expect(call.method).toBe("sendMessage")
    })

    it("waits for a future call", async () => {
      const promise = tg.waitForMessage("delayed")
      // call arrives after a tick
      setTimeout(() => tg.sendMessage("delayed msg"), 10)
      const call = await promise
      expect(String(call.args[0])).toContain("delayed")
    })

    it("times out if no matching call arrives", async () => {
      await expect(tg.waitFor(() => false, 50)).rejects.toThrow("timed out")
    })
  })

  describe("waitForMessageInThread", () => {
    it("resolves when a message is sent to the specified thread", async () => {
      const promise = tg.waitForMessageInThread(42)
      setTimeout(() => tg.sendMessage("yo", 42), 10)
      const call = await promise
      expect(call.args[1]).toBe(42)
    })
  })

  describe("waitForTopicCreation", () => {
    it("resolves on createForumTopic call", async () => {
      const promise = tg.waitForTopicCreation()
      setTimeout(() => tg.createForumTopic("New Topic"), 10)
      const call = await promise
      expect(call.args[0]).toBe("New Topic")
    })
  })

  describe("waitForCallCount", () => {
    it("resolves when the method has been called N times", async () => {
      await tg.sendMessage("1")
      const promise = tg.waitForCallCount("sendMessage", 3)
      setTimeout(async () => {
        await tg.sendMessage("2")
        await tg.sendMessage("3")
      }, 10)
      await promise
      expect(tg.callsTo("sendMessage")).toHaveLength(3)
    })
  })

  // ---------------------------------------------------------------------------
  // reset
  // ---------------------------------------------------------------------------

  describe("reset", () => {
    it("clears all state", async () => {
      await tg.sendMessage("msg", 1)
      await tg.createForumTopic("topic")
      await tg.sendPhoto("/img.png")
      await tg.pinChatMessage(1)
      await tg.deleteMessage(999)
      tg.enqueueUpdates(tg.makeTextUpdate("hi"))

      tg.reset()

      expect(tg.calls).toHaveLength(0)
      expect(tg.messages.size).toBe(0)
      expect(tg.photos.size).toBe(0)
      expect(tg.topics.size).toBe(0)
      expect(tg.pinnedMessageIds.size).toBe(0)
      expect(tg.deletedMessageIds.size).toBe(0)
      expect(await tg.getUpdates(0, 1)).toEqual([])
    })

    it("resets ID counters so IDs restart from 1", async () => {
      await tg.sendMessage("before")
      tg.reset()
      const { messageId } = await tg.sendMessage("after")
      expect(messageId).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // Type compatibility: can be used as TelegramClient via `as any`
  // ---------------------------------------------------------------------------

  describe("type compatibility", () => {
    it("has all methods that existing test mocks use", () => {
      const methods = [
        "getUpdates",
        "sendMessage",
        "editMessage",
        "createForumTopic",
        "editForumTopic",
        "pinChatMessage",
        "closeForumTopic",
        "sendMessageWithKeyboard",
        "answerCallbackQuery",
        "deleteMessage",
        "deleteForumTopic",
        "sendPhoto",
        "sendPhotoBuffer",
        "downloadFile",
      ]
      for (const m of methods) {
        expect(typeof (tg as Record<string, unknown>)[m]).toBe("function")
      }
    })
  })
})
