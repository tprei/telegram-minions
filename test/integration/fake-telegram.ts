import type {
  TelegramUpdate,
  TelegramForumTopic,
  TelegramMessage,
} from "../../src/types.js"

/** A recorded call to any FakeTelegram method. */
export interface TelegramCall {
  method: string
  args: unknown[]
  timestamp: number
}

/** A message stored in FakeTelegram's in-memory ledger. */
export interface StoredMessage {
  messageId: number
  html: string
  threadId?: number
  replyToMessageId?: number
  keyboard?: { text: string; callback_data: string }[][]
  editHistory: string[]
}

/** A photo stored in FakeTelegram's in-memory ledger. */
export interface StoredPhoto {
  messageId: number
  threadId?: number
  caption?: string
  source: "path" | "buffer"
  ref: string // file path or filename
}

/** A forum topic stored in FakeTelegram's in-memory ledger. */
export interface StoredTopic {
  threadId: number
  name: string
  closed: boolean
  deleted: boolean
}

type WaitPredicate = (call: TelegramCall) => boolean

/**
 * In-memory fake of TelegramClient for integration tests.
 *
 * - Records every method call for assertion
 * - Stores messages, photos, and topics in queryable ledgers
 * - Provides `waitFor*` helpers that resolve when a matching call arrives
 * - Feeds scripted TelegramUpdate[] via `enqueueUpdates()`
 */
export class FakeTelegram {
  /** All recorded calls, in order. */
  readonly calls: TelegramCall[] = []

  /** Messages keyed by messageId. */
  readonly messages = new Map<number, StoredMessage>()

  /** Photos keyed by messageId. */
  readonly photos = new Map<number, StoredPhoto>()

  /** Forum topics keyed by threadId. */
  readonly topics = new Map<number, StoredTopic>()

  /** Deleted message IDs. */
  readonly deletedMessageIds = new Set<number>()

  /** Pinned message IDs. */
  readonly pinnedMessageIds = new Set<number>()

  private nextMessageId = 1
  private nextThreadId = 100
  private nextUpdateId = 1

  private readonly updateQueue: TelegramUpdate[][] = []
  private waiters: { predicate: WaitPredicate; resolve: (call: TelegramCall) => void }[] = []

  // ---------------------------------------------------------------------------
  // Update injection (for Dispatcher polling)
  // ---------------------------------------------------------------------------

  /** Queue a batch of updates that getUpdates will return on the next poll. */
  enqueueUpdates(...updates: TelegramUpdate[]): void {
    this.updateQueue.push(updates)
  }

  /** Build a simple text message update. */
  makeTextUpdate(text: string, opts: { threadId?: number; userId?: number } = {}): TelegramUpdate {
    const messageId = this.nextMessageId++
    const msg: TelegramMessage = {
      message_id: messageId,
      from: { id: opts.userId ?? 1, is_bot: false, first_name: "Test" },
      chat: { id: 1, type: "supergroup" },
      date: Math.floor(Date.now() / 1000),
      text,
    }
    if (opts.threadId !== undefined) {
      msg.message_thread_id = opts.threadId
      msg.is_topic_message = true
    }
    return { update_id: this.nextUpdateId++, message: msg }
  }

  /** Build a callback query update. */
  makeCallbackUpdate(data: string, opts: { messageId?: number; userId?: number } = {}): TelegramUpdate {
    const updateId = this.nextUpdateId++
    return {
      update_id: updateId,
      callback_query: {
        id: String(updateId),
        from: { id: opts.userId ?? 1, is_bot: false, first_name: "Test" },
        data,
        message: opts.messageId
          ? {
              message_id: opts.messageId,
              chat: { id: 1, type: "supergroup" },
              date: Math.floor(Date.now() / 1000),
            }
          : undefined,
      },
    }
  }

  // ---------------------------------------------------------------------------
  // TelegramClient-compatible public methods
  // ---------------------------------------------------------------------------

  async getUpdates(offset: number, _timeout: number): Promise<TelegramUpdate[]> {
    this.record("getUpdates", [offset, _timeout])
    const batch = this.updateQueue.shift()
    return batch ?? []
  }

  async sendMessage(
    html: string,
    threadId?: number,
    replyToMessageId?: number,
  ): Promise<{ ok: boolean; messageId: number | null }> {
    this.record("sendMessage", [html, threadId, replyToMessageId])
    const messageId = this.nextMessageId++
    this.messages.set(messageId, {
      messageId,
      html,
      threadId,
      replyToMessageId,
      editHistory: [],
    })
    return { ok: true, messageId }
  }

  async editMessage(messageId: number, html: string, threadId?: number): Promise<boolean> {
    this.record("editMessage", [messageId, html, threadId])
    const existing = this.messages.get(messageId)
    if (existing) {
      existing.editHistory.push(existing.html)
      existing.html = html
    }
    return true
  }

  async createForumTopic(name: string): Promise<TelegramForumTopic> {
    this.record("createForumTopic", [name])
    const threadId = this.nextThreadId++
    const topic: StoredTopic = { threadId, name: name.slice(0, 128), closed: false, deleted: false }
    this.topics.set(threadId, topic)
    return { message_thread_id: threadId, name: topic.name, icon_color: 0 }
  }

  async editForumTopic(threadId: number, name: string): Promise<void> {
    this.record("editForumTopic", [threadId, name])
    const topic = this.topics.get(threadId)
    if (topic) topic.name = name.slice(0, 128)
  }

  async pinChatMessage(messageId: number): Promise<void> {
    this.record("pinChatMessage", [messageId])
    this.pinnedMessageIds.add(messageId)
  }

  async closeForumTopic(threadId: number): Promise<void> {
    this.record("closeForumTopic", [threadId])
    const topic = this.topics.get(threadId)
    if (topic) topic.closed = true
  }

  async sendMessageWithKeyboard(
    html: string,
    keyboard: { text: string; callback_data: string }[][],
    threadId?: number,
  ): Promise<number | null> {
    this.record("sendMessageWithKeyboard", [html, keyboard, threadId])
    const messageId = this.nextMessageId++
    this.messages.set(messageId, {
      messageId,
      html,
      threadId,
      keyboard,
      editHistory: [],
    })
    return messageId
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    this.record("answerCallbackQuery", [callbackQueryId, text])
  }

  async deleteMessage(messageId: number): Promise<void> {
    this.record("deleteMessage", [messageId])
    this.deletedMessageIds.add(messageId)
    this.messages.delete(messageId)
  }

  async deleteForumTopic(threadId: number): Promise<void> {
    this.record("deleteForumTopic", [threadId])
    const topic = this.topics.get(threadId)
    if (topic) topic.deleted = true
  }

  async sendPhoto(photoPath: string, threadId?: number, caption?: string): Promise<number | null> {
    this.record("sendPhoto", [photoPath, threadId, caption])
    const messageId = this.nextMessageId++
    this.photos.set(messageId, { messageId, threadId, caption, source: "path", ref: photoPath })
    return messageId
  }

  async sendPhotoBuffer(
    buffer: Buffer,
    filename: string,
    threadId?: number,
    caption?: string,
  ): Promise<number | null> {
    this.record("sendPhotoBuffer", [buffer, filename, threadId, caption])
    const messageId = this.nextMessageId++
    this.photos.set(messageId, { messageId, threadId, caption, source: "buffer", ref: filename })
    return messageId
  }

  async downloadFile(fileId: string, destPath: string): Promise<boolean> {
    this.record("downloadFile", [fileId, destPath])
    return false
  }

  // ---------------------------------------------------------------------------
  // Query helpers
  // ---------------------------------------------------------------------------

  /** Get all calls to a specific method. */
  callsTo(method: string): TelegramCall[] {
    return this.calls.filter((c) => c.method === method)
  }

  /** Get all messages sent to a specific thread. */
  messagesInThread(threadId: number): StoredMessage[] {
    return [...this.messages.values()].filter((m) => m.threadId === threadId)
  }

  /** Get the most recent message (by insertion order). */
  lastMessage(): StoredMessage | undefined {
    const values = [...this.messages.values()]
    return values[values.length - 1]
  }

  /** Get all HTML content sent via sendMessage (flat list). */
  sentHtml(): string[] {
    return this.callsTo("sendMessage").map((c) => c.args[0] as string)
  }

  /** Check whether any sent message contains the given substring. */
  hasSentContaining(substring: string): boolean {
    return this.sentHtml().some((html) => html.includes(substring))
  }

  // ---------------------------------------------------------------------------
  // Event-driven wait helpers (for async assertion synchronization)
  // ---------------------------------------------------------------------------

  /**
   * Wait for a call matching the predicate. Resolves immediately if a past
   * call already matches, otherwise waits up to `timeoutMs`.
   */
  waitFor(predicate: WaitPredicate, timeoutMs = 5000): Promise<TelegramCall> {
    const existing = this.calls.find(predicate)
    if (existing) return Promise.resolve(existing)

    return new Promise<TelegramCall>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve)
        reject(new Error(`FakeTelegram.waitFor timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.waiters.push({
        predicate,
        resolve: (call) => {
          clearTimeout(timer)
          resolve(call)
        },
      })
    })
  }

  /** Wait for a sendMessage call whose HTML contains the given substring. */
  waitForMessage(substring: string, timeoutMs = 5000): Promise<TelegramCall> {
    return this.waitFor(
      (c) => c.method === "sendMessage" && String(c.args[0]).includes(substring),
      timeoutMs,
    )
  }

  /** Wait for a sendMessage call to a specific thread. */
  waitForMessageInThread(threadId: number, timeoutMs = 5000): Promise<TelegramCall> {
    return this.waitFor(
      (c) => c.method === "sendMessage" && c.args[1] === threadId,
      timeoutMs,
    )
  }

  /** Wait for a createForumTopic call. */
  waitForTopicCreation(timeoutMs = 5000): Promise<TelegramCall> {
    return this.waitFor((c) => c.method === "createForumTopic", timeoutMs)
  }

  /** Wait for N total calls to a method. */
  waitForCallCount(method: string, count: number, timeoutMs = 5000): Promise<TelegramCall> {
    return this.waitFor(
      () => this.callsTo(method).length >= count,
      timeoutMs,
    )
  }

  /** Reset all state — useful between tests. */
  reset(): void {
    this.calls.length = 0
    this.messages.clear()
    this.photos.clear()
    this.topics.clear()
    this.deletedMessageIds.clear()
    this.pinnedMessageIds.clear()
    this.updateQueue.length = 0
    this.waiters = []
    this.nextMessageId = 1
    this.nextThreadId = 100
    this.nextUpdateId = 1
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private record(method: string, args: unknown[]): void {
    const call: TelegramCall = { method, args, timestamp: Date.now() }
    this.calls.push(call)
    this.notifyWaiters(call)
  }

  private notifyWaiters(call: TelegramCall): void {
    const matched: typeof this.waiters = []
    const remaining: typeof this.waiters = []

    for (const waiter of this.waiters) {
      if (waiter.predicate(call)) {
        matched.push(waiter)
      } else {
        remaining.push(waiter)
      }
    }

    this.waiters = remaining
    for (const waiter of matched) {
      waiter.resolve(call)
    }
  }
}
