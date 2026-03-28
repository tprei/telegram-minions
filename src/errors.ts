/**
 * Custom error classes for typed error handling throughout the codebase.
 * Each error type includes relevant context for debugging and logging.
 */

/** Base class for all minion errors. */
export abstract class MinionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

// ============================================================================
// DAG Errors
// ============================================================================

/** Thrown when a DAG contains a cycle. */
export class DagCycleError extends MinionError {
  readonly cycleNodes?: string[]

  constructor(cycleNodes?: string[]) {
    let message = "DAG contains a cycle"
    if (cycleNodes && cycleNodes.length > 0) {
      message += `: ${cycleNodes.join(" → ")}`
    }
    super(message)
    this.cycleNodes = cycleNodes
  }
}

/** Thrown when a node depends on itself. */
export class DagSelfDependencyError extends MinionError {
  readonly nodeId: string

  constructor(nodeId: string) {
    super(`Node "${nodeId}" depends on itself`)
    this.nodeId = nodeId
  }
}

/** Thrown when a node references an unknown dependency. */
export class UnknownNodeError extends MinionError {
  readonly nodeId: string
  readonly unknownDependency: string
  readonly availableNodes: string[]

  constructor(nodeId: string, unknownDependency: string, availableNodes: string[] = []) {
    let message = `Node "${nodeId}" depends on unknown node "${unknownDependency}"`
    if (availableNodes.length > 0) {
      message += `. Available: ${availableNodes.map((n) => `"${n}"`).join(", ")}`
    }
    super(message)
    this.nodeId = nodeId
    this.unknownDependency = unknownDependency
    this.availableNodes = availableNodes
  }
}

// ============================================================================
// Session Errors
// ============================================================================

/** Thrown when a session lookup fails. */
export class SessionNotFoundError extends MinionError {
  readonly threadId: number
  readonly activeThreadIds?: number[]

  constructor(threadId: number, activeThreadIds?: number[]) {
    let message = `Session not found: thread ${threadId}`
    if (activeThreadIds && activeThreadIds.length > 0) {
      message += `. Active sessions: ${activeThreadIds.join(", ")}`
    } else {
      message += ". No active sessions"
    }
    super(message)
    this.threadId = threadId
    this.activeThreadIds = activeThreadIds
  }
}

// ============================================================================
// Configuration Errors
// ============================================================================

/** Thrown when a required environment variable is missing. */
export class ConfigError extends MinionError {
  readonly varName: string

  constructor(message: string, varName: string) {
    super(`${message}. Check .env.example for required configuration`)
    this.varName = varName
  }
}

/** Thrown when an environment variable has an invalid format. */
export class ConfigFormatError extends ConfigError {
  readonly actualValue: string

  constructor(varName: string, expectedType: string, actualValue: string) {
    super(`Env var ${varName} must be ${expectedType}, got: ${actualValue}`, varName)
    this.actualValue = actualValue
  }
}

// ============================================================================
// Telegram API Errors
// ============================================================================

/** Base class for Telegram API errors. */
export class TelegramApiError extends MinionError {
  readonly method: string

  constructor(method: string, message: string) {
    super(message)
    this.method = method
  }
}

/** Thrown when Telegram rate-limits a request. */
export class TelegramRateLimitError extends TelegramApiError {
  readonly retryAfter?: number

  constructor(method: string, responseText: string, retryAfter?: number) {
    super(method, `Telegram ${method} HTTP 429: ${responseText}`)
    this.retryAfter = retryAfter
  }
}

/** Thrown when Telegram returns an HTTP error. */
export class TelegramHttpError extends TelegramApiError {
  readonly statusCode: number
  readonly responseText: string

  constructor(method: string, statusCode: number, responseText: string) {
    super(method, `Telegram ${method} HTTP ${statusCode}: ${responseText}`)
    this.statusCode = statusCode
    this.responseText = responseText
  }
}

/** Thrown when Telegram returns an API error response. */
export class TelegramResponseError extends TelegramApiError {
  readonly description?: string

  constructor(method: string, description?: string) {
    super(method, `Telegram ${method} error: ${description ?? "unknown"}`)
    this.description = description
  }
}

/** Thrown when retries are exhausted for a Telegram request. */
export class TelegramRetryExhaustedError extends TelegramApiError {
  readonly attempts: number

  constructor(method: string, attempts: number) {
    super(method, `Telegram ${method}: exhausted retries after ${attempts} attempts`)
    this.attempts = attempts
  }
}

// ============================================================================
// Git Errors
// ============================================================================

/** Thrown when a git operation fails. */
export class GitError extends MinionError {
  constructor(message: string) {
    super(message)
  }
}

/** Thrown when the default branch cannot be determined. */
export class DefaultBranchError extends GitError {
  readonly repoUrl?: string

  constructor(repoUrl?: string) {
    let message = "Cannot determine default branch"
    if (repoUrl) {
      message += ` for ${repoUrl}`
    }
    message += ". Ensure the repository exists and you have access. Tried: main, master"
    super(message)
    this.repoUrl = repoUrl
  }
}

// ============================================================================
// Type guards
// ============================================================================

/** Check if an error is a MinionError. */
export function isMinionError(error: unknown): error is MinionError {
  return error instanceof MinionError
}

/** Check if an error is a DAG-related error. */
export function isDagError(error: unknown): error is DagCycleError | DagSelfDependencyError | UnknownNodeError {
  return error instanceof DagCycleError || error instanceof DagSelfDependencyError || error instanceof UnknownNodeError
}

/** Check if an error is a session error. */
export function isSessionError(error: unknown): error is SessionNotFoundError {
  return error instanceof SessionNotFoundError
}

/** Check if an error is a config error. */
export function isConfigError(error: unknown): error is ConfigError | ConfigFormatError {
  return error instanceof ConfigError
}

/** Check if an error is a Telegram API error. */
export function isTelegramError(error: unknown): error is TelegramApiError {
  return error instanceof TelegramApiError
}

/** Check if a Telegram error indicates the message thread no longer exists. */
export function isThreadNotFoundError(error: unknown): error is TelegramHttpError {
  return (
    error instanceof TelegramHttpError &&
    error.statusCode === 400 &&
    error.responseText.includes("message thread not found")
  )
}
