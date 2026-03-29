#!/usr/bin/env node
import "dotenv/config"
import { createMinion, configFromEnv } from "./index.js"
import { captureException, flush as flushSentry } from "./sentry.js"
import { loggers } from "./logger.js"

const config = configFromEnv()
const log = loggers.main

log.info({ chatId: config.telegram.chatId, allowedUsers: config.telegram.allowedUserIds, workspace: config.workspace.root, maxSessions: config.workspace.maxConcurrentSessions }, "starting telegram-minions")

const minion = createMinion(config)

process.on("SIGTERM", () => {
  log.info("received SIGTERM, shutting down")
  minion.stop()
  flushSentry().finally(() => process.exit(0))
})

process.on("SIGINT", () => {
  log.info("received SIGINT, shutting down")
  minion.stop()
  flushSentry().finally(() => process.exit(0))
})

process.on("uncaughtException", (err) => {
  log.error({ err, handler: "uncaughtException" }, "uncaught exception")
  captureException(err, { handler: "uncaughtException" })
  flushSentry().finally(() => process.exit(1))
})

process.on("unhandledRejection", (reason) => {
  log.error({ reason, handler: "unhandledRejection" }, "unhandled rejection")
  captureException(reason, { handler: "unhandledRejection" })
  flushSentry().finally(() => process.exit(1))
})

minion.start().catch((err) => {
  log.error({ err, handler: "minion.start" }, "minion crashed")
  captureException(err, { handler: "minion.start" })
  flushSentry().finally(() => process.exit(1))
})
