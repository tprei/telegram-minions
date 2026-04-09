import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { TelegramClient } from "../src/telegram/telegram.js"

const TOKEN = "test-token"
const CHAT_ID = "12345"

function ok<T>(result: T) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function rateLimit(retryAfter: number) {
  return new Response(
    JSON.stringify({
      ok: false,
      error_code: 429,
      description: `Too Many Requests: retry after ${retryAfter}`,
      parameters: { retry_after: retryAfter },
    }),
    { status: 429 },
  )
}

function httpError(status: number, description: string) {
  return new Response(JSON.stringify({ ok: false, description }), { status })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** Run a promise that involves sleep() calls by advancing fake timers. */
async function drainTimers<T>(promise: Promise<T>): Promise<T> {
  for (let i = 0; i < 20; i++) {
    await vi.advanceTimersByTimeAsync(15_000)
  }
  return promise
}

describe("TelegramClient retry logic", () => {
  describe("429 rate limiting", () => {
    it("retries after rate limit and succeeds", async () => {
      fetchMock
        .mockResolvedValueOnce(rateLimit(1))
        .mockResolvedValueOnce(ok({ message_id: 42 }))

      const client = new TelegramClient(TOKEN, CHAT_ID)
      const result = await drainTimers(client.sendMessage("hello"))

      expect(result).toEqual({ ok: true, messageId: "42" })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it("retries up to MAX_RETRIES times then throws", async () => {
      // Use mockImplementation to create fresh Response each call
      fetchMock.mockImplementation(() => Promise.resolve(rateLimit(1)))

      const client = new TelegramClient(TOKEN, CHAT_ID)
      const result = await drainTimers(client.sendMessage("hello"))

      expect(result).toEqual({ ok: false, messageId: null })
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it("uses default retry_after when response is not JSON", async () => {
      fetchMock
        .mockImplementationOnce(() =>
          Promise.resolve(new Response("rate limited", { status: 429 })),
        )
        .mockResolvedValueOnce(ok({ message_id: 1 }))

      const client = new TelegramClient(TOKEN, CHAT_ID)
      const result = await drainTimers(client.sendMessage("hello"))

      expect(result).toEqual({ ok: true, messageId: "1" })
    })
  })

  describe("transient network errors", () => {
    it("retries on fetch failure and succeeds", async () => {
      fetchMock
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(ok({ message_id: 99 }))

      const client = new TelegramClient(TOKEN, CHAT_ID)
      const result = await drainTimers(client.sendMessage("hello"))

      expect(result).toEqual({ ok: true, messageId: "99" })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it("gives up after MAX_RETRIES network failures", async () => {
      fetchMock.mockRejectedValue(new TypeError("fetch failed"))

      const client = new TelegramClient(TOKEN, CHAT_ID)
      const result = await drainTimers(client.sendMessage("hello"))

      expect(result).toEqual({ ok: false, messageId: null })
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })
  })

  describe("non-retryable errors", () => {
    it("does not retry on 400 Bad Request", async () => {
      fetchMock.mockResolvedValueOnce(httpError(400, "Bad Request"))

      const client = new TelegramClient(TOKEN, CHAT_ID)
      const result = await drainTimers(client.sendMessage("hello"))

      expect(result).toEqual({ ok: false, messageId: null })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it("does not retry on 403 Forbidden", async () => {
      fetchMock.mockResolvedValueOnce(httpError(403, "Forbidden"))

      const client = new TelegramClient(TOKEN, CHAT_ID)
      const result = await drainTimers(client.sendMessage("hello"))

      expect(result).toEqual({ ok: false, messageId: null })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  describe("editMessage with retry", () => {
    it("retries 429 on editMessage", async () => {
      fetchMock
        .mockResolvedValueOnce(ok({ message_id: 10 }))

      const client = new TelegramClient(TOKEN, CHAT_ID)
      const { messageId } = await drainTimers(client.sendMessage("hello"))

      fetchMock
        .mockResolvedValueOnce(rateLimit(1))
        .mockResolvedValueOnce(ok(true))

      const result = await drainTimers(client.editMessage(messageId!, "updated"))
      expect(result).toBe(true)
      // 1 sendMessage + 2 editMessage (retry)
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })
  })

  describe("getUpdates with retry", () => {
    it("returns empty array on persistent failure", async () => {
      fetchMock.mockRejectedValue(new TypeError("fetch failed"))

      const client = new TelegramClient(TOKEN, CHAT_ID)
      const result = await drainTimers(client.getUpdates(0, 30))

      expect(result).toEqual([])
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it("retries 429 on getUpdates and succeeds", async () => {
      fetchMock
        .mockResolvedValueOnce(rateLimit(1))
        .mockResolvedValueOnce(ok([{ update_id: 1 }]))

      const client = new TelegramClient(TOKEN, CHAT_ID)
      const result = await drainTimers(client.getUpdates(0, 30))

      expect(result).toEqual([{ update_id: 1 }])
    })
  })

  describe("sendPhoto with retry", () => {
    it("retries 429 on sendPhoto", async () => {
      fetchMock
        .mockResolvedValueOnce(rateLimit(1))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ ok: true, result: { message_id: 55 } }),
            { status: 200 },
          ),
        )

      const client = new TelegramClient(TOKEN, CHAT_ID)
      const result = await drainTimers(
        client.sendPhotoBuffer(Buffer.from("fake-png"), "test.png"),
      )

      expect(result).toBe("55")
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it("retries network error on sendPhoto", async () => {
      fetchMock
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ ok: true, result: { message_id: 56 } }),
            { status: 200 },
          ),
        )

      const client = new TelegramClient(TOKEN, CHAT_ID)
      const result = await drainTimers(
        client.sendPhotoBuffer(Buffer.from("fake-png"), "test.png"),
      )

      expect(result).toBe("56")
    })

    it("returns null after exhausting retries on sendPhoto", async () => {
      fetchMock.mockRejectedValue(new TypeError("fetch failed"))

      const client = new TelegramClient(TOKEN, CHAT_ID)
      const result = await drainTimers(
        client.sendPhotoBuffer(Buffer.from("fake-png"), "test.png"),
      )

      expect(result).toBe(null)
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })
  })

  describe("mixed retry scenarios", () => {
    it("handles 429 then network error then success", async () => {
      fetchMock
        .mockResolvedValueOnce(rateLimit(1))
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(ok({ message_id: 77 }))

      const client = new TelegramClient(TOKEN, CHAT_ID)
      const result = await drainTimers(client.sendMessage("hello"))

      expect(result).toEqual({ ok: true, messageId: "77" })
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })
  })

  describe("pinChatMessage", () => {
    it("sends pinChatMessage with disable_notification", async () => {
      fetchMock.mockResolvedValueOnce(ok(true))

      const client = new TelegramClient(TOKEN, CHAT_ID)
      await client.pinChatMessage("42")

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toContain("/pinChatMessage")
      const body = JSON.parse(opts.body)
      expect(body).toEqual({
        chat_id: CHAT_ID,
        message_id: 42,
        disable_notification: true,
      })
    })

    it("does not throw on failure", async () => {
      fetchMock.mockResolvedValueOnce(httpError(400, "Bad Request: not enough rights"))

      const client = new TelegramClient(TOKEN, CHAT_ID)
      await expect(client.pinChatMessage("42")).resolves.toBeUndefined()
    })
  })

  describe("request queue", () => {
    it("serializes concurrent sendMessage calls", async () => {
      fetchMock
        .mockResolvedValueOnce(ok({ message_id: 1 }))
        .mockResolvedValueOnce(ok({ message_id: 2 }))

      const client = new TelegramClient(TOKEN, CHAT_ID)
      const [r1, r2] = await drainTimers(
        Promise.all([client.sendMessage("a"), client.sendMessage("b")])
      )
      expect(r1).toEqual({ ok: true, messageId: "1" })
      expect(r2).toEqual({ ok: true, messageId: "2" })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it("coalesces pending edits for the same messageId", async () => {
      fetchMock
        .mockResolvedValueOnce(ok({ message_id: 10 }))
        .mockResolvedValueOnce(ok(true))

      const client = new TelegramClient(TOKEN, CHAT_ID)
      const { messageId } = await drainTimers(client.sendMessage("initial"))

      const [r1, r2] = await drainTimers(
        Promise.all([
          client.editMessage(messageId!, "edit 1"),
          client.editMessage(messageId!, "edit 2"),
        ])
      )
      expect(r1).toBe(true)
      expect(r2).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it("does not coalesce edits for different messageIds", async () => {
      fetchMock
        .mockResolvedValueOnce(ok(true))
        .mockResolvedValueOnce(ok(true))

      const client = new TelegramClient(TOKEN, CHAT_ID)
      const [r1, r2] = await drainTimers(
        Promise.all([
          client.editMessage(10, "edit A"),
          client.editMessage(20, "edit B"),
        ])
      )
      expect(r1).toBe(true)
      expect(r2).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
  })
})
