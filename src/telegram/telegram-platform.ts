// TelegramPlatform — ChatPlatform adapter wrapping TelegramClient.
//
// Converts between Telegram's numeric IDs and the provider's opaque
// string IDs, and composes TelegramClient methods into the ChatPlatform
// sub-interfaces (ChatProvider, ThreadManager, ChatInputSource, etc.).

import type { TelegramClient } from "./telegram.js"
import type { TelegramUpdate } from "../domain/telegram-types.js"
import type { ChatPlatform } from "../provider/chat-platform.js"
import type { ChatProvider } from "../provider/chat-provider.js"
import type { ThreadManager } from "../provider/thread-manager.js"
import type { ChatInputSource } from "../provider/input-source.js"
import type { InteractiveUI } from "../provider/interactive-ui.js"
import type { FileHandler } from "../provider/file-handler.js"
import type { MessageFormatter } from "../provider/message-formatter.js"
import type {
  MessageId,
  ThreadId,
  SendResult,
  ThreadInfo,
  KeyboardButton,
  ChatUpdate,
} from "../provider/types.js"
import { esc } from "./format.js"

// ── ID conversion helpers ────────────────────────────────────────────

function toThreadNum(threadId?: ThreadId): number | undefined {
  return threadId !== undefined ? Number(threadId) : undefined
}

function toMsgNum(messageId: MessageId): number {
  return Number(messageId)
}

function toMsgStr(id: number | null): MessageId | null {
  return id !== null ? String(id) : null
}

// ── Telegram → ChatUpdate conversion ────────────────────────────────

function convertUpdate(update: TelegramUpdate): ChatUpdate | null {
  if (update.message) {
    const m = update.message
    return {
      type: "message",
      message: {
        messageId: String(m.message_id),
        threadId: m.message_thread_id !== undefined ? String(m.message_thread_id) : undefined,
        from: m.from
          ? {
              id: String(m.from.id),
              isBot: m.from.is_bot,
              username: m.from.username,
              displayName: m.from.first_name,
            }
          : undefined,
        text: m.text,
        caption: m.caption,
        photos: m.photo?.map((p) => ({
          fileId: p.file_id,
          width: p.width,
          height: p.height,
          fileSize: p.file_size,
        })),
        timestamp: m.date,
      },
    }
  }
  if (update.callback_query) {
    const cb = update.callback_query
    return {
      type: "callback_query",
      query: {
        queryId: cb.id,
        from: {
          id: String(cb.from.id),
          isBot: cb.from.is_bot,
          username: cb.from.username,
          displayName: cb.from.first_name,
        },
        messageId: cb.message ? String(cb.message.message_id) : undefined,
        threadId: cb.message?.message_thread_id !== undefined
          ? String(cb.message.message_thread_id)
          : undefined,
        data: cb.data,
      },
    }
  }
  return null
}

// ── TelegramChatProvider ────────────────────────────────────────────

class TelegramChatProvider implements ChatProvider {
  constructor(private readonly client: TelegramClient) {}

  async sendMessage(content: string, threadId?: ThreadId, replyToMessageId?: MessageId): Promise<SendResult> {
    const result = await this.client.sendMessage(
      content,
      toThreadNum(threadId),
      replyToMessageId !== undefined ? toMsgNum(replyToMessageId) : undefined,
    )
    return { ok: result.ok, messageId: toMsgStr(result.messageId) }
  }

  async editMessage(messageId: MessageId, content: string, threadId?: ThreadId): Promise<boolean> {
    return this.client.editMessage(toMsgNum(messageId), content, toThreadNum(threadId))
  }

  async deleteMessage(messageId: MessageId): Promise<void> {
    await this.client.deleteMessage(toMsgNum(messageId))
  }

  async pinMessage(messageId: MessageId): Promise<void> {
    await this.client.pinChatMessage(toMsgNum(messageId))
  }
}

// ── TelegramThreadManager ───────────────────────────────────────────

class TelegramThreadManager implements ThreadManager {
  constructor(private readonly client: TelegramClient) {}

  async createThread(name: string): Promise<ThreadInfo> {
    const topic = await this.client.createForumTopic(name)
    return { threadId: String(topic.message_thread_id), name: topic.name }
  }

  async editThread(threadId: ThreadId, name: string): Promise<void> {
    await this.client.editForumTopic(Number(threadId), name)
  }

  async closeThread(threadId: ThreadId): Promise<void> {
    await this.client.closeForumTopic(Number(threadId))
  }

  async deleteThread(threadId: ThreadId): Promise<void> {
    await this.client.deleteForumTopic(Number(threadId))
  }
}

// ── TelegramInputSource ─────────────────────────────────────────────

class TelegramInputSource implements ChatInputSource {
  private cursor = 0

  constructor(private readonly client: TelegramClient) {}

  async poll(cursor: string, timeoutSeconds: number): Promise<ChatUpdate[]> {
    this.cursor = Number(cursor) || 0
    const updates = await this.client.getUpdates(this.cursor, timeoutSeconds)
    const converted: ChatUpdate[] = []
    for (const u of updates) {
      const c = convertUpdate(u)
      if (c) converted.push(c)
    }
    return converted
  }

  getCursor(): string {
    return String(this.cursor)
  }

  advanceCursor(updates: ChatUpdate[]): void {
    if (updates.length === 0) return
    const lastMsg = updates[updates.length - 1]
    const lastId = lastMsg.type === "message"
      ? Number(lastMsg.message.messageId)
      : Number(lastMsg.query.queryId)
    // Telegram offset = last_update_id + 1, but ChatUpdate uses message IDs,
    // not update IDs. The poll() caller should track the raw offset externally
    // if needed. For now, advance past the highest known cursor.
    this.cursor = Math.max(this.cursor, lastId + 1)
  }
}

// ── TelegramInteractiveUI ───────────────────────────────────────────

class TelegramInteractiveUI implements InteractiveUI {
  constructor(private readonly client: TelegramClient) {}

  async sendMessageWithKeyboard(
    content: string,
    keyboard: KeyboardButton[][],
    threadId?: ThreadId,
  ): Promise<MessageId | null> {
    const tgKeyboard = keyboard.map((row) =>
      row.map((btn) => ({ text: btn.text, callback_data: btn.callbackData })),
    )
    const msgId = await this.client.sendMessageWithKeyboard(content, tgKeyboard, toThreadNum(threadId))
    return toMsgStr(msgId)
  }

  async answerCallbackQuery(queryId: string, text?: string): Promise<void> {
    await this.client.answerCallbackQuery(queryId, text)
  }
}

// ── TelegramFileHandler ─────────────────────────────────────────────

class TelegramFileHandler implements FileHandler {
  constructor(private readonly client: TelegramClient) {}

  async sendPhoto(photoPath: string, threadId?: ThreadId, caption?: string): Promise<MessageId | null> {
    const msgId = await this.client.sendPhoto(photoPath, toThreadNum(threadId), caption)
    return toMsgStr(msgId)
  }

  async sendPhotoBuffer(
    buffer: Buffer,
    filename: string,
    threadId?: ThreadId,
    caption?: string,
  ): Promise<MessageId | null> {
    const msgId = await this.client.sendPhotoBuffer(buffer, filename, toThreadNum(threadId), caption)
    return toMsgStr(msgId)
  }

  async downloadFile(fileId: string, destPath: string): Promise<boolean> {
    return this.client.downloadFile(fileId, destPath)
  }
}

// ── TelegramMessageFormatter ────────────────────────────────────────

class TelegramMessageFormatter implements MessageFormatter {
  readonly maxMessageLength = 4096

  format(blocks: import("../provider/message-formatter.js").ContentBlock[]): string {
    return blocks
      .map((block) => {
        switch (block.type) {
          case "text":
            return esc(block.text)
          case "code":
            return block.language
              ? `<pre><code class="language-${esc(block.language)}">${esc(block.code)}</code></pre>`
              : `<code>${esc(block.code)}</code>`
          case "bold":
            return `<b>${esc(block.text)}</b>`
          case "italic":
            return `<i>${esc(block.text)}</i>`
          case "link":
            return block.label
              ? `<a href="${esc(block.url)}">${esc(block.label)}</a>`
              : `<a href="${esc(block.url)}">${esc(block.url)}</a>`
          case "raw":
            return block.markup
        }
      })
      .join("")
  }

  escapeText(text: string): string {
    return esc(text)
  }
}

// ── TelegramPlatform ────────────────────────────────────────────────

export class TelegramPlatform implements ChatPlatform {
  readonly name = "telegram"
  readonly chat: ChatProvider
  readonly threads: ThreadManager
  readonly input: ChatInputSource
  readonly ui: InteractiveUI
  readonly files: FileHandler
  readonly formatter: MessageFormatter
  readonly chatId: string

  constructor(client: TelegramClient, chatId: string) {
    this.chatId = chatId
    this.chat = new TelegramChatProvider(client)
    this.threads = new TelegramThreadManager(client)
    this.input = new TelegramInputSource(client)
    this.ui = new TelegramInteractiveUI(client)
    this.files = new TelegramFileHandler(client)
    this.formatter = new TelegramMessageFormatter()
  }

  threadLink(threadId: string): string | undefined {
    const numericChatId = this.chatId.replace(/^-100/, "")
    return `https://t.me/c/${numericChatId}/${threadId}`
  }
}
