#!/usr/bin/env node
import "dotenv/config"
import { createMinion, configFromEnv } from "./index.js"
import { captureException, flush as flushSentry } from "./sentry.js"
import { loggers } from "./logger.js"
import { isLocalEnvironment, applyLocalDefaults } from "./config/local-defaults.js"
import { runDoctor } from "./config/doctor.js"

const args = process.argv.slice(2)
const subcommand = args[0]

if (subcommand === "doctor") {
  const result = await runDoctor()
  process.exit(result.ok ? 0 : 1)
}

if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
  process.stdout.write(`telegram-minion — orchestration engine for autonomous coding agents

Usage:
  telegram-minion                  Start the engine (reads .env / env vars)
  telegram-minion doctor           Run local setup diagnostics
  telegram-minion --help           Show this message
  telegram-minion --version        Show package version

Environment variables — see .env.example. Running outside a container triggers
"local mode": sensible defaults are filled in for WORKSPACE_ROOT, MINION_API_TOKEN,
API_PORT, GITHUB_TOKEN (via \`gh auth token\`), and CORS_ALLOWED_ORIGINS.
`)
  process.exit(0)
}

if (subcommand === "--version" || subcommand === "-v") {
  const { default: pkg } = await import("../package.json", { with: { type: "json" } })
  process.stdout.write(`${pkg.version}\n`)
  process.exit(0)
}

let localNotices: string[] = []
if (isLocalEnvironment()) {
  localNotices = applyLocalDefaults()
}

const config = configFromEnv()
const log = loggers.main

for (const notice of localNotices) {
  log.info({ localMode: true }, notice)
}

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
