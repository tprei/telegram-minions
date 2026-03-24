import type { Scope } from "@sentry/node"

type SentryModule = typeof import("@sentry/node")

let sentry: SentryModule | null = null

export async function initSentry(dsn: string | undefined): Promise<void> {
  if (!dsn) {
    process.stderr.write("sentry: no DSN configured, error reporting disabled\n")
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
    process.stderr.write("sentry: initialized\n")
  } catch (err) {
    process.stderr.write(`sentry: failed to initialize: ${err}\n`)
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

export function captureMessage(
  message: string,
  level: "info" | "warning" | "error" = "error",
): void {
  if (!sentry) return
  sentry.captureMessage(message, level)
}

export function setTag(key: string, value: string): void {
  if (!sentry) return
  sentry.setTag(key, value)
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
