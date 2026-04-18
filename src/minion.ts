import path from "node:path"
import { fileURLToPath } from "node:url"
import http from "node:http"
import fs from "node:fs"
import type { MinionConfig } from "./config/config-types.js"
import { Observer } from "./telegram/observer.js"
import { MinionEngine } from "./engine/engine.js"
import { TelegramConnector } from "./connectors/telegram-connector.js"
import { HttpConnector } from "./connectors/http-connector.js"
import { loggers } from "./logger.js"
import { initSentry } from "./sentry.js"
import { GitHubTokenProvider } from "./github/index.js"
import { EventBus } from "./events/event-bus.js"
import { EngineEventBus } from "./engine/events.js"
import { DEFAULT_LOOPS } from "./loops/index.js"

const log = loggers.minion

export interface MinionInstance {
  start(): Promise<void>
  stop(): void
  getApiServer(): http.Server | undefined
}

export interface MinionOptions {
  apiPort?: number
}

function findUiDistPath(): string {
  const possiblePaths = [
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui", "dist"),
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist"),
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "ui"),
  ]

  for (const p of possiblePaths) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        return p
      }
    } catch {
      // Continue to next path
    }
  }

  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui", "dist")
}

export function createMinion(config: MinionConfig, options?: MinionOptions): MinionInstance {
  const telegramConnector = new TelegramConnector({
    botToken: config.telegram.botToken,
    chatId: config.telegram.chatId,
    minSendIntervalMs: config.telegramQueue.minSendIntervalMs,
  })

  const engineEvents = new EngineEventBus()
  const observer = new Observer(telegramConnector.platform, config.observer.activityThrottleMs, {
    textFlushDebounceMs: config.observer.textFlushDebounceMs,
    activityEditDebounceMs: config.observer.activityEditDebounceMs,
    events: engineEvents,
  })

  const eventBus = new EventBus()
  const tokenProvider = new GitHubTokenProvider(config.githubApp)
  tokenProvider.setTokenFilePath(path.join(config.workspace.root, ".github-token"))
  const engine = new MinionEngine(
    telegramConnector.platform,
    observer,
    config,
    eventBus,
    tokenProvider,
    engineEvents,
  )
  telegramConnector.attach(engine)

  const apiPort = options?.apiPort ?? (process.env["API_PORT"] ? parseInt(process.env["API_PORT"], 10) : undefined)
  const httpConnector = apiPort
    ? new HttpConnector({
        port: apiPort,
        uiDistPath: findUiDistPath(),
        chatId: config.telegram.chatId,
        botToken: config.telegram.botToken,
        apiToken: config.api?.apiToken,
        corsAllowedOrigins: config.api?.corsAllowedOrigins,
        repos: config.repos,
      })
    : null
  httpConnector?.attach(engine)

  return {
    async start() {
      await initSentry(config.sentry?.dsn)

      if (httpConnector) {
        await httpConnector.start()
        log.info({ port: apiPort }, "API server listening")
      }

      await tokenProvider.refreshEnv()
      tokenProvider.startPeriodicRefresh()
      await engine.loadPersistedSessions()
      engine.startCleanupTimer()
      await engine.startLoops(DEFAULT_LOOPS)
      await engine.start()
    },
    stop() {
      tokenProvider.stopPeriodicRefresh()
      engine.stop()
      httpConnector?.detach()
      telegramConnector.detach()
    },
    getApiServer() {
      return httpConnector?.getServer() ?? undefined
    },
  }
}
