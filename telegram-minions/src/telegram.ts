import type { TelegramUpdate, TelegramForumTopic, TelegramCallbackQuery } from "./types.js"

const MAX_LENGTH = 4096
const BASE = "https://api.telegram.org"

function splitMessage(html: string): string[] {
  if (html.length <= MAX_LENGTH) return [html]

  const chunks: string[] = []
  let remaining = html

  while (remaining.length > MAX_LENGTH) {
    const slice = remaining.slice(0, MAX_LENGTH)
    const lastNewline = slice.lastIndexOf("\n")
    const splitAt = lastNewline > MAX_LENGTH / 2 ? lastNewline : MAX_LENGTH
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  if (remaining) chunks.push(remaining)
  return chunks
}

export class TelegramClient {
  private readonly baseUrl: string

  constructor(private readonly token: string, private readonly chatId: string) {
    this.baseUrl = `${BASE}/bot${token}`
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Telegram ${method} HTTP ${res.status}: ${text}`)
    }

    const data = (await res.json()) as { ok: boolean; result: T; description?: string }

    if (!data.ok) {
      throw new Error(`Telegram ${method} error: ${data.description ?? "unknown"}`)
    }

    return data.result
  }

  async getUpdates(offset: number, timeout: number): Promise<TelegramUpdate[]> {
    try {
      const result = await this.call<TelegramUpdate[]>("getUpdates", {
        offset,
        timeout,
        allowed_updates: ["message", "callback_query"],
      })
      return result
    } catch (err) {
      process.stderr.write(`telegram: getUpdates failed: ${err}\n`)
      return []
    }
  }

  private async sendOne(
    html: string,
    threadId?: number,
    replyToMessageId?: number,
  ): Promise<number | null> {
    try {
      const body: Record<string, unknown> = {
        chat_id: this.chatId,
        text: html,
        parse_mode: "HTML",
      }
      if (threadId !== undefined) body.message_thread_id = threadId
      if (replyToMessageId !== undefined) body.reply_to_message_id = replyToMessageId

      const result = await this.call<{ message_id: number }>("sendMessage", body)
      return result.message_id
    } catch (err) {
      process.stderr.write(`telegram: sendMessage failed: ${err}\n`)
      return null
    }
  }

  async sendMessage(
    html: string,
    threadId?: number,
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
    threadId?: number,
  ): Promise<boolean> {
    try {
      const body: Record<string, unknown> = {
        chat_id: this.chatId,
        message_id: messageId,
        text: html,
        parse_mode: "HTML",
      }
      if (threadId !== undefined) body.message_thread_id = threadId

      await this.call("editMessageText", body)
      return true
    } catch (err) {
      const msg = String(err)
      if (msg.includes("message is not modified")) return true
      process.stderr.write(`telegram: editMessage failed: ${err}\n`)
      return false
    }
  }

  async createForumTopic(name: string): Promise<TelegramForumTopic> {
    return this.call<TelegramForumTopic>("createForumTopic", {
      chat_id: this.chatId,
      name: name.slice(0, 128),
    })
  }

  async editForumTopic(threadId: number, name: string): Promise<void> {
    await this.call("editForumTopic", {
      chat_id: this.chatId,
      message_thread_id: threadId,
      name: name.slice(0, 128),
    })
  }

  async closeForumTopic(threadId: number): Promise<void> {
    try {
      await this.call("closeForumTopic", {
        chat_id: this.chatId,
        message_thread_id: threadId,
      })
    } catch (err) {
      process.stderr.write(`telegram: closeForumTopic failed: ${err}\n`)
    }
  }

  async sendMessageWithKeyboard(
    html: string,
    keyboard: { text: string; callback_data: string }[][],
    threadId?: number,
  ): Promise<number | null> {
    try {
      const body: Record<string, unknown> = {
        chat_id: this.chatId,
        text: html,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard },
      }
      if (threadId !== undefined) body.message_thread_id = threadId
      const result = await this.call<{ message_id: number }>("sendMessage", body)
      return result.message_id
    } catch (err) {
      process.stderr.write(`telegram: sendMessageWithKeyboard failed: ${err}\n`)
      return null
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    try {
      const body: Record<string, unknown> = { callback_query_id: callbackQueryId }
      if (text) body.text = text
      await this.call("answerCallbackQuery", body)
    } catch (err) {
      process.stderr.write(`telegram: answerCallbackQuery failed: ${err}\n`)
    }
  }

  async deleteMessage(messageId: number): Promise<void> {
    try {
      await this.call("deleteMessage", {
        chat_id: this.chatId,
        message_id: messageId,
      })
    } catch (err) {
      process.stderr.write(`telegram: deleteMessage failed: ${err}\n`)
    }
  }

  async deleteForumTopic(threadId: number): Promise<void> {
    try {
      await this.call("deleteForumTopic", {
        chat_id: this.chatId,
        message_thread_id: threadId,
      })
    } catch (err) {
      process.stderr.write(`telegram: deleteForumTopic failed: ${err}\n`)
    }
  }
}
