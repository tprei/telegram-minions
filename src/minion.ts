import path from "node:path"
import { fileURLToPath } from "node:url"
import http from "node:http"
import fs from "node:fs"
import type { MinionConfig } from "./config-types.js"
import { TelegramClient } from "./telegram.js"
import { Observer } from "./observer.js"
import { Dispatcher } from "./dispatcher.js"
import { createApiServer, StateBroadcaster, type DispatcherApi } from "./api-server.js"

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
  const telegram = new TelegramClient(config.telegram.botToken, config.telegram.chatId)
  const observer = new Observer(telegram, config.observer.activityThrottleMs)
  const dispatcher = new Dispatcher(telegram, observer, config)
  const broadcaster = new StateBroadcaster()

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
      broadcaster,
    })
  }

  return {
    async start() {
      // Start API server first
      if (apiServer) {
        await new Promise<void>((resolve) => {
          apiServer!.listen(apiPort!, () => {
            process.stderr.write(`minion: API server listening on port ${apiPort}\n`)
            resolve()
          })
        })
      }

      await dispatcher.loadPersistedSessions()
      dispatcher.startCleanupTimer()
      await dispatcher.start()
    },
    stop() {
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
