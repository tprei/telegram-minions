// Telegram Bot API types

export interface TelegramUser {
  id: number
  is_bot: boolean
  username?: string
  first_name?: string
}

export interface TelegramPhotoSize {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: { id: number; type: string }
  date: number
  text?: string
  caption?: string
  photo?: TelegramPhotoSize[]
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

export type SessionMode = "task" | "plan" | "think" | "review" | "ci-fix"

export interface SessionMeta {
  sessionId: string
  threadId: number
  topicName: string
  repo: string
  cwd: string
  startedAt: number
  totalTokens?: number
  mode: SessionMode
  screenshotDir?: string
}

// Topic session types (used for both plan and task modes)

export interface TopicMessage {
  role: "user" | "assistant"
  text: string
  images?: string[]
}

export interface TopicSession {
  threadId: number
  repo: string
  repoUrl?: string
  cwd: string
  slug: string
  conversation: TopicMessage[]
  activeSessionId?: string
  pendingFeedback: string[]
  mode: SessionMode
  lastActivityAt: number
  profileId?: string
  parentThreadId?: number
  childThreadIds?: number[]
  splitLabel?: string
  interruptedAt?: number
  stack?: StackMetadata
}

// Stack types for dependent minions (DAG-based)

export type StackNodeStatus = "pending" | "running" | "completed" | "errored" | "blocked" | "merged"

export type StackExecutionMode = "sequential" | "parallel" | "auto"

export type StackMergeStrategy = "manual" | "auto" | "merge-queue"

export interface StackNode {
  id: string
  title: string
  description: string
  /** IDs of nodes this node depends on (must complete first) */
  dependencies: string[]
  /** Branch name for this node */
  branch?: string
  /** Worktree path for this node */
  worktree?: string
  /** Thread ID if spawned */
  threadId?: number
  /** PR URL if created */
  prUrl?: string
  /** Current status */
  status: StackNodeStatus
  /** Error message if failed */
  error?: string
}

export interface StackMetadata {
  /** Unique stack identifier */
  stackId: string
  /** Human-readable slug for the stack */
  slug: string
  /** All nodes in the stack */
  nodes: Map<string, StackNode>
  /** Execution mode */
  mode: StackExecutionMode
  /** Merge strategy */
  mergeStrategy: StackMergeStrategy
  /** Parent thread ID that owns this stack */
  parentThreadId: number
  /** Repository URL */
  repoUrl?: string
  /** Created timestamp */
  createdAt: number
}
