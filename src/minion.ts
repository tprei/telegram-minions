import path from "node:path"
import { fileURLToPath } from "node:url"
import http from "node:http"
import fs from "node:fs"
import type { MinionConfig } from "./config/config-types.js"
import { TelegramClient } from "./telegram/telegram.js"
import { TelegramPlatform } from "./telegram/telegram-platform.js"
import { Observer } from "./telegram/observer.js"
import { Dispatcher } from "./orchestration/dispatcher.js"
import { createApiServer, StateBroadcaster, type DispatcherApi } from "./api-server.js"
import { loggers } from "./logger.js"
import { initSentry } from "./sentry.js"
import { GitHubTokenProvider } from "./github/index.js"
import { EventBus } from "./events/event-bus.js"
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
  // Try multiple locations for UI dist
  const possiblePaths = [
    // From compiled dist/
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui", "dist"),
    // From source src/
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist"),
    // From assets/
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

  // Default to relative path
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui", "dist")
}

export function createMinion(config: MinionConfig, options?: MinionOptions): MinionInstance {
  const telegram = new TelegramClient(config.telegram.botToken, config.telegram.chatId, config.telegramQueue.minSendIntervalMs)
  const platform = new TelegramPlatform(telegram, config.telegram.chatId)
  const observer = new Observer(platform, config.observer.activityThrottleMs, {
    textFlushDebounceMs: config.observer.textFlushDebounceMs,
    activityEditDebounceMs: config.observer.activityEditDebounceMs,
  })
  const broadcaster = new StateBroadcaster()
  const eventBus = new EventBus()
  const tokenProvider = new GitHubTokenProvider(config.githubApp)
  tokenProvider.setTokenFilePath(path.join(config.workspace.root, ".github-token"))
  const dispatcher = new Dispatcher(platform, observer, config, eventBus, broadcaster, tokenProvider)

  let apiServer: http.Server | undefined

  // Set up API server if port is configured
  const apiPort = options?.apiPort ?? (process.env["API_PORT"] ? parseInt(process.env["API_PORT"], 10) : undefined)
  const uiDistPath = findUiDistPath()

  if (apiPort) {
    const dispatcherApi: DispatcherApi = {
      getSessions: () => dispatcher.getSessions(),
      getTopicSessions: () => dispatcher.getTopicSessions(),
      getDags: () => dispatcher.getDags(),
      getSessionState: (threadId: number) => dispatcher.getSessionState(threadId),
      sendReply: (threadId: number, message: string) => dispatcher.apiSendReply(threadId, message),
      stopSession: (threadId: number) => dispatcher.apiStopSession(threadId),
      closeSession: (threadId: number) => dispatcher.apiCloseSession(threadId),
    }

    apiServer = createApiServer(dispatcherApi, {
      port: apiPort,
      uiDistPath,
      chatId: config.telegram.chatId,
      botToken: config.telegram.botToken,
      broadcaster,
    })
  }

  return {
    async start() {
      await initSentry(config.sentry?.dsn)

      // Start API server first
      if (apiServer) {
        await new Promise<void>((resolve) => {
          apiServer!.listen(apiPort!, () => {
            log.info({ port: apiPort }, "API server listening")
            resolve()
          })
        })
      }

      await tokenProvider.refreshEnv()
      tokenProvider.startPeriodicRefresh()
      await dispatcher.loadPersistedSessions()
      dispatcher.startCleanupTimer()
      await dispatcher.startLoops(DEFAULT_LOOPS)
      await dispatcher.start()
    },
    stop() {
      tokenProvider.stopPeriodicRefresh()
      dispatcher.stop()
      if (apiServer) {
        apiServer.close()
      }
    },
    getApiServer() {
      return apiServer
    },
  }
}
