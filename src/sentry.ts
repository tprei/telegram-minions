import type { Scope } from "@sentry/node"
import { loggers } from "./logger.js"

type SentryModule = typeof import("@sentry/node")

let sentry: SentryModule | null = null
const log = loggers.sentry

export async function initSentry(dsn: string | undefined): Promise<void> {
  if (!dsn) {
    log.info("no DSN configured, error reporting disabled")
    return
  }

  try {
    const mod = await import("@sentry/node") as SentryModule
    mod.init({
      dsn,
      environment: process.env["NODE_ENV"] ?? "production",
      tracesSampleRate: 0.2,
      beforeSend(event) {
        // Strip any env vars that might leak into breadcrumbs
        if (event.extra) {
          delete event.extra["env"]
        }
        return event
      },
    })
    sentry = mod
    log.info("initialized")
  } catch (err) {
    log.error({ err }, "failed to initialize")
  }
}

export function captureException(
  err: unknown,
  context?: Record<string, unknown>,
): void {
  if (!sentry) return
  sentry.withScope((scope: Scope) => {
    if (context) {
      scope.setExtras(context)
    }
    sentry!.captureException(err)
  })
}

export function setContext(name: string, data: Record<string, unknown>): void {
  if (!sentry) return
  sentry.setContext(name, data)
}

export function addBreadcrumb(breadcrumb: {
  category?: string
  message?: string
  level?: "info" | "warning" | "error"
  data?: Record<string, unknown>
}): void {
  if (!sentry) return
  sentry.addBreadcrumb(breadcrumb)
}

export async function flush(timeoutMs = 2000): Promise<void> {
  if (!sentry) return
  try {
    await sentry.flush(timeoutMs)
  } catch {
    // Best-effort flush before exit
  }
}
