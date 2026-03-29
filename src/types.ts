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

export type SessionMode = "task" | "plan" | "think" | "review" | "ci-fix" | "dag-review" | "ship-think" | "ship-plan" | "ship-verify"

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

/** DAG item extracted from conversation, pending user review before execution */
export interface PendingDagItem {
  id: string
  title: string
  description: string
  dependsOn: string[]
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
  branch?: string
  prUrl?: string
  lastState?: "completed" | "errored"
  dagId?: string
  dagNodeId?: string
  pendingSplitItems?: { title: string; description: string }[]
  allSplitItems?: { title: string; description: string }[]
  pinnedMessageId?: number
  pendingDagItems?: PendingDagItem[]
  autoAdvance?: AutoAdvance
}

// Ship pipeline types

/** Tracks the auto-advance state for the /ship pipeline: think → plan → dag → verify → land */
export type ShipPhase = "think" | "plan" | "dag" | "verify" | "done"

export interface AutoAdvance {
  /** The current phase in the ship pipeline */
  phase: ShipPhase
  /** Original feature description from the /ship command */
  featureDescription: string
  /** Whether to auto-land after verification passes */
  autoLand: boolean
}

// Verification types

export type VerificationCheckKind = "quality-gates" | "ci" | "completeness-review"

export type VerificationCheckStatus = "pending" | "running" | "passed" | "failed" | "skipped"

export interface VerificationCheck {
  kind: VerificationCheckKind
  status: VerificationCheckStatus
  /** Which DAG node this check applies to */
  nodeId: string
  output?: string
  startedAt?: number
  finishedAt?: number
}

export interface VerificationRound {
  round: number
  checks: VerificationCheck[]
  startedAt: number
  finishedAt?: number
}

export interface VerificationState {
  dagId: string
  maxRounds: number
  rounds: VerificationRound[]
  /** Overall status: running while rounds are active, passed when all green, failed when max rounds exhausted */
  status: "running" | "passed" | "failed"
}
