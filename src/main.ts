import { configFromEnv } from "./config-env.js"
import { initSentry, captureException, flush as flushSentry } from "./sentry.js"
import { TelegramClient } from "./telegram.js"
import { Observer } from "./observer.js"
import { Dispatcher } from "./dispatcher.js"

const config = configFromEnv()

initSentry(config.sentry?.dsn)

const telegram = new TelegramClient(config.telegram.botToken, config.telegram.chatId)
const observer = new Observer(telegram, config.observer.activityThrottleMs)
const dispatcher = new Dispatcher(telegram, observer, config)

process.on("SIGTERM", () => {
  process.stderr.write("main: received SIGTERM, shutting down\n")
  dispatcher.stop()
  flushSentry().finally(() => process.exit(0))
})

process.on("SIGINT", () => {
  process.stderr.write("main: received SIGINT, shutting down\n")
  dispatcher.stop()
  flushSentry().finally(() => process.exit(0))
})

process.on("uncaughtException", (err) => {
  process.stderr.write(`main: uncaught exception: ${err}\n`)
  captureException(err, { handler: "uncaughtException" })
  flushSentry().finally(() => process.exit(1))
})

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`main: unhandled rejection: ${reason}\n`)
  captureException(reason, { handler: "unhandledRejection" })
  flushSentry().finally(() => process.exit(1))
})

process.stderr.write(`main: starting telegram-minions\n`)
process.stderr.write(`main: chatId=${config.telegram.chatId}\n`)
process.stderr.write(`main: allowedUsers=${config.telegram.allowedUserIds.join(",")}\n`)
process.stderr.write(`main: workspace=${config.workspace.root}\n`)
process.stderr.write(`main: maxSessions=${config.workspace.maxConcurrentSessions}\n`)

dispatcher.loadPersistedSessions().then(() => {
  dispatcher.startCleanupTimer()
  return dispatcher.start()
}).catch((err) => {
  process.stderr.write(`main: dispatcher crashed: ${err}\n`)
  captureException(err, { handler: "dispatcher.start" })
  flushSentry().finally(() => process.exit(1))
})
