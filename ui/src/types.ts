export interface MinionSession {
  id: string
  slug: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  command: string
  repo?: string
  branch?: string
  prUrl?: string
  threadId?: number
  chatId?: number
  createdAt: string
  updatedAt: string
  parentId?: string
  childIds: string[]
}

export interface DagNode {
  id: string
  slug: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  dependencies: string[]
  dependents: string[]
  session?: MinionSession
}

export interface DagGraph {
  id: string
  rootTaskId: string
  nodes: Record<string, DagNode>
  status: 'pending' | 'running' | 'completed' | 'failed'
  createdAt: string
  updatedAt: string
}

export interface ApiResponse<T> {
  data: T
  error?: string
}

export type TelegramTheme = {
  bgColor: string
  textColor: string
  hintColor: string
  linkColor: string
  buttonColor: string
  buttonTextColor: string
  secondaryBgColor: string
}

// Command types for actions
export interface SendReplyCommand {
  action: 'reply'
  sessionId: string
  message: string
}

export interface StopMinionCommand {
  action: 'stop'
  sessionId: string
}

export interface CloseSessionCommand {
  action: 'close'
  sessionId: string
}

export type MinionCommand = SendReplyCommand | StopMinionCommand | CloseSessionCommand

export interface CommandResult {
  success: boolean
  error?: string
}

// SSE event types
export interface SessionUpdatedEvent {
  type: 'session_updated'
  session: MinionSession
}

export interface SessionCreatedEvent {
  type: 'session_created'
  session: MinionSession
}

export interface SessionDeletedEvent {
  type: 'session_deleted'
  sessionId: string
}

export interface DagUpdatedEvent {
  type: 'dag_updated'
  dag: DagGraph
}

export interface DagCreatedEvent {
  type: 'dag_created'
  dag: DagGraph
}

export interface DagDeletedEvent {
  type: 'dag_deleted'
  dagId: string
}

export type SseEvent =
  | SessionUpdatedEvent
  | SessionCreatedEvent
  | SessionDeletedEvent
  | DagUpdatedEvent
  | DagCreatedEvent
  | DagDeletedEvent

// Action state for UI
export interface ActionState {
  isLoading: boolean
  error: string | null
  lastAction: string | null
}
