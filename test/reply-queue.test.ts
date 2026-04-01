import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ReplyQueue } from "../src/reply-queue.js"

describe("ReplyQueue", () => {
  let tmpDir: string
  let queue: ReplyQueue

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reply-queue-test-"))
    queue = new ReplyQueue(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("push", () => {
    it("creates a reply file and returns the queued reply", async () => {
      const reply = await queue.push("hello agent")
      expect(reply.text).toBe("hello agent")
      expect(reply.delivered).toBe(false)
      expect(reply.id).toMatch(/^\d+-[a-z0-9]+$/)
      expect(reply.timestamp).toBeGreaterThan(0)
      expect(reply.images).toBeUndefined()
    })

    it("stores images when provided", async () => {
      const reply = await queue.push("with image", ["/tmp/photo.jpg"])
      expect(reply.images).toEqual(["/tmp/photo.jpg"])
    })

    it("omits images field when array is empty", async () => {
      const reply = await queue.push("no images", [])
      expect(reply.images).toBeUndefined()
    })

    it("creates the queue directory if it does not exist", async () => {
      const queueDir = path.join(tmpDir, ".minion", "reply-queue")
      expect(fs.existsSync(queueDir)).toBe(false)
      await queue.push("first")
      expect(fs.existsSync(queueDir)).toBe(true)
    })

    it("persists reply data to a JSON file on disk", async () => {
      const reply = await queue.push("persisted text")
      const filePath = path.join(tmpDir, ".minion", "reply-queue", `${reply.id}.json`)
      const raw = fs.readFileSync(filePath, "utf-8")
      const data = JSON.parse(raw)
      expect(data.text).toBe("persisted text")
      expect(data.delivered).toBe(false)
    })
  })

  describe("list", () => {
    it("returns empty array when queue directory does not exist", async () => {
      const result = await queue.list()
      expect(result).toEqual([])
    })

    it("returns all queued replies in FIFO order", async () => {
      const r1 = await queue.push("first")
      const r2 = await queue.push("second")
      const r3 = await queue.push("third")

      const all = await queue.list()
      expect(all).toHaveLength(3)
      expect(all[0].id).toBe(r1.id)
      expect(all[1].id).toBe(r2.id)
      expect(all[2].id).toBe(r3.id)
    })

    it("skips corrupt JSON files without throwing", async () => {
      await queue.push("valid")
      const queueDir = path.join(tmpDir, ".minion", "reply-queue")
      fs.writeFileSync(path.join(queueDir, "9999999999999-corrupt.json"), "not json{{{")
      const all = await queue.list()
      expect(all).toHaveLength(1)
      expect(all[0].text).toBe("valid")
    })

    it("ignores .tmp files", async () => {
      await queue.push("real")
      const queueDir = path.join(tmpDir, ".minion", "reply-queue")
      fs.writeFileSync(path.join(queueDir, "0000-leftover.json.tmp"), '{"text":"orphan","timestamp":0,"delivered":false}')
      const all = await queue.list()
      expect(all).toHaveLength(1)
    })
  })

  describe("pending", () => {
    it("returns only undelivered replies", async () => {
      const r1 = await queue.push("first")
      await queue.push("second")
      await queue.markDelivered(r1.id)

      const pending = await queue.pending()
      expect(pending).toHaveLength(1)
      expect(pending[0].text).toBe("second")
    })

    it("returns empty array when all are delivered", async () => {
      const r1 = await queue.push("only")
      await queue.markDelivered(r1.id)
      expect(await queue.pending()).toEqual([])
    })
  })

  describe("markDelivered", () => {
    it("marks a reply as delivered on disk", async () => {
      const reply = await queue.push("deliver me")
      await queue.markDelivered(reply.id)

      const all = await queue.list()
      expect(all).toHaveLength(1)
      expect(all[0].delivered).toBe(true)
    })

    it("is a no-op for a nonexistent id", async () => {
      await expect(queue.markDelivered("nonexistent-abc123")).resolves.toBeUndefined()
    })

    it("preserves other fields when marking delivered", async () => {
      const reply = await queue.push("with images", ["/tmp/a.png", "/tmp/b.png"])
      await queue.markDelivered(reply.id)

      const all = await queue.list()
      expect(all[0].text).toBe("with images")
      expect(all[0].images).toEqual(["/tmp/a.png", "/tmp/b.png"])
      expect(all[0].delivered).toBe(true)
    })
  })

  describe("clear", () => {
    it("removes all files and returns count", async () => {
      await queue.push("a")
      await queue.push("b")
      const removed = await queue.clear()
      expect(removed).toBe(2)
      expect(await queue.list()).toEqual([])
    })

    it("returns 0 when queue directory does not exist", async () => {
      expect(await queue.clear()).toBe(0)
    })
  })

  describe("clearDelivered", () => {
    it("removes only delivered replies", async () => {
      const r1 = await queue.push("done")
      await queue.push("pending")
      await queue.markDelivered(r1.id)

      const removed = await queue.clearDelivered()
      expect(removed).toBe(1)
      const remaining = await queue.list()
      expect(remaining).toHaveLength(1)
      expect(remaining[0].text).toBe("pending")
    })

    it("returns 0 when nothing is delivered", async () => {
      await queue.push("still pending")
      expect(await queue.clearDelivered()).toBe(0)
    })
  })

  describe("crash resilience", () => {
    it("survives a new ReplyQueue instance reading existing data", async () => {
      await queue.push("before crash")
      const queue2 = new ReplyQueue(tmpDir)
      const pending = await queue2.pending()
      expect(pending).toHaveLength(1)
      expect(pending[0].text).toBe("before crash")
    })

    it("new instance can continue pushing after recovery", async () => {
      await queue.push("old")
      const queue2 = new ReplyQueue(tmpDir)
      await queue2.push("new")
      const all = await queue2.list()
      expect(all).toHaveLength(2)
      expect(all.map((r) => r.text)).toContain("old")
      expect(all.map((r) => r.text)).toContain("new")
    })

    it("half-written .tmp files do not corrupt the queue", async () => {
      await queue.push("valid")
      const queueDir = path.join(tmpDir, ".minion", "reply-queue")
      // Simulate a crash mid-write: a .tmp file left behind
      fs.writeFileSync(
        path.join(queueDir, "9999999999999-crashed.json.tmp"),
        '{"text":"incomplete"'
      )
      const queue2 = new ReplyQueue(tmpDir)
      const pending = await queue2.pending()
      expect(pending).toHaveLength(1)
      expect(pending[0].text).toBe("valid")
    })
  })

  describe("concurrent pushes", () => {
    it("handles multiple concurrent pushes without data loss", async () => {
      const pushes = Array.from({ length: 10 }, (_, i) =>
        queue.push(`message-${i}`)
      )
      await Promise.all(pushes)
      const all = await queue.list()
      expect(all).toHaveLength(10)
    })
  })
})
