import { createMinion, configFromEnv } from "@tprei/telegram-minions"

const minion = createMinion({
  ...configFromEnv(),
  repos: {
    // Add your repo aliases here
    // "my-app": "https://github.com/myorg/my-app",
  },
  // Optional: override system prompts
  // prompts: {
  //   task: "You are a specialized coding agent...",
  // },
  // Optional: custom agent definitions directory
  // agentDefs: {
  //   agentsDir: "./agents",
  // },
})

process.on("SIGTERM", () => { minion.stop(); process.exit(0) })
process.on("SIGINT", () => { minion.stop(); process.exit(0) })

process.on("uncaughtException", (err) => {
  process.stderr.write(`uncaught exception: ${err}\n`)
  process.exit(1)
})

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`unhandled rejection: ${reason}\n`)
  process.exit(1)
})

await minion.start()
