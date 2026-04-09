// Provider-agnostic types for multi-platform chat abstraction.
//
// All IDs are opaque strings. Platform adapters convert native IDs
// (e.g. Telegram's numeric thread/message IDs) at the boundary.

/** Opaque identifier for a thread/topic/channel within a chat platform. */
export type ThreadId = string

/** Opaque identifier for a single message within a thread. */
export type MessageId = string

/** Result of sending a message. */
export interface SendResult {
  ok: boolean
  messageId: MessageId | null
}

/** A thread/topic created by the platform. */
export interface ThreadInfo {
  threadId: ThreadId
  name: string
}

/** A button in an inline keyboard row. */
export interface KeyboardButton {
  text: string
  callbackData: string
}

/** A user who authored a message or triggered a callback. */
export interface ChatUser {
  id: string
  isBot: boolean
  username?: string
  displayName?: string
}

/** An image attachment on an incoming message. */
export interface ChatPhoto {
  /** Platform-specific file identifier for downloading. */
  fileId: string
  width: number
  height: number
  fileSize?: number
}

/** A platform-agnostic incoming message. */
export interface IncomingMessage {
  messageId: MessageId
  threadId?: ThreadId
  from?: ChatUser
  text?: string
  caption?: string
  photos?: ChatPhoto[]
  timestamp: number
}

/** A platform-agnostic callback query (button press). */
export interface CallbackQuery {
  queryId: string
  from: ChatUser
  messageId?: MessageId
  threadId?: ThreadId
  data?: string
}

/** A platform-agnostic incoming update — either a message or callback. */
export type ChatUpdate =
  | { type: "message"; message: IncomingMessage }
  | { type: "callback_query"; query: CallbackQuery }
