#!/usr/bin/env node
import "dotenv/config"
import { createMinion, configFromEnv } from "./index.js"
import { initSentry, captureException, flush as flushSentry } from "./sentry.js"

const config = configFromEnv()
const minion = createMinion(config)

await initSentry(config.sentry?.dsn)

process.stderr.write(`main: starting telegram-minions\n`)
process.stderr.write(`main: chatId=${config.telegram.chatId}\n`)
process.stderr.write(`main: allowedUsers=${config.telegram.allowedUserIds.join(",")}\n`)
process.stderr.write(`main: workspace=${config.workspace.root}\n`)
process.stderr.write(`main: maxSessions=${config.workspace.maxConcurrentSessions}\n`)

process.on("SIGTERM", () => {
  process.stderr.write("main: received SIGTERM, shutting down\n")
  minion.stop()
  flushSentry().finally(() => process.exit(0))
})

process.on("SIGINT", () => {
  process.stderr.write("main: received SIGINT, shutting down\n")
  minion.stop()
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

minion.start().catch((err) => {
  process.stderr.write(`main: minion crashed: ${err}\n`)
  captureException(err, { handler: "minion.start" })
  flushSentry().finally(() => process.exit(1))
})
