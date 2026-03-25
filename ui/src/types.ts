export interface MinionSession {
  id: string
  slug: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  command: string
  repo?: string
  branch?: string
  prUrl?: string
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
