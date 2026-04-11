// LocalPlatform — ChatPlatform adapter for TUI and custom web UI usage.
//
// Provides an in-memory implementation of ChatPlatform that:
// - Stores messages and threads in memory
// - Emits events when messages are sent/edited/deleted so UIs can render
// - Accepts input via a push queue (no network polling)
// - Uses plain text formatting (no HTML markup)
//
// Usage:
//
//   const platform = new LocalPlatform("local-1")
//   const dispatcher = new Dispatcher(platform, ...)
//
//   // Push a command as if a user typed it:
//   platform.pushUpdate({ type: "message", message: { ... } })
//
//   // Listen for outgoing messages:
//   platform.events.on("message_sent", (evt) => console.log(evt.content))

import { EventEmitter } from "node:events"
import type { ChatPlatform } from "../provider/chat-platform.js"
import type { ChatProvider } from "../provider/chat-provider.js"
import type { ThreadManager } from "../provider/thread-manager.js"
import type { ChatInputSource } from "../provider/input-source.js"
import type { InteractiveUI } from "../provider/interactive-ui.js"
import type { FileHandler } from "../provider/file-handler.js"
import type { MessageFormatter, ContentBlock } from "../provider/message-formatter.js"
import type {
  MessageId,
  ThreadId,
  SendResult,
  ThreadInfo,
  KeyboardButton,
  ChatUpdate,
} from "../provider/types.js"

// ── Event types emitted by LocalPlatform ─────────────────────────────

export interface MessageSentEvent {
  messageId: MessageId
  threadId?: ThreadId
  content: string
  replyToMessageId?: MessageId
}

export interface MessageEditedEvent {
  messageId: MessageId
  threadId?: ThreadId
  content: string
}

export interface MessageDeletedEvent {
  messageId: MessageId
}

export interface MessagePinnedEvent {
  messageId: MessageId
}

export interface ThreadCreatedEvent {
  threadId: ThreadId
  name: string
}

export interface ThreadEditedEvent {
  threadId: ThreadId
  name: string
}

export interface ThreadClosedEvent {
  threadId: ThreadId
}

export interface ThreadDeletedEvent {
  threadId: ThreadId
}

export interface KeyboardSentEvent {
  messageId: MessageId
  threadId?: ThreadId
  content: string
  keyboard: KeyboardButton[][]
}

export interface LocalPlatformEvents {
  message_sent: [MessageSentEvent]
  message_edited: [MessageEditedEvent]
  message_deleted: [MessageDeletedEvent]
  message_pinned: [MessagePinnedEvent]
  thread_created: [ThreadCreatedEvent]
  thread_edited: [ThreadEditedEvent]
  thread_closed: [ThreadClosedEvent]
  thread_deleted: [ThreadDeletedEvent]
  keyboard_sent: [KeyboardSentEvent]
}

// ── LocalChatProvider ────────────────────────────────────────────────

class LocalChatProvider implements ChatProvider {
  private nextMessageId = 1

  constructor(private readonly events: EventEmitter) {}

  async sendMessage(
    content: string,
    threadId?: ThreadId,
    replyToMessageId?: MessageId,
  ): Promise<SendResult> {
    const messageId = String(this.nextMessageId++)
    this.events.emit("message_sent", {
      messageId,
      threadId,
      content,
      replyToMessageId,
    } satisfies MessageSentEvent)
    return { ok: true, messageId }
  }

  async editMessage(
    messageId: MessageId,
    content: string,
    threadId?: ThreadId,
  ): Promise<boolean> {
    this.events.emit("message_edited", {
      messageId,
      content,
      threadId,
    } satisfies MessageEditedEvent)
    return true
  }

  async deleteMessage(messageId: MessageId): Promise<void> {
    this.events.emit("message_deleted", {
      messageId,
    } satisfies MessageDeletedEvent)
  }

  async pinMessage(messageId: MessageId): Promise<void> {
    this.events.emit("message_pinned", {
      messageId,
    } satisfies MessagePinnedEvent)
  }
}

// ── LocalThreadManager ───────────────────────────────────────────────

class LocalThreadManager implements ThreadManager {
  private nextThreadId = 1

  constructor(private readonly events: EventEmitter) {}

  async createThread(name: string): Promise<ThreadInfo> {
    const threadId = String(this.nextThreadId++)
    this.events.emit("thread_created", {
      threadId,
      name,
    } satisfies ThreadCreatedEvent)
    return { threadId, name }
  }

  async editThread(threadId: ThreadId, name: string): Promise<void> {
    this.events.emit("thread_edited", {
      threadId,
      name,
    } satisfies ThreadEditedEvent)
  }

  async closeThread(threadId: ThreadId): Promise<void> {
    this.events.emit("thread_closed", {
      threadId,
    } satisfies ThreadClosedEvent)
  }

  async deleteThread(threadId: ThreadId): Promise<void> {
    this.events.emit("thread_deleted", {
      threadId,
    } satisfies ThreadDeletedEvent)
  }
}

// ── LocalInputSource ─────────────────────────────────────────────────

class LocalInputSource implements ChatInputSource {
  private cursor = 0
  private readonly queue: ChatUpdate[] = []
  private pendingResolve: ((updates: ChatUpdate[]) => void) | null = null

  push(update: ChatUpdate): void {
    if (this.pendingResolve) {
      const resolve = this.pendingResolve
      this.pendingResolve = null
      this.cursor++
      resolve([update])
    } else {
      this.queue.push(update)
    }
  }

  async poll(_cursor: string, timeoutSeconds: number): Promise<ChatUpdate[]> {
    if (this.queue.length > 0) {
      const batch = this.queue.splice(0)
      this.cursor += batch.length
      return batch
    }

    if (timeoutSeconds <= 0) return []

    return new Promise<ChatUpdate[]>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingResolve = null
        resolve([])
      }, timeoutSeconds * 1000)

      this.pendingResolve = (updates) => {
        clearTimeout(timer)
        resolve(updates)
      }
    })
  }

  getCursor(): string {
    return String(this.cursor)
  }

  advanceCursor(): void {
    // Cursor is auto-advanced during poll/push.
  }
}

// ── LocalInteractiveUI ───────────────────────────────────────────────

class LocalInteractiveUI implements InteractiveUI {
  private nextMessageId: () => string

  constructor(
    private readonly events: EventEmitter,
    nextMessageIdFn: () => string,
  ) {
    this.nextMessageId = nextMessageIdFn
  }

  async sendMessageWithKeyboard(
    content: string,
    keyboard: KeyboardButton[][],
    threadId?: ThreadId,
  ): Promise<MessageId | null> {
    const messageId = this.nextMessageId()
    this.events.emit("keyboard_sent", {
      messageId,
      threadId,
      content,
      keyboard,
    } satisfies KeyboardSentEvent)
    return messageId
  }

  async answerCallbackQuery(): Promise<void> {
    // No-op for local platform — UI handles callback acknowledgement directly.
  }
}

// ── LocalMessageFormatter ────────────────────────────────────────────

class LocalMessageFormatter implements MessageFormatter {
  readonly maxMessageLength = 65536

  format(blocks: ContentBlock[]): string {
    return blocks
      .map((block) => {
        switch (block.type) {
          case "text":
            return block.text
          case "code":
            return block.language
              ? `\`\`\`${block.language}\n${block.code}\n\`\`\``
              : `\`${block.code}\``
          case "bold":
            return `**${block.text}**`
          case "italic":
            return `_${block.text}_`
          case "link":
            return block.label ? `[${block.label}](${block.url})` : block.url
          case "raw":
            return block.markup
        }
      })
      .join("")
  }

  escapeText(text: string): string {
    return text
  }
}

// ── LocalPlatform ────────────────────────────────────────────────────

export class LocalPlatform implements ChatPlatform {
  readonly name = "local"
  readonly chat: ChatProvider
  readonly threads: ThreadManager
  readonly input: ChatInputSource & { push(update: ChatUpdate): void }
  readonly ui: InteractiveUI
  readonly files: FileHandler | null = null
  readonly formatter: MessageFormatter
  readonly chatId: string
  readonly events: EventEmitter

  constructor(chatId: string) {
    this.chatId = chatId
    this.events = new EventEmitter()

    const chatProvider = new LocalChatProvider(this.events)
    this.chat = chatProvider
    this.threads = new LocalThreadManager(this.events)
    this.input = new LocalInputSource()

    // Share message ID counter between chat provider and interactive UI
    let sharedMessageId = 1000
    this.ui = new LocalInteractiveUI(this.events, () => String(sharedMessageId++))
    this.formatter = new LocalMessageFormatter()
  }

  threadLink(threadId: string): string | undefined {
    return `local://thread/${threadId}`
  }

  pushUpdate(update: ChatUpdate): void {
    this.input.push(update)
  }
}
