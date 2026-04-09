import path from "node:path"
import { fileURLToPath } from "node:url"
import http from "node:http"
import fs from "node:fs"
import type { MinionConfig } from "./config/config-types.js"
import type { ChatPlatform } from "./provider/chat-platform.js"
import { TelegramClient } from "./telegram/telegram.js"
import { createTelegramPlatform } from "./telegram/platform.js"
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
  /**
   * Pre-built ChatPlatform instance. Required when `config.platform.type` is
   * `"custom"`. Ignored when platform type is `"telegram"` (the built-in
   * adapter is constructed automatically from config).
   */
  platform?: ChatPlatform
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

/**
 * Build a ChatPlatform from config + options.
 *
 * - `"telegram"` (default): constructs TelegramClient and wraps it in the
 *   Telegram adapter. Uses `config.telegram` / `config.telegramQueue`.
 * - `"custom"`: returns the caller-supplied `options.platform`.
 *   Throws if `options.platform` is not provided.
 */
export function buildPlatform(config: MinionConfig, options?: MinionOptions): ChatPlatform {
  const platformConfig = config.platform

  if (platformConfig?.type === "custom") {
    if (!options?.platform) {
      throw new Error(
        'MinionConfig.platform.type is "custom" but no ChatPlatform instance was provided in MinionOptions.platform',
      )
    }
    return options.platform
  }

  const botToken = platformConfig?.type === "telegram" ? platformConfig.botToken : config.telegram.botToken
  const chatId = platformConfig?.type === "telegram" ? platformConfig.chatId : config.telegram.chatId
  const minSendIntervalMs = platformConfig?.type === "telegram"
    ? platformConfig.minSendIntervalMs
    : config.telegramQueue.minSendIntervalMs

  const telegram = new TelegramClient(botToken, chatId, minSendIntervalMs)
  return createTelegramPlatform(telegram, chatId)
}

export function createMinion(config: MinionConfig, options?: MinionOptions): MinionInstance {
  const platform = buildPlatform(config, options)
  const observer = new Observer(platform.chat, config.observer.activityThrottleMs, {
    textFlushDebounceMs: config.observer.textFlushDebounceMs,
    activityEditDebounceMs: config.observer.activityEditDebounceMs,
  }, platform.files ?? undefined)
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
      getSessionState: (threadId: string) => dispatcher.getSessionState(threadId),
      sendReply: (threadId: string, message: string) => dispatcher.apiSendReply(threadId, message),
      stopSession: (threadId: string) => dispatcher.apiStopSession(threadId),
      closeSession: (threadId: string) => dispatcher.apiCloseSession(threadId),
    }

    apiServer = createApiServer(dispatcherApi, {
      port: apiPort,
      uiDistPath,
      chatId: platform.chatId,
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
