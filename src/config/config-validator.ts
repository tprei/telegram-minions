import type {
  MinionConfig,
  TelegramConfig,
  GooseConfig,
  ClaudeConfig,
  WorkspaceConfig,
  CiConfig,
  McpConfig,
  ObserverConfig,
  SentryConfig,
  AgentDefinitions,
  ApiServerConfig,
  ProviderProfile,
  TelegramQueueConfig,
  GitHubAppConfig,
  QuotaConfig,
  ChatPlatformConfig,
} from "./config-types.js"

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(`${path}: ${message}`)
    this.name = "ConfigValidationError"
  }
}

export interface ValidationResult {
  valid: boolean
  errors: ConfigValidationError[]
}

function error(path: string, message: string): ConfigValidationError {
  return new ConfigValidationError(message, path)
}

function validateNonEmptyString(value: unknown, path: string): ConfigValidationError | null {
  if (typeof value !== "string") {
    return error(path, `expected string, got ${typeof value}`)
  }
  if (value.trim().length === 0) {
    return error(path, "expected non-empty string")
  }
  return null
}

function validateOptionalString(value: unknown, path: string): ConfigValidationError | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") {
    return error(path, `expected string or undefined, got ${typeof value}`)
  }
  return null
}

function validateNumber(value: unknown, path: string, constraints?: {
  min?: number
  max?: number
  integer?: boolean
}): ConfigValidationError | null {
  if (typeof value !== "number") {
    return error(path, `expected number, got ${typeof value}`)
  }
  if (isNaN(value)) {
    return error(path, "expected valid number, got NaN")
  }
  if (constraints) {
    if (constraints.integer && !Number.isInteger(value)) {
      return error(path, `expected integer, got ${value}`)
    }
    if (constraints.min !== undefined && value < constraints.min) {
      return error(path, `expected >= ${constraints.min}, got ${value}`)
    }
    if (constraints.max !== undefined && value > constraints.max) {
      return error(path, `expected <= ${constraints.max}, got ${value}`)
    }
  }
  return null
}

function validateOptionalNumber(value: unknown, path: string, constraints?: {
  min?: number
  max?: number
  integer?: boolean
}): ConfigValidationError | null {
  if (value === undefined || value === null) return null
  return validateNumber(value, path, constraints)
}

function validateBoolean(value: unknown, path: string): ConfigValidationError | null {
  if (typeof value !== "boolean") {
    return error(path, `expected boolean, got ${typeof value}`)
  }
  return null
}

function validateArray(value: unknown, path: string, itemValidator: (item: unknown, itemPath: string) => ConfigValidationError | null): ConfigValidationError | null {
  if (!Array.isArray(value)) {
    return error(path, `expected array, got ${typeof value}`)
  }
  for (let i = 0; i < value.length; i++) {
    const itemError = itemValidator(value[i], `${path}[${i}]`)
    if (itemError) return itemError
  }
  return null
}

function validateOptionalArray(value: unknown, path: string, itemValidator: (item: unknown, itemPath: string) => ConfigValidationError | null): ConfigValidationError | null {
  if (value === undefined || value === null) return null
  return validateArray(value, path, itemValidator)
}

function validateRecord(value: unknown, path: string): ConfigValidationError | null {
  if (typeof value !== "object" || value === null) {
    return error(path, `expected object, got ${typeof value}`)
  }
  if (Array.isArray(value)) {
    return error(path, "expected object, got array")
  }
  return null
}

function validateOptionalObject(value: unknown, path: string): ConfigValidationError | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "object" || Array.isArray(value)) {
    return error(path, `expected object or undefined, got ${Array.isArray(value) ? "array" : typeof value}`)
  }
  return null
}

export function validateTelegramConfig(config: unknown, path = "telegram"): ValidationResult {
  const errors: ConfigValidationError[] = []
  if (!config || typeof config !== "object") {
    errors.push(error(path, "expected object"))
    return { valid: false, errors }
  }
  const c = config as Partial<TelegramConfig>

  const botTokenErr = validateNonEmptyString(c.botToken, `${path}.botToken`)
  if (botTokenErr) errors.push(botTokenErr)

  const chatIdErr = validateNonEmptyString(c.chatId, `${path}.chatId`)
  if (chatIdErr) errors.push(chatIdErr)

  const allowedErr = validateArray(c.allowedUserIds, `${path}.allowedUserIds`, (item, itemPath) => {
    if (typeof item !== "number") {
      return error(itemPath, `expected number, got ${typeof item}`)
    }
    if (!Number.isInteger(item) || item <= 0) {
      return error(itemPath, "expected positive integer")
    }
    return null
  })
  if (allowedErr) errors.push(allowedErr)

  return { valid: errors.length === 0, errors }
}

export function validateGooseConfig(config: unknown, path = "goose"): ValidationResult {
  const errors: ConfigValidationError[] = []
  if (!config || typeof config !== "object") {
    errors.push(error(path, "expected object"))
    return { valid: false, errors }
  }
  const c = config as Partial<GooseConfig>

  const providerErr = validateNonEmptyString(c.provider, `${path}.provider`)
  if (providerErr) errors.push(providerErr)

  const modelErr = validateNonEmptyString(c.model, `${path}.model`)
  if (modelErr) errors.push(modelErr)

  return { valid: errors.length === 0, errors }
}

export function validateClaudeConfig(config: unknown, path = "claude"): ValidationResult {
  const errors: ConfigValidationError[] = []
  if (!config || typeof config !== "object") {
    errors.push(error(path, "expected object"))
    return { valid: false, errors }
  }
  const c = config as Partial<ClaudeConfig>

  const validModels = ["opus", "sonnet", "haiku", "default"]
  for (const field of ["planModel", "thinkModel", "reviewModel"] as const) {
    const val = c[field]
    if (val !== undefined) {
      const strErr = validateNonEmptyString(val, `${path}.${field}`)
      if (strErr) {
        errors.push(strErr)
      } else if (!validModels.includes(val) && !val.includes("/")) {
        errors.push(new ConfigValidationError(
          `Invalid model "${val}". Valid models: ${validModels.join(", ")} (or a custom model ID containing "/")`,
          `${path}.${field}`,
        ))
      }
    } else {
      errors.push(error(`${path}.${field}`, "required"))
    }
  }

  return { valid: errors.length === 0, errors }
}

export function validateWorkspaceConfig(config: unknown, path = "workspace"): ValidationResult {
  const errors: ConfigValidationError[] = []
  if (!config || typeof config !== "object") {
    errors.push(error(path, "expected object"))
    return { valid: false, errors }
  }
  const c = config as Partial<WorkspaceConfig>

  const rootErr = validateNonEmptyString(c.root, `${path}.root`)
  if (rootErr) errors.push(rootErr)

  const maxSessionsErr = validateNumber(c.maxConcurrentSessions, `${path}.maxConcurrentSessions`, { min: 1, max: 100, integer: true })
  if (maxSessionsErr) errors.push(maxSessionsErr)

  const maxDagErr = validateNumber(c.maxDagConcurrency, `${path}.maxDagConcurrency`, { min: 1, max: 50, integer: true })
  if (maxDagErr) errors.push(maxDagErr)

  const maxSplitErr = validateNumber(c.maxSplitItems, `${path}.maxSplitItems`, { min: 1, max: 20, integer: true })
  if (maxSplitErr) errors.push(maxSplitErr)

  const tokenBudgetErr = validateNumber(c.sessionTokenBudget, `${path}.sessionTokenBudget`, { min: 1000 })
  if (tokenBudgetErr) errors.push(tokenBudgetErr)

  const budgetUsdErr = validateNumber(c.sessionBudgetUsd, `${path}.sessionBudgetUsd`, { min: 0 })
  if (budgetUsdErr) errors.push(budgetUsdErr)

  const timeoutErr = validateNumber(c.sessionTimeoutMs, `${path}.sessionTimeoutMs`, { min: 60000 })
  if (timeoutErr) errors.push(timeoutErr)

  const inactivityErr = validateNumber(c.sessionInactivityTimeoutMs, `${path}.sessionInactivityTimeoutMs`, { min: 10000 })
  if (inactivityErr) errors.push(inactivityErr)

  const staleErr = validateNumber(c.staleTtlMs, `${path}.staleTtlMs`, { min: 60000 })
  if (staleErr) errors.push(staleErr)

  const cleanupErr = validateNumber(c.cleanupIntervalMs, `${path}.cleanupIntervalMs`, { min: 60000 })
  if (cleanupErr) errors.push(cleanupErr)

  return { valid: errors.length === 0, errors }
}

export function validateCiConfig(config: unknown, path = "ci"): ValidationResult {
  const errors: ConfigValidationError[] = []
  if (!config || typeof config !== "object") {
    errors.push(error(path, "expected object"))
    return { valid: false, errors }
  }
  const c = config as Partial<CiConfig>

  const enabledErr = validateBoolean(c.babysitEnabled, `${path}.babysitEnabled`)
  if (enabledErr) errors.push(enabledErr)

  const retriesErr = validateNumber(c.maxRetries, `${path}.maxRetries`, { min: 0, max: 10, integer: true })
  if (retriesErr) errors.push(retriesErr)

  const pollIntervalErr = validateNumber(c.pollIntervalMs, `${path}.pollIntervalMs`, { min: 5000 })
  if (pollIntervalErr) errors.push(pollIntervalErr)

  const pollTimeoutErr = validateNumber(c.pollTimeoutMs, `${path}.pollTimeoutMs`, { min: 60000 })
  if (pollTimeoutErr) errors.push(pollTimeoutErr)

  if (c.noChecksGraceMs !== undefined) {
    const graceErr = validateNumber(c.noChecksGraceMs, `${path}.noChecksGraceMs`, { min: 0 })
    if (graceErr) errors.push(graceErr)
  }

  const validPolicies = ["block", "warn", "skip"]
  if (c.dagCiPolicy !== undefined && !validPolicies.includes(c.dagCiPolicy)) {
    errors.push(error(`${path}.dagCiPolicy`, `expected one of ${validPolicies.join(", ")}, got "${c.dagCiPolicy}"`))
  }

  return { valid: errors.length === 0, errors }
}

export function validateMcpConfig(config: unknown, path = "mcp"): ValidationResult {
  const errors: ConfigValidationError[] = []
  if (!config || typeof config !== "object") {
    errors.push(error(path, "expected object"))
    return { valid: false, errors }
  }
  const c = config as Partial<McpConfig>

  for (const field of ["browserEnabled", "githubEnabled", "context7Enabled", "sentryEnabled", "supabaseEnabled", "flyEnabled", "zaiEnabled"] as const) {
    const err = validateBoolean(c[field], `${path}.${field}`)
    if (err) errors.push(err)
  }

  const orgErr = validateOptionalString(c.sentryOrgSlug, `${path}.sentryOrgSlug`)
  if (orgErr) errors.push(orgErr)

  const projectErr = validateOptionalString(c.sentryProjectSlug, `${path}.sentryProjectSlug`)
  if (projectErr) errors.push(projectErr)

  const supabaseRefErr = validateOptionalString(c.supabaseProjectRef, `${path}.supabaseProjectRef`)
  if (supabaseRefErr) errors.push(supabaseRefErr)

  const flyOrgErr = validateOptionalString(c.flyOrg, `${path}.flyOrg`)
  if (flyOrgErr) errors.push(flyOrgErr)

  return { valid: errors.length === 0, errors }
}

export function validateTelegramQueueConfig(config: unknown, path = "telegramQueue"): ValidationResult {
  const errors: ConfigValidationError[] = []
  if (!config || typeof config !== "object") {
    errors.push(error(path, "expected object"))
    return { valid: false, errors }
  }
  const c = config as Partial<TelegramQueueConfig>

  const intervalErr = validateNumber(c.minSendIntervalMs, `${path}.minSendIntervalMs`, { min: 0 })
  if (intervalErr) errors.push(intervalErr)

  return { valid: errors.length === 0, errors }
}

export function validateObserverConfig(config: unknown, path = "observer"): ValidationResult {
  const errors: ConfigValidationError[] = []
  if (!config || typeof config !== "object") {
    errors.push(error(path, "expected object"))
    return { valid: false, errors }
  }
  const c = config as Partial<ObserverConfig>

  const throttleErr = validateNumber(c.activityThrottleMs, `${path}.activityThrottleMs`, { min: 100 })
  if (throttleErr) errors.push(throttleErr)

  const textFlushErr = validateNumber(c.textFlushDebounceMs, `${path}.textFlushDebounceMs`, { min: 200 })
  if (textFlushErr) errors.push(textFlushErr)

  const activityEditErr = validateNumber(c.activityEditDebounceMs, `${path}.activityEditDebounceMs`, { min: 200 })
  if (activityEditErr) errors.push(activityEditErr)

  return { valid: errors.length === 0, errors }
}

export function validateSentryConfig(config: unknown, path = "sentry"): ValidationResult {
  const errors: ConfigValidationError[] = []
  if (config === undefined || config === null) {
    return { valid: true, errors }
  }
  if (typeof config !== "object") {
    errors.push(error(path, "expected object or undefined"))
    return { valid: false, errors }
  }
  const c = config as Partial<SentryConfig>

  const dsnErr = validateOptionalString(c.dsn, `${path}.dsn`)
  if (dsnErr) errors.push(dsnErr)

  // Validate DSN format if provided
  if (c.dsn && !c.dsn.startsWith("https://")) {
    errors.push(error(`${path}.dsn`, "expected valid Sentry DSN starting with https://"))
  }

  return { valid: errors.length === 0, errors }
}

export function validateGitHubAppConfig(config: unknown, path = "githubApp"): ValidationResult {
  const errors: ConfigValidationError[] = []
  if (config === undefined || config === null) {
    return { valid: true, errors }
  }
  if (typeof config !== "object") {
    errors.push(error(path, "expected object or undefined"))
    return { valid: false, errors }
  }
  const c = config as Partial<GitHubAppConfig>

  for (const field of ["appId", "privateKey", "installationId"] as const) {
    const err = validateNonEmptyString(c[field], `${path}.${field}`)
    if (err) errors.push(err)
  }

  return { valid: errors.length === 0, errors }
}

export function validateAgentDefinitions(config: unknown, path = "agentDefs"): ValidationResult {
  const errors: ConfigValidationError[] = []
  if (config === undefined || config === null) {
    return { valid: true, errors }
  }
  if (typeof config !== "object") {
    errors.push(error(path, "expected object or undefined"))
    return { valid: false, errors }
  }
  const c = config as Partial<AgentDefinitions>

  const agentsDirErr = validateOptionalString(c.agentsDir, `${path}.agentsDir`)
  if (agentsDirErr) errors.push(agentsDirErr)

  const skillsDirErr = validateOptionalString(c.skillsDir, `${path}.skillsDir`)
  if (skillsDirErr) errors.push(skillsDirErr)

  const goosehintsErr = validateOptionalString(c.goosehintsPath, `${path}.goosehintsPath`)
  if (goosehintsErr) errors.push(goosehintsErr)

  const claudeMdErr = validateOptionalString(c.claudeMd, `${path}.claudeMd`)
  if (claudeMdErr) errors.push(claudeMdErr)

  const settingsErr = validateOptionalObject(c.settingsJson, `${path}.settingsJson`)
  if (settingsErr) errors.push(settingsErr)

  return { valid: errors.length === 0, errors }
}

export function validateApiServerConfig(config: unknown, path = "api"): ValidationResult {
  const errors: ConfigValidationError[] = []
  if (config === undefined || config === null) {
    return { valid: true, errors }
  }
  if (typeof config !== "object") {
    errors.push(error(path, "expected object or undefined"))
    return { valid: false, errors }
  }
  const c = config as Partial<ApiServerConfig>

  const portErr = validateOptionalNumber(c.port, `${path}.port`, { min: 1, max: 65535, integer: true })
  if (portErr) errors.push(portErr)

  const tokenErr = validateOptionalString(c.apiToken, `${path}.apiToken`)
  if (tokenErr) errors.push(tokenErr)

  const hostErr = validateOptionalString(c.host, `${path}.host`)
  if (hostErr) errors.push(hostErr)

  return { valid: errors.length === 0, errors }
}

export function validateProviderProfile(profile: unknown, path = "profile"): ValidationResult {
  const errors: ConfigValidationError[] = []
  if (!profile || typeof profile !== "object") {
    errors.push(error(path, "expected object"))
    return { valid: false, errors }
  }
  const p = profile as Partial<ProviderProfile>

  const idErr = validateNonEmptyString(p.id, `${path}.id`)
  if (idErr) errors.push(idErr)

  const nameErr = validateNonEmptyString(p.name, `${path}.name`)
  if (nameErr) errors.push(nameErr)

  const baseUrlErr = validateOptionalString(p.baseUrl, `${path}.baseUrl`)
  if (baseUrlErr) errors.push(baseUrlErr)
  if (p.baseUrl && !p.baseUrl.startsWith("http://") && !p.baseUrl.startsWith("https://")) {
    errors.push(error(`${path}.baseUrl`, "expected URL starting with http:// or https://"))
  }

  const authTokenErr = validateOptionalString(p.authToken, `${path}.authToken`)
  if (authTokenErr) errors.push(authTokenErr)

  for (const field of ["opusModel", "sonnetModel", "haikuModel"] as const) {
    const err = validateOptionalString(p[field], `${path}.${field}`)
    if (err) errors.push(err)
  }

  return { valid: errors.length === 0, errors }
}

export function validateQuotaConfig(config: unknown, path = "quota"): ValidationResult {
  const errors: ConfigValidationError[] = []
  if (!config || typeof config !== "object") {
    errors.push(error(path, "expected object"))
    return { valid: false, errors }
  }
  const c = config as Partial<QuotaConfig>

  const retryMaxErr = validateNumber(c.retryMax, `${path}.retryMax`, { min: 0, max: 20, integer: true })
  if (retryMaxErr) errors.push(retryMaxErr)

  const defaultSleepErr = validateNumber(c.defaultSleepMs, `${path}.defaultSleepMs`, { min: 1000 })
  if (defaultSleepErr) errors.push(defaultSleepErr)

  const bufferErr = validateNumber(c.sleepBufferMs, `${path}.sleepBufferMs`, { min: 0 })
  if (bufferErr) errors.push(bufferErr)

  return { valid: errors.length === 0, errors }
}

export function validatePlatformConfig(config: unknown, path = "platform"): ValidationResult {
  const errors: ConfigValidationError[] = []
  if (config === undefined || config === null) {
    return { valid: true, errors }
  }
  if (typeof config !== "object") {
    errors.push(error(path, "expected object or undefined"))
    return { valid: false, errors }
  }
  const c = config as Partial<ChatPlatformConfig>

  if (c.type === "telegram") {
    const botTokenErr = validateNonEmptyString((c as Record<string, unknown>)["botToken"], `${path}.botToken`)
    if (botTokenErr) errors.push(botTokenErr)

    const chatIdErr = validateNonEmptyString((c as Record<string, unknown>)["chatId"], `${path}.chatId`)
    if (chatIdErr) errors.push(chatIdErr)

    const intervalErr = validateNumber((c as Record<string, unknown>)["minSendIntervalMs"], `${path}.minSendIntervalMs`, { min: 0 })
    if (intervalErr) errors.push(intervalErr)

    const allowedErr = validateArray((c as Record<string, unknown>)["allowedUserIds"], `${path}.allowedUserIds`, (item, itemPath) => {
      if (typeof item !== "number") {
        return error(itemPath, `expected number, got ${typeof item}`)
      }
      if (!Number.isInteger(item) || item <= 0) {
        return error(itemPath, "expected positive integer")
      }
      return null
    })
    if (allowedErr) errors.push(allowedErr)
  } else if (c.type === "custom") {
    const allowedErr = validateArray((c as Record<string, unknown>)["allowedUserIds"], `${path}.allowedUserIds`, (item, itemPath) => {
      if (typeof item !== "string") {
        return error(itemPath, `expected string, got ${typeof item}`)
      }
      if ((item as string).trim().length === 0) {
        return error(itemPath, "expected non-empty string")
      }
      return null
    })
    if (allowedErr) errors.push(allowedErr)
  } else if (c.type !== undefined) {
    errors.push(error(`${path}.type`, `expected "telegram" or "custom", got "${c.type}"`))
  } else {
    errors.push(error(`${path}.type`, "required"))
  }

  return { valid: errors.length === 0, errors }
}

export function validateMinionConfig(config: unknown): ValidationResult {
  const errors: ConfigValidationError[] = []

  if (!config || typeof config !== "object") {
    errors.push(error("config", "expected object"))
    return { valid: false, errors }
  }
  const c = config as Partial<MinionConfig>

  // Required nested configs
  const telegramResult = validateTelegramConfig(c.telegram)
  errors.push(...telegramResult.errors)

  const telegramQueueResult = validateTelegramQueueConfig(c.telegramQueue)
  errors.push(...telegramQueueResult.errors)

  const gooseResult = validateGooseConfig(c.goose)
  errors.push(...gooseResult.errors)

  const claudeResult = validateClaudeConfig(c.claude)
  errors.push(...claudeResult.errors)

  const workspaceResult = validateWorkspaceConfig(c.workspace)
  errors.push(...workspaceResult.errors)

  const ciResult = validateCiConfig(c.ci)
  errors.push(...ciResult.errors)

  const mcpResult = validateMcpConfig(c.mcp)
  errors.push(...mcpResult.errors)

  const observerResult = validateObserverConfig(c.observer)
  errors.push(...observerResult.errors)

  const quotaResult = validateQuotaConfig(c.quota)
  errors.push(...quotaResult.errors)

  // Optional configs
  const sentryResult = validateSentryConfig(c.sentry)
  errors.push(...sentryResult.errors)

  const githubAppResult = validateGitHubAppConfig(c.githubApp)
  errors.push(...githubAppResult.errors)

  const agentDefsResult = validateAgentDefinitions(c.agentDefs)
  errors.push(...agentDefsResult.errors)

  const apiResult = validateApiServerConfig(c.api)
  errors.push(...apiResult.errors)

  const platformResult = validatePlatformConfig(c.platform)
  errors.push(...platformResult.errors)

  // Optional arrays
  const passthroughErr = validateOptionalArray(c.sessionEnvPassthrough, "sessionEnvPassthrough", (item, itemPath) => {
    if (typeof item !== "string") {
      return error(itemPath, `expected string, got ${typeof item}`)
    }
    if (item.trim().length === 0) {
      return error(itemPath, "expected non-empty string")
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(item)) {
      return error(itemPath, "expected valid environment variable name")
    }
    return null
  })
  if (passthroughErr) errors.push(passthroughErr)

  // Repos record
  const reposErr = validateRecord(c.repos, "repos")
  if (reposErr) errors.push(reposErr)

  return { valid: errors.length === 0, errors }
}

export function validateConfigOrThrow(config: unknown): asserts config is MinionConfig {
  const result = validateMinionConfig(config)
  if (!result.valid) {
    // Throw the first error directly, or a combined error
    if (result.errors.length === 1) {
      throw result.errors[0]
    }
    const messages = result.errors.map((e) => e.message).join("\n  ")
    throw new ConfigValidationError(`Multiple validation errors:\n  ${messages}`, "config")
  }
}

export function assertValidConfig(config: unknown): MinionConfig {
  validateConfigOrThrow(config)
  return config
}
