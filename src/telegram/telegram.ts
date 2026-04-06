import fs from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"
import type { TelegramUpdate, TelegramForumTopic } from "../domain/telegram-types.js"
import { captureException } from "../sentry.js"
import { loggers } from "../logger.js"
import {
  TelegramRateLimitError,
  TelegramHttpError,
  TelegramResponseError,
  TelegramRetryExhaustedError,
  isThreadNotFoundError,
} from "../errors.js"

const MAX_LENGTH = 4096
const log = loggers.telegram
const BASE = "https://api.telegram.org"
const MAX_RETRIES = 3
const TRANSIENT_RETRY_MS = 2000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseRetryAfter(body: string): number {
  try {
    const json = JSON.parse(body)
    if (json?.parameters?.retry_after) return json.parameters.retry_after
  } catch { /* not JSON */ }
  return 10 // safe default
}

/** Remove control characters that Telegram rejects as invalid UTF-8. */
function sanitizeText(text: string): string {
  // Strip C0 control chars except \t \n \r, plus DEL
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
}

/** Track unclosed HTML tags in a chunk and return closing/reopening strings. */
function balanceHtmlTags(chunk: string): { closingTags: string; reopenTags: string } {
  const tagPattern = /<\/?(\w+)>/g
  const stack: string[] = []
  let match: RegExpExecArray | null

  while ((match = tagPattern.exec(chunk)) !== null) {
    if (match[0].startsWith("</")) {
      const idx = stack.lastIndexOf(match[1])
      if (idx !== -1) stack.splice(idx, 1)
    } else {
      stack.push(match[1])
    }
  }

  const closingTags = [...stack].reverse().map((t) => `</${t}>`).join("")
  const reopenTags = stack.map((t) => `<${t}>`).join("")
  return { closingTags, reopenTags }
}

function splitMessage(html: string): string[] {
  if (html.length <= MAX_LENGTH) return [html]

  const chunks: string[] = []
  let remaining = html

  while (remaining.length > MAX_LENGTH) {
    const slice = remaining.slice(0, MAX_LENGTH)
    const lastNewline = slice.lastIndexOf("\n")
    let splitAt = lastNewline > MAX_LENGTH / 2 ? lastNewline : MAX_LENGTH

    // Avoid splitting inside an HTML tag
    const lastOpen = slice.lastIndexOf("<")
    const lastClose = slice.lastIndexOf(">")
    if (lastOpen > lastClose && lastOpen < splitAt) {
      splitAt = lastOpen
    }

    const chunk = remaining.slice(0, splitAt)
    remaining = remaining.slice(splitAt).trimStart()

    const { closingTags, reopenTags } = balanceHtmlTags(chunk)
    chunks.push(chunk + closingTags)
    if (reopenTags) remaining = reopenTags + remaining
  }

  if (remaining) chunks.push(remaining)
  return chunks
}

interface QueueEntry {
  fn: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  editKey?: string
}

export class TelegramClient {
  private readonly baseUrl: string
  private readonly queue: QueueEntry[] = []
  private processing = false
  private readonly minSendIntervalMs: number

  constructor(private readonly token: string, private readonly chatId: string, minSendIntervalMs = 3500) {
    this.baseUrl = `${BASE}/bot${token}`
    this.minSendIntervalMs = minSendIntervalMs
  }

  private enqueue<T>(fn: () => Promise<T>, editKey?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (editKey) {
        const idx = this.queue.findIndex((e) => e.editKey === editKey)
        if (idx !== -1) {
          const old = this.queue[idx]
          const prevResolve = old.resolve
          const prevReject = old.reject
          old.fn = fn as () => Promise<unknown>
          old.resolve = (v: unknown) => { prevResolve(v); resolve(v as T) }
          old.reject = (e: unknown) => { prevReject(e); reject(e) }
          return
        }
      }
      this.queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        editKey,
      })
      if (!this.processing) {
        this.processing = true
        queueMicrotask(() => this.processQueue())
      }
    })
  }

  private async processQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!
      try {
        const result = await entry.fn()
        entry.resolve(result)
      } catch (err) {
        entry.reject(err)
      }
      if (this.queue.length > 0) {
        await sleep(this.minSendIntervalMs)
      }
    }
    this.processing = false
  }

  private async call<T>(method: string, body: Record<string, unknown>, editKey?: string): Promise<T> {
    return this.enqueue(() => this.callDirect<T>(method, body), editKey)
  }

  private async callDirect<T>(method: string, body: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let res: Response
      try {
        res = await fetch(`${this.baseUrl}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      } catch (err) {
        // Transient network error (DNS, TCP, TLS)
        if (attempt < MAX_RETRIES - 1) {
          log.warn({ method, attempt: attempt + 1, err }, "fetch error, retrying")
          await sleep(TRANSIENT_RETRY_MS * (attempt + 1))
          continue
        }
        throw err
      }

      if (res.status === 429) {
        const text = await res.text()
        const retryAfter = parseRetryAfter(text)
        if (attempt < MAX_RETRIES - 1) {
          log.warn({ method, retryAfter }, "rate limited, retrying")
          await sleep(retryAfter * 1000)
          continue
        }
        throw new TelegramRateLimitError(method, text, retryAfter)
      }

      if (res.status >= 500 && attempt < MAX_RETRIES - 1) {
        await res.text()
        const delay = TRANSIENT_RETRY_MS * Math.pow(2, attempt)
        log.warn({ method, status: res.status, attempt: attempt + 1, delayMs: delay }, "server error, retrying")
        await sleep(delay)
        continue
      }

      if (!res.ok) {
        const text = await res.text()
        throw new TelegramHttpError(method, res.status, text)
      }

      const data = (await res.json()) as { ok: boolean; result: T; description?: string }

      if (!data.ok) {
        throw new TelegramResponseError(method, data.description)
      }

      return data.result
    }
    throw new TelegramRetryExhaustedError(method, MAX_RETRIES)
  }

  async getUpdates(offset: number, timeout: number): Promise<TelegramUpdate[]> {
    try {
      const result = await this.callDirect<TelegramUpdate[]>("getUpdates", {
        offset,
        timeout,
        allowed_updates: ["message", "callback_query"],
      })
      return result
    } catch (err) {
      log.error({ err, method: "getUpdates" }, "getUpdates failed")
      captureException(err, { method: "getUpdates" })
      return []
    }
  }

  private async sendOne(
    html: string,
    threadId?: string,
    replyToMessageId?: number,
  ): Promise<number | null> {
    const sanitized = sanitizeText(html)
    try {
      const body: Record<string, unknown> = {
        chat_id: this.chatId,
        text: sanitized,
        parse_mode: "HTML",
      }
      if (threadId !== undefined) body.message_thread_id = Number(threadId)
      if (replyToMessageId !== undefined) body.reply_to_message_id = replyToMessageId

      const result = await this.call<{ message_id: number }>("sendMessage", body)
      return result.message_id
    } catch (err) {
      if (isThreadNotFoundError(err)) {
        throw err
      }
      log.error({ err, method: "sendMessage" }, "sendMessage failed")
      captureException(err, { method: "sendMessage" })
      return null
    }
  }

  async sendMessage(
    html: string,
    threadId?: string,
    replyToMessageId?: number,
  ): Promise<{ ok: boolean; messageId: number | null }> {
    const chunks = splitMessage(html)

    const firstId = await this.sendOne(chunks[0], threadId, replyToMessageId)
    if (firstId === null) return { ok: false, messageId: null }

    for (let i = 1; i < chunks.length; i++) {
      if ((await this.sendOne(chunks[i], threadId, firstId)) === null) {
        return { ok: false, messageId: firstId }
      }
    }

    return { ok: true, messageId: firstId }
  }

  async editMessage(
    messageId: number,
    html: string,
    threadId?: string,
  ): Promise<boolean> {
    const sanitized = sanitizeText(html)
    try {
      const body: Record<string, unknown> = {
        chat_id: this.chatId,
        message_id: messageId,
        text: sanitized,
        parse_mode: "HTML",
      }
      if (threadId !== undefined) body.message_thread_id = Number(threadId)

      await this.call("editMessageText", body, String(messageId))
      return true
    } catch (err) {
      if (String(err).includes("message is not modified")) return true
      log.error({ err, method: "editMessage" }, "editMessage failed")
      captureException(err, { method: "editMessage" })
      return false
    }
  }

  async createForumTopic(name: string): Promise<TelegramForumTopic> {
    return this.call<TelegramForumTopic>("createForumTopic", {
      chat_id: this.chatId,
      name: name.slice(0, 128),
    })
  }

  async editForumTopic(threadId: string, name: string): Promise<void> {
    await this.call("editForumTopic", {
      chat_id: this.chatId,
      message_thread_id: Number(threadId),
      name: name.slice(0, 128),
    })
  }

  async pinChatMessage(messageId: number): Promise<void> {
    try {
      await this.call("pinChatMessage", {
        chat_id: this.chatId,
        message_id: messageId,
        disable_notification: true,
      })
    } catch (err) {
      log.warn({ err, method: "pinChatMessage" }, "pinChatMessage failed")
    }
  }

  async closeForumTopic(threadId: string): Promise<void> {
    try {
      await this.call("closeForumTopic", {
        chat_id: this.chatId,
        message_thread_id: Number(threadId),
      })
    } catch (err) {
      log.warn({ err, method: "closeForumTopic" }, "closeForumTopic failed")
    }
  }

  async sendMessageWithKeyboard(
    html: string,
    keyboard: { text: string; callback_data: string }[][],
    threadId?: string,
  ): Promise<number | null> {
    try {
      const body: Record<string, unknown> = {
        chat_id: this.chatId,
        text: html,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard },
      }
      if (threadId !== undefined) body.message_thread_id = Number(threadId)
      const result = await this.call<{ message_id: number }>("sendMessage", body)
      return result.message_id
    } catch (err) {
      log.error({ err, method: "sendMessageWithKeyboard" }, "sendMessageWithKeyboard failed")
      return null
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    try {
      const body: Record<string, unknown> = { callback_query_id: callbackQueryId }
      if (text) body.text = text
      await this.call("answerCallbackQuery", body)
    } catch (err) {
      log.warn({ err, method: "answerCallbackQuery" }, "answerCallbackQuery failed")
    }
  }

  async deleteMessage(messageId: number): Promise<void> {
    try {
      await this.call("deleteMessage", {
        chat_id: this.chatId,
        message_id: messageId,
      })
    } catch (err) {
      log.warn({ err, method: "deleteMessage" }, "deleteMessage failed")
    }
  }

  async deleteForumTopic(threadId: string): Promise<void> {
    try {
      await this.call("deleteForumTopic", {
        chat_id: this.chatId,
        message_thread_id: Number(threadId),
      })
    } catch (err) {
      log.warn({ err, method: "deleteForumTopic" }, "deleteForumTopic failed")
    }
  }

  async sendPhoto(
    photoPath: string,
    threadId?: string,
    caption?: string,
  ): Promise<number | null> {
    try {
      const data = fs.readFileSync(photoPath)
      return await this.sendPhotoBlob(new Blob([data]), path.basename(photoPath), threadId, caption)
    } catch (err) {
      log.error({ err, method: "sendPhoto", photoPath }, "sendPhoto failed")
      captureException(err, { method: "sendPhoto" })
      return null
    }
  }

  async sendPhotoBuffer(
    buffer: Buffer,
    filename: string,
    threadId?: string,
    caption?: string,
  ): Promise<number | null> {
    try {
      return await this.sendPhotoBlob(new Blob([buffer]), filename, threadId, caption)
    } catch (err) {
      log.error({ err, method: "sendPhotoBuffer", filename }, "sendPhotoBuffer failed")
      captureException(err, { method: "sendPhotoBuffer" })
      return null
    }
  }

  private sendPhotoBlob(
    blob: Blob,
    filename: string,
    threadId?: string,
    caption?: string,
  ): Promise<number | null> {
    return this.enqueue(() => this.sendPhotoBlobDirect(blob, filename, threadId, caption))
  }

  private async sendPhotoBlobDirect(
    blob: Blob,
    filename: string,
    threadId?: string,
    caption?: string,
  ): Promise<number | null> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const form = new FormData()
      form.append("chat_id", this.chatId)
      form.append("photo", blob, filename)
      if (threadId !== undefined) form.append("message_thread_id", String(threadId))
      if (caption) form.append("caption", sanitizeText(caption))

      let res: Response
      try {
        res = await fetch(`${this.baseUrl}/sendPhoto`, { method: "POST", body: form })
      } catch (err) {
        if (attempt < MAX_RETRIES - 1) {
          log.warn({ attempt: attempt + 1, err }, "sendPhoto fetch error, retrying")
          await sleep(TRANSIENT_RETRY_MS * (attempt + 1))
          continue
        }
        throw err
      }

      if (res.status === 429) {
        const text = await res.text()
        const retryAfter = parseRetryAfter(text)
        if (attempt < MAX_RETRIES - 1) {
          log.warn({ retryAfter }, "sendPhoto rate limited, retrying")
          await sleep(retryAfter * 1000)
          continue
        }
        throw new TelegramRateLimitError("sendPhoto", text, retryAfter)
      }

      if (!res.ok) {
        const text = await res.text()
        throw new TelegramHttpError("sendPhoto", res.status, text)
      }

      const json = (await res.json()) as { ok: boolean; result: { message_id: number }; description?: string }
      if (!json.ok) throw new TelegramResponseError("sendPhoto", json.description)

      return json.result.message_id
    }
    throw new TelegramRetryExhaustedError("sendPhoto", MAX_RETRIES)
  }

  async downloadFile(fileId: string, destPath: string): Promise<boolean> {
    try {
      const fileInfo = await this.call<{ file_path: string }>("getFile", { file_id: fileId })
      const url = `${BASE}/file/bot${this.token}/${fileInfo.file_path}`
      const res = await fetch(url)
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} downloading file`)
      }
      await pipeline(Readable.fromWeb(res.body as import("stream/web").ReadableStream), fs.createWriteStream(destPath))
      return true
    } catch (err) {
      log.error({ err, method: "downloadFile", fileId, destPath }, "downloadFile failed")
      captureException(err, { method: "downloadFile" })
      return false
    }
  }
}
