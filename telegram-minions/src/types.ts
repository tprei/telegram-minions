// Telegram Bot API types

export interface TelegramUser {
  id: number
  is_bot: boolean
  username?: string
  first_name?: string
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: { id: number; type: string }
  date: number
  text?: string
  message_thread_id?: number
  is_topic_message?: boolean
}

export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  message?: TelegramMessage
  data?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

export interface TelegramForumTopic {
  message_thread_id: number
  name: string
  icon_color: number
}

// Goose stream-json event types

export type GooseContentType =
  | GooseTextContent
  | GooseToolRequestContent
  | GooseToolResponseContent
  | GooseThinkingContent
  | GooseSystemNotificationContent
  | GooseNotificationContent
  | { type: string; [key: string]: unknown }

export interface GooseTextContent {
  type: "text"
  text: string
}

export interface GooseToolRequestContent {
  type: "toolRequest"
  id: string
  toolCall:
    | { name: string; arguments: Record<string, unknown> }
    | { error: string }
}

export interface GooseToolResponseContent {
  type: "toolResponse"
  id: string
  toolResult: unknown
}

export interface GooseThinkingContent {
  type: "thinking"
  thinking: string
  signature: string
}

export interface GooseSystemNotificationContent {
  type: "systemNotification"
  notificationType: "thinkingMessage" | "inlineMessage" | "creditsExhausted"
  msg: string
  data?: unknown
}

export interface GooseNotificationContent {
  type: "notification"
  extensionId: string
  message?: string
  progress?: number
  total?: number | null
}

export interface GooseMessage {
  id?: string | null
  role: "user" | "assistant"
  created: number
  content: GooseContentType[]
}

export type GooseStreamEvent =
  | { type: "message"; message: GooseMessage }
  | { type: "notification"; extensionId: string; message?: string; progress?: number; total?: number | null }
  | { type: "error"; error: string }
  | { type: "complete"; total_tokens: number | null }

// Session types

export type SessionState = "spawning" | "working" | "idle" | "completed" | "errored"

export interface SessionMeta {
  sessionId: string
  threadId: number
  topicName: string
  repo: string
  cwd: string
  startedAt: number
  totalTokens?: number
}
