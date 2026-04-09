// ChatPlatform — the bundle interface that combines all provider capabilities.
//
// A platform adapter creates a ChatPlatform instance that the Dispatcher
// and Observer depend on. Required capabilities are always present;
// optional ones are checked at runtime with null guards.
//
// Example usage:
//
//   const platform = createTelegramPlatform(config)
//   const dispatcher = new Dispatcher(platform, ...)
//
//   // Required — always available:
//   await platform.chat.sendMessage("Hello", threadId)
//   await platform.threads.createThread("new-task")
//   const updates = await platform.input.poll(cursor, 30)
//
//   // Optional — check before using:
//   if (platform.ui) {
//     await platform.ui.sendMessageWithKeyboard(text, keyboard, threadId)
//   }

import type { ChatProvider } from "./chat-provider.js"
import type { ThreadManager } from "./thread-manager.js"
import type { ChatInputSource } from "./input-source.js"
import type { InteractiveUI } from "./interactive-ui.js"
import type { FileHandler } from "./file-handler.js"
import type { MessageFormatter } from "./message-formatter.js"

export interface ChatPlatform {
  /** Unique identifier for this platform (e.g. "telegram", "discord", "slack"). */
  readonly name: string

  // ── Required capabilities ────────────────────────────────────────

  /** Core messaging: send, edit, delete, pin. */
  readonly chat: ChatProvider

  /** Thread/topic lifecycle: create, rename, close, delete. */
  readonly threads: ThreadManager

  /** Input polling/receiving: updates, messages, callbacks. */
  readonly input: ChatInputSource

  // ── Optional capabilities ────────────────────────────────────────

  /** Interactive elements: inline keyboards, callback queries. Null if unsupported. */
  readonly ui: InteractiveUI | null

  /** File uploads/downloads: photos, attachments. Null if unsupported. */
  readonly files: FileHandler | null

  /** Message format conversion. Null = content is passed through as-is. */
  readonly formatter: MessageFormatter | null

  // ── Platform metadata ────────────────────────────────────────────

  /**
   * The chat/server/workspace ID this platform instance is bound to.
   * For Telegram: the chat_id. For Discord: the guild ID. For Slack: the workspace ID.
   */
  readonly chatId: string

  /**
   * Generate a deep link to a specific thread on this platform.
   * Returns undefined if the platform doesn't support deep links.
   */
  threadLink(threadId: string): string | undefined
}
