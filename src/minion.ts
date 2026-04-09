import path from "node:path"
import { fileURLToPath } from "node:url"
import http from "node:http"
import fs from "node:fs"
import type { MinionConfig } from "./config/config-types.js"
import { TelegramClient } from "./telegram/telegram.js"
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
  // Thin adapter: convert TelegramClient's numeric IDs to the string-based
  // ChatProvider interface that Observer now expects. Will be replaced when
  // the full Telegram platform adapter is created.
  const observerChat = {
    sendMessage: async (content: string, threadId?: string, replyToMessageId?: string) => {
      const result = await telegram.sendMessage(content, threadId ? Number(threadId) : undefined, replyToMessageId ? Number(replyToMessageId) : undefined)
      return { ok: result.ok, messageId: result.messageId != null ? String(result.messageId) : null }
    },
    editMessage: (messageId: string, content: string, threadId?: string) =>
      telegram.editMessage(Number(messageId), content, threadId ? Number(threadId) : undefined),
  }
  const observerFiles = {
    sendPhoto: async (photoPath: string, threadId?: string, caption?: string) => {
      const id = await telegram.sendPhoto(photoPath, threadId ? Number(threadId) : undefined, caption)
      return id != null ? String(id) : null
    },
    sendPhotoBuffer: async (buffer: Buffer, filename: string, threadId?: string, caption?: string) => {
      const id = await telegram.sendPhotoBuffer(buffer, filename, threadId ? Number(threadId) : undefined, caption)
      return id != null ? String(id) : null
    },
    downloadFile: (fileId: string, destPath: string) => telegram.downloadFile(fileId, destPath),
  }
  const observer = new Observer(observerChat, config.observer.activityThrottleMs, {
    textFlushDebounceMs: config.observer.textFlushDebounceMs,
    activityEditDebounceMs: config.observer.activityEditDebounceMs,
  }, observerFiles)
  const broadcaster = new StateBroadcaster()
  const eventBus = new EventBus()
  const tokenProvider = new GitHubTokenProvider(config.githubApp)
  tokenProvider.setTokenFilePath(path.join(config.workspace.root, ".github-token"))
  const dispatcher = new Dispatcher(telegram, observer, config, eventBus, broadcaster, tokenProvider)

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
