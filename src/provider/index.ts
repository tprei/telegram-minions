// Provider interfaces — multi-platform chat abstraction.
//
// These interfaces define the contract boundaries that platform adapters
// (Telegram, Discord, Slack, custom UIs) implement. The orchestration
// layer depends on these interfaces, never on platform-specific code.

export type { ChatProvider } from "./chat-provider.js"
export type { ThreadManager } from "./thread-manager.js"
export type { ChatInputSource } from "./input-source.js"
export type { InteractiveUI } from "./interactive-ui.js"
export type { FileHandler } from "./file-handler.js"
export type { MessageFormatter, ContentBlock } from "./message-formatter.js"
export type { ChatPlatform } from "./chat-platform.js"

export type {
  ThreadId,
  MessageId,
  SendResult,
  ThreadInfo,
  KeyboardButton,
  ChatUser,
  ChatPhoto,
  IncomingMessage,
  CallbackQuery,
  ChatUpdate,
} from "./types.js"
