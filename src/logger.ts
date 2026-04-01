import pino from "pino"

export interface LoggerContext {
  /** Session slug for correlation */
  slug?: string
  /** Thread/topic ID */
  threadId?: number
  /** Session ID */
  sessionId?: string
  /** Component name (e.g., 'dispatcher', 'observer', 'telegram') */
  component?: string
  /** Any additional context */
  [key: string]: unknown
}

/** Root logger instance configured for JSON output */
export const rootLogger = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // In development, use pino-pretty if available
  transport:
    process.env.NODE_ENV !== "production" && process.env.LOG_PRETTY === "true"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
})

/**
 * Create a child logger with additional context for correlation.
 * All log entries from the child will include the provided context.
 */
export function createLogger(context: LoggerContext = {}): pino.Logger {
  return rootLogger.child(context)
}

/** Pre-configured loggers for common components */
export const loggers = {
  main: createLogger({ component: "main" }),
  dispatcher: createLogger({ component: "dispatcher" }),
  observer: createLogger({ component: "observer" }),
  telegram: createLogger({ component: "telegram" }),
  session: createLogger({ component: "session" }),
  store: createLogger({ component: "store" }),
  profileStore: createLogger({ component: "profile-store" }),
  ciBabysit: createLogger({ component: "ci-babysit" }),
  split: createLogger({ component: "split" }),
  dagExtract: createLogger({ component: "dag-extract" }),
  apiServer: createLogger({ component: "api-server" }),
  sentry: createLogger({ component: "sentry" }),
  stats: createLogger({ component: "stats" }),
  sessionLog: createLogger({ component: "session-log" }),
  minion: createLogger({ component: "minion" }),
  verification: createLogger({ component: "verification" }),
  ship: createLogger({ component: "ship" }),
  conflictResolver: createLogger({ component: "conflict-resolver" }),
  dagStore: createLogger({ component: "dag-store" }),
  github: createLogger({ component: "github" }),
  judgeExtract: createLogger({ component: "judge-extract" }),
  conversationSummarizer: createLogger({ component: "conversation-summarizer" }),
  judgeOrchestrator: createLogger({ component: "judge-orchestrator" }),
  replyQueue: createLogger({ component: "reply-queue" }),
} as const

/**
 * Create a session-scoped logger with slug and thread ID for correlation.
 * Use this for all session-related logging.
 */
export function createSessionLogger(
  slug: string,
  threadId?: number,
  sessionId?: string
): pino.Logger {
  return rootLogger.child({
    component: "session",
    slug,
    ...(threadId !== undefined && { threadId }),
    ...(sessionId && { sessionId }),
  })
}

/** Type alias for convenience */
export type Logger = pino.Logger
