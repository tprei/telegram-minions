import type {
  TopicMessage,
  TopicSession,
  SessionMode,
  AutoAdvance,
  VerificationState,
  PendingDagItem,
  ThreadId,
  MessageId,
} from "./session-types.js"
import { truncateConversation } from "../conversation-limits.js"

/**
 * Domain aggregate wrapping TopicSession state.
 * Encapsulates invariants and mutation logic that was previously scattered
 * across dispatcher, orchestrators, and pipeline code.
 */
export class TopicSessionAggregate {
  threadId: ThreadId
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
  parentThreadId?: ThreadId
  childThreadIds?: ThreadId[]
  splitLabel?: string
  interruptedAt?: number
  branch?: string
  prUrl?: string
  lastState?: "completed" | "errored" | "quota_exhausted"
  dagId?: string
  dagNodeId?: string
  pendingSplitItems?: { title: string; description: string }[]
  allSplitItems?: { title: string; description: string }[]
  pinnedMessageId?: MessageId
  pendingDagItems?: PendingDagItem[]
  quotaRetryCount?: number
  quotaSleepUntil?: number
  autoAdvance?: AutoAdvance
  verificationState?: VerificationState

  constructor(data: TopicSession) {
    this.threadId = data.threadId
    this.repo = data.repo
    this.repoUrl = data.repoUrl
    this.cwd = data.cwd
    this.slug = data.slug
    this.topicHandle = data.topicHandle
    this.conversation = [...data.conversation]
    this.activeSessionId = data.activeSessionId
    this.pendingFeedback = [...data.pendingFeedback]
    this.mode = data.mode
    this.lastActivityAt = data.lastActivityAt
    this.profileId = data.profileId
    this.parentThreadId = data.parentThreadId
    this.childThreadIds = data.childThreadIds ? [...data.childThreadIds] : undefined
    this.splitLabel = data.splitLabel
    this.interruptedAt = data.interruptedAt
    this.branch = data.branch
    this.prUrl = data.prUrl
    this.lastState = data.lastState
    this.dagId = data.dagId
    this.dagNodeId = data.dagNodeId
    this.pendingSplitItems = data.pendingSplitItems ? [...data.pendingSplitItems] : undefined
    this.allSplitItems = data.allSplitItems ? [...data.allSplitItems] : undefined
    this.pinnedMessageId = data.pinnedMessageId
    this.pendingDagItems = data.pendingDagItems ? [...data.pendingDagItems] : undefined
    this.quotaRetryCount = data.quotaRetryCount
    this.quotaSleepUntil = data.quotaSleepUntil
    this.autoAdvance = data.autoAdvance ? { ...data.autoAdvance } : undefined
    this.verificationState = data.verificationState
      ? { ...data.verificationState, rounds: [...data.verificationState.rounds] }
      : undefined
  }

  /** Push a message to conversation, truncating if it exceeds maxLength. */
  pushMessage(msg: TopicMessage, maxLength: number): void {
    this.conversation.push(msg)
    const result = truncateConversation(this.conversation, maxLength)
    this.conversation = result.conversation
    this.touch()
  }

  /** Mark session as completed, optionally recording a PR URL. */
  markCompleted(prUrl?: string): void {
    this.lastState = "completed"
    this.activeSessionId = undefined
    if (prUrl !== undefined) {
      this.prUrl = prUrl
    }
    this.touch()
  }

  /** Mark session as errored. */
  markErrored(): void {
    this.lastState = "errored"
    this.activeSessionId = undefined
    this.touch()
  }

  /** Mark session as quota-exhausted, incrementing retry count and setting sleep deadline. */
  markQuotaExhausted(sleepUntil?: number): void {
    this.lastState = "quota_exhausted"
    this.quotaRetryCount = (this.quotaRetryCount ?? 0) + 1
    if (sleepUntil !== undefined) {
      this.quotaSleepUntil = sleepUntil
    }
    this.touch()
  }

  /** Clear quota-related state when resuming after a sleep. */
  clearQuotaSleep(): void {
    this.lastState = undefined
    this.quotaRetryCount = undefined
    this.quotaSleepUntil = undefined
    this.touch()
  }

  /** Add a child thread ID (from split/stack/DAG). Initializes the array if needed. */
  addChild(childThreadId: ThreadId): void {
    if (!this.childThreadIds) {
      this.childThreadIds = []
    }
    this.childThreadIds.push(childThreadId)
    this.touch()
  }

  /** Remove a child thread ID. Returns true if the child was found and removed. */
  removeChild(childThreadId: ThreadId): boolean {
    if (!this.childThreadIds) return false
    const idx = this.childThreadIds.indexOf(childThreadId)
    if (idx === -1) return false
    this.childThreadIds.splice(idx, 1)
    this.touch()
    return true
  }

  /** Set auto-advance configuration for ship pipeline. */
  setAutoAdvance(config: AutoAdvance | undefined): void {
    this.autoAdvance = config ? { ...config } : undefined
    this.touch()
  }

  /** Queue pending feedback to inject into the next session turn. */
  queueFeedback(text: string): void {
    this.pendingFeedback.push(text)
    this.touch()
  }

  /** Drain all pending feedback, returning the joined text and clearing the queue. */
  drainFeedback(): string {
    const joined = this.pendingFeedback.join("\n\n")
    this.pendingFeedback = []
    return joined
  }

  /** Activate the session with a given session ID. */
  activate(sessionId: string): void {
    this.activeSessionId = sessionId
    this.touch()
  }

  /** Deactivate the session (clear active session ID). */
  deactivate(): void {
    this.activeSessionId = undefined
  }

  /** Whether the session has an active running process. */
  get isActive(): boolean {
    return this.activeSessionId !== undefined
  }

  /** Update lastActivityAt to now. */
  private touch(): void {
    this.lastActivityAt = Date.now()
  }

  /** Serialize to a plain TopicSession object for JSON persistence. */
  toJSON(): TopicSession {
    return {
      threadId: this.threadId,
      repo: this.repo,
      repoUrl: this.repoUrl,
      cwd: this.cwd,
      slug: this.slug,
      topicHandle: this.topicHandle,
      conversation: this.conversation,
      activeSessionId: this.activeSessionId,
      pendingFeedback: this.pendingFeedback,
      mode: this.mode,
      lastActivityAt: this.lastActivityAt,
      profileId: this.profileId,
      parentThreadId: this.parentThreadId,
      childThreadIds: this.childThreadIds,
      splitLabel: this.splitLabel,
      interruptedAt: this.interruptedAt,
      branch: this.branch,
      prUrl: this.prUrl,
      lastState: this.lastState,
      dagId: this.dagId,
      dagNodeId: this.dagNodeId,
      pendingSplitItems: this.pendingSplitItems,
      allSplitItems: this.allSplitItems,
      pinnedMessageId: this.pinnedMessageId,
      pendingDagItems: this.pendingDagItems,
      quotaRetryCount: this.quotaRetryCount,
      quotaSleepUntil: this.quotaSleepUntil,
      autoAdvance: this.autoAdvance,
      verificationState: this.verificationState,
    }
  }

  /** Reconstruct an aggregate from a plain TopicSession (e.g. loaded from store). */
  static fromJSON(data: TopicSession): TopicSessionAggregate {
    return new TopicSessionAggregate(data)
  }
}
