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
  taskModel: string
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
  maxConversationLength: number
  maxJudgeOptions: number
  judgeAdvocateTimeoutMs: number
  judgeTimeoutMs: number
}

export type DagCiPolicy = "block" | "warn" | "skip"

export interface CiConfig {
  babysitEnabled: boolean
  maxRetries: number
  pollIntervalMs: number
  pollTimeoutMs: number
  noChecksGraceMs?: number
  dagCiPolicy: DagCiPolicy
}

export interface McpConfig {
  browserEnabled: boolean
  githubEnabled: boolean
  context7Enabled: boolean
  sentryEnabled: boolean
  sentryOrgSlug: string
  sentryProjectSlug: string
  supabaseEnabled: boolean
  supabaseProjectRef: string
  flyEnabled: boolean
  flyOrg: string
  zaiEnabled: boolean
}

export interface ObserverConfig {
  activityThrottleMs: number
  textFlushDebounceMs: number
  activityEditDebounceMs: number
}

export interface TelegramQueueConfig {
  minSendIntervalMs: number
}

export interface SentryConfig {
  dsn?: string
}

export interface GitHubAppConfig {
  appId: string
  privateKey: string
  installationId: string
}

export interface AgentDefinitions {
  agentsDir?: string
  skillsDir?: string
  goosehintsPath?: string
  claudeMd?: string
  settingsJson?: Record<string, unknown>
}

export interface QuotaConfig {
  retryMax: number
  defaultSleepMs: number
  sleepBufferMs: number
}

export interface LoopConfig {
  maxConcurrentLoops: number
  reservedInteractiveSlots: number
  defaultRepo?: string
}

export interface MinionConfig {
  telegram: TelegramConfig
  telegramQueue: TelegramQueueConfig
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
  githubApp?: GitHubAppConfig
  /** List of environment variable names to pass through to minion sessions */
  sessionEnvPassthrough?: string[]
  /** Quota exhaustion sleep/retry configuration */
  quota: QuotaConfig
  /** HTTP API server configuration */
  api?: ApiServerConfig
  /** Loop scheduler configuration */
  loops?: LoopConfig
}

export interface ApiServerConfig {
  port?: number
  apiToken?: string
  host?: string
  /** Origins permitted via `Access-Control-Allow-Origin`; empty/omitted falls back to `*` for dev backcompat. */
  corsAllowedOrigins?: string[]
}

export interface SystemPrompts {
  task: string
  ci_fix: string
  plan: string
  think: string
  review: string
  dag_review: string
  ship_plan: string
  ship_verify: string
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
