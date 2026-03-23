import type { MinionConfig } from "./config-types.js"
import { TelegramClient } from "./telegram.js"
import { Observer } from "./observer.js"
import { Dispatcher } from "./dispatcher.js"

export interface MinionInstance {
  start(): Promise<void>
  stop(): void
}

export function createMinion(config: MinionConfig): MinionInstance {
  const telegram = new TelegramClient(config.telegram.botToken, config.telegram.chatId)
  const observer = new Observer(telegram, config.observer.activityThrottleMs)
  const dispatcher = new Dispatcher(telegram, observer, config)

  return {
    async start() {
      await dispatcher.loadPersistedSessions()
      dispatcher.startCleanupTimer()
      await dispatcher.start()
    },
    stop() {
      dispatcher.stop()
    },
  }
}
