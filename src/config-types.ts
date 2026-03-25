export interface TelegramConfig {
  botToken: string
  chatId: string
  allowedUserIds: number[]
}

export interface GooseConfig {
  provider: string
  model: string
}

export interface ClaudeConfig {
  planModel: string
  thinkModel: string
  reviewModel: string
}

export interface WorkspaceConfig {
  root: string
  maxConcurrentSessions: number
  maxDagConcurrency: number
  maxSplitItems: number
  sessionTokenBudget: number
  sessionBudgetUsd: number
  sessionTimeoutMs: number
  sessionInactivityTimeoutMs: number
  staleTtlMs: number
  cleanupIntervalMs: number
}

export interface CiConfig {
  babysitEnabled: boolean
  maxRetries: number
  pollIntervalMs: number
  pollTimeoutMs: number
}

export interface McpConfig {
  browserEnabled: boolean
  githubEnabled: boolean
  context7Enabled: boolean
  sentryEnabled: boolean
  sentryOrgSlug: string
  sentryProjectSlug: string
  zaiEnabled: boolean
}

export interface ObserverConfig {
  activityThrottleMs: number
}

export interface SentryConfig {
  dsn?: string
}

export interface AgentDefinitions {
  agentsDir?: string
  claudeMd?: string
  settingsJson?: object
}

export interface MinionConfig {
  telegram: TelegramConfig
  goose: GooseConfig
  claude: ClaudeConfig
  workspace: WorkspaceConfig
  ci: CiConfig
  mcp: McpConfig
  observer: ObserverConfig
  sentry?: SentryConfig
  repos: Record<string, string>
  prompts?: Partial<SystemPrompts>
  agentDefs?: AgentDefinitions
  /** List of environment variable names to pass through to minion sessions */
  sessionEnvPassthrough?: string[]
  /** HTTP API server configuration */
  api?: ApiServerConfig
}

export interface ApiServerConfig {
  port?: number
  apiToken?: string
  host?: string
}

export interface SystemPrompts {
  task: string
  ci_fix: string
  plan: string
  think: string
  review: string
}

export interface ProviderProfile {
  id: string
  name: string
  baseUrl?: string
  authToken?: string
  opusModel?: string
  sonnetModel?: string
  haikuModel?: string
}
