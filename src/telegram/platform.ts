// TelegramPlatform — adapts TelegramClient to the provider interfaces.
//
// Each adapter class converts between Telegram's numeric IDs and the
// provider's opaque string IDs at the boundary. TelegramClient itself
// is not modified — the adapters delegate every call to it.

import type { TelegramClient } from "./telegram.js"
import type { TelegramUpdate } from "../domain/telegram-types.js"
import type { ChatProvider } from "../provider/chat-provider.js"
import type { ThreadManager } from "../provider/thread-manager.js"
import type { ChatInputSource } from "../provider/input-source.js"
import type { InteractiveUI } from "../provider/interactive-ui.js"
import type { FileHandler } from "../provider/file-handler.js"
import type { MessageFormatter, ContentBlock } from "../provider/message-formatter.js"
import type { ChatPlatform } from "../provider/chat-platform.js"
import type {
  ThreadId,
  MessageId,
  SendResult,
  ThreadInfo,
  KeyboardButton,
  ChatUpdate,
} from "../provider/types.js"

// ── ID conversion helpers ────────────────────────────────────────────

function toNumericThread(threadId?: ThreadId): number | undefined {
  return threadId !== undefined ? Number(threadId) : undefined
}

function toNumericMessage(messageId: MessageId): number {
  return Number(messageId)
}

function toStringId(n: number | null): string | null {
  return n !== null ? String(n) : null
}

// ── Update conversion ────────────────────────────────────────────────

function convertUpdate(update: TelegramUpdate): ChatUpdate | null {
  if (update.message) {
    const msg = update.message
    return {
      type: "message",
      message: {
        messageId: String(msg.message_id),
        threadId: msg.message_thread_id !== undefined ? String(msg.message_thread_id) : undefined,
        from: msg.from
          ? {
              id: String(msg.from.id),
              isBot: msg.from.is_bot,
              username: msg.from.username,
              displayName: msg.from.first_name,
            }
          : undefined,
        text: msg.text,
        caption: msg.caption,
        photos: msg.photo?.map((p) => ({
          fileId: p.file_id,
          width: p.width,
          height: p.height,
          fileSize: p.file_size,
        })),
        timestamp: msg.date,
      },
    }
  }

  if (update.callback_query) {
    const cb = update.callback_query
    const cbMsg = cb.message
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
        messageId: cbMsg ? String(cbMsg.message_id) : undefined,
        threadId: cbMsg?.message_thread_id !== undefined ? String(cbMsg.message_thread_id) : undefined,
        data: cb.data,
      },
    }
  }

  return null
}

// ── Adapter classes ──────────────────────────────────────────────────

export class TelegramChatProvider implements ChatProvider {
  constructor(private readonly client: TelegramClient) {}

  async sendMessage(
    content: string,
    threadId?: ThreadId,
    replyToMessageId?: MessageId,
  ): Promise<SendResult> {
    const result = await this.client.sendMessage(
      content,
      toNumericThread(threadId),
      replyToMessageId !== undefined ? toNumericMessage(replyToMessageId) : undefined,
    )
    return { ok: result.ok, messageId: toStringId(result.messageId) }
  }

  async editMessage(messageId: MessageId, content: string, threadId?: ThreadId): Promise<boolean> {
    return this.client.editMessage(toNumericMessage(messageId), content, toNumericThread(threadId))
  }

  async deleteMessage(messageId: MessageId): Promise<void> {
    await this.client.deleteMessage(toNumericMessage(messageId))
  }

  async pinMessage(messageId: MessageId): Promise<void> {
    await this.client.pinChatMessage(toNumericMessage(messageId))
  }
}

export class TelegramThreadManager implements ThreadManager {
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

export class TelegramInputSource implements ChatInputSource {
  private offset = 0

  constructor(private readonly client: TelegramClient) {}

  async poll(cursor: string, timeoutSeconds: number): Promise<ChatUpdate[]> {
    this.offset = Number(cursor) || 0
    const updates = await this.client.getUpdates(this.offset, timeoutSeconds)
    const converted: ChatUpdate[] = []
    for (const u of updates) {
      const c = convertUpdate(u)
      if (c) converted.push(c)
    }
    return converted
  }

  getCursor(): string {
    return String(this.offset)
  }

  advanceCursor(updates: ChatUpdate[]): void {
    // Telegram offsets are based on update_id. Since we've lost the raw
    // update_id during conversion, we advance by the count of updates.
    // The caller is responsible for calling poll() with the new cursor.
    // In practice, Telegram's getUpdates already advances past returned
    // updates when called with offset = last_update_id + 1. We track
    // this by incrementing offset by the batch size.
    this.offset += updates.length
  }
}

export class TelegramInteractiveUI implements InteractiveUI {
  constructor(private readonly client: TelegramClient) {}

  async sendMessageWithKeyboard(
    content: string,
    keyboard: KeyboardButton[][],
    threadId?: ThreadId,
  ): Promise<MessageId | null> {
    const telegramKb = keyboard.map((row) =>
      row.map((btn) => ({ text: btn.text, callback_data: btn.callbackData })),
    )
    const msgId = await this.client.sendMessageWithKeyboard(
      content,
      telegramKb,
      toNumericThread(threadId),
    )
    return toStringId(msgId)
  }

  async answerCallbackQuery(queryId: string, text?: string): Promise<void> {
    await this.client.answerCallbackQuery(queryId, text)
  }
}

export class TelegramFileHandler implements FileHandler {
  constructor(private readonly client: TelegramClient) {}

  async sendPhoto(photoPath: string, threadId?: ThreadId, caption?: string): Promise<MessageId | null> {
    const msgId = await this.client.sendPhoto(photoPath, toNumericThread(threadId), caption)
    return toStringId(msgId)
  }

  async sendPhotoBuffer(
    buffer: Buffer,
    filename: string,
    threadId?: ThreadId,
    caption?: string,
  ): Promise<MessageId | null> {
    const msgId = await this.client.sendPhotoBuffer(buffer, filename, toNumericThread(threadId), caption)
    return toStringId(msgId)
  }

  async downloadFile(fileId: string, destPath: string): Promise<boolean> {
    return this.client.downloadFile(fileId, destPath)
  }
}

export class TelegramFormatter implements MessageFormatter {
  readonly maxMessageLength = 4096

  format(blocks: ContentBlock[]): string {
    return blocks
      .map((block) => {
        switch (block.type) {
          case "text":
            return this.escapeText(block.text)
          case "code":
            return block.language
              ? `<pre><code class="language-${this.escapeText(block.language)}">${this.escapeText(block.code)}</code></pre>`
              : `<code>${this.escapeText(block.code)}</code>`
          case "bold":
            return `<b>${this.escapeText(block.text)}</b>`
          case "italic":
            return `<i>${this.escapeText(block.text)}</i>`
          case "link":
            return block.label
              ? `<a href="${this.escapeText(block.url)}">${this.escapeText(block.label)}</a>`
              : this.escapeText(block.url)
          case "raw":
            return block.markup
        }
      })
      .join("")
  }

  escapeText(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  }
}

// ── Platform bundle ──────────────────────────────────────────────────

export class TelegramPlatform implements ChatPlatform {
  readonly name = "telegram"
  readonly chat: TelegramChatProvider
  readonly threads: TelegramThreadManager
  readonly input: TelegramInputSource
  readonly ui: TelegramInteractiveUI
  readonly files: TelegramFileHandler
  readonly formatter: TelegramFormatter
  readonly chatId: string

  constructor(client: TelegramClient, chatId: string) {
    this.chat = new TelegramChatProvider(client)
    this.threads = new TelegramThreadManager(client)
    this.input = new TelegramInputSource(client)
    this.ui = new TelegramInteractiveUI(client)
    this.files = new TelegramFileHandler(client)
    this.formatter = new TelegramFormatter()
    this.chatId = chatId
  }

  threadLink(threadId: string): string | undefined {
    if (!this.chatId || !threadId) return undefined
    const raw = this.chatId.replace(/^-100/, "")
    return `https://t.me/c/${raw}/${threadId}`
  }
}

/** Factory function matching the ChatPlatform contract example in chat-platform.ts. */
export function createTelegramPlatform(client: TelegramClient, chatId: string): TelegramPlatform {
  return new TelegramPlatform(client, chatId)
}
