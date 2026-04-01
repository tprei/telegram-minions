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
  | { type: "quota_exhausted"; resetAt?: number; rawMessage: string }

// Session types

export type SessionDoneState = "completed" | "errored" | "quota_exhausted"
export type SessionState = "spawning" | "working" | "idle" | "completed" | "errored"

/**
 * Abstraction over different session backends (CLI subprocess, SDK streaming).
 * Enables the dispatcher to work uniformly regardless of the underlying session type.
 */
export interface SessionPort {
  /** Session metadata */
  readonly meta: SessionMeta

  /** Start the session with the given task and optional system prompt */
  start(task: string, systemPrompt?: string): void

  /** Inject a user reply into the running session (processed FIFO before the next tool call) */
  injectReply(text: string, images?: string[]): boolean

  /** Returns a promise that resolves when the session finishes (completes or errors) */
  waitForCompletion(): Promise<SessionDoneState>

  /** Whether the session process has exited */
  isClosed(): boolean

  /** Current session state */
  getState(): SessionState

  /** Whether the session is still actively running */
  isActive(): boolean

  /** Send SIGINT to gracefully interrupt the session */
  interrupt(): void

  /** Kill the session, escalating from SIGINT to SIGKILL after gracefulMs */
  kill(gracefulMs?: number): Promise<void>
}

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
  topicHandle?: string
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
  lastState?: "completed" | "errored" | "quota_exhausted"
  dagId?: string
  dagNodeId?: string
  pendingSplitItems?: { title: string; description: string }[]
  allSplitItems?: { title: string; description: string }[]
  pinnedMessageId?: number
  pendingDagItems?: PendingDagItem[]
  quotaRetryCount?: number
  quotaSleepUntil?: number
  autoAdvance?: AutoAdvance
  verificationState?: VerificationState
}

// Ship pipeline types

export type ShipPhase = "think" | "plan" | "judge" | "dag" | "verify" | "done"

export interface AutoAdvance {
  phase: ShipPhase
  featureDescription: string
  autoLand: boolean
}

// Verification types

export type VerificationCheckKind = "quality-gates" | "ci" | "completeness-review"

export type VerificationCheckStatus = "pending" | "running" | "passed" | "failed" | "skipped"

export interface VerificationCheck {
  kind: VerificationCheckKind
  status: VerificationCheckStatus
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
  status: "running" | "passed" | "failed"
}
