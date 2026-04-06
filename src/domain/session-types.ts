// Session types

import type { AutoAdvance, VerificationState } from "./workflow-types.js"

export type SessionDoneState = "completed" | "errored" | "quota_exhausted"
export type SessionState = "spawning" | "working" | "idle" | "completed" | "errored"

export interface SessionPort {
  readonly meta: SessionMeta

  start(task: string, systemPrompt?: string): void

  injectReply(text: string, images?: string[]): boolean

  waitForCompletion(): Promise<SessionDoneState>

  isClosed(): boolean

  getState(): SessionState

  isActive(): boolean

  interrupt(): void

  kill(gracefulMs?: number): Promise<void>
}

export type SessionMode = "task" | "plan" | "think" | "review" | "ci-fix" | "dag-review" | "ship-think" | "ship-plan" | "ship-verify"

export interface SessionMeta {
  sessionId: string
  threadId: string
  topicName: string
  repo: string
  cwd: string
  startedAt: number
  totalTokens?: number
  mode: SessionMode
  screenshotDir?: string
}

export interface TopicMessage {
  role: "user" | "assistant"
  text: string
  images?: string[]
}

export interface TopicSession {
  threadId: string
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
  parentThreadId?: string
  childThreadIds?: string[]
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

export interface PendingDagItem {
  id: string
  title: string
  description: string
  dependsOn: string[]
}

// Re-export workflow types that TopicSession depends on
export type { AutoAdvance, VerificationState }
