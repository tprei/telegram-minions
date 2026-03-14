import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { gatherContext } from "./context.js"
import { formatNotification } from "./format.js"
import { sendMessage } from "./telegram.js"
import { upsertSession } from "./sessions.js"
import { getOrCreateTopic } from "./topics.js"
import { extractLastInstruction } from "./transcript.js"
import type { StopHookInput } from "./types.js"

const require = createRequire(import.meta.url)
const dotenv = require("dotenv")

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(scriptDir, "..", ".env") })

async function main() {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer)
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim()

    let input: StopHookInput
    try {
      input = JSON.parse(raw) as StopHookInput
    } catch {
      process.stderr.write(`notify: invalid JSON on stdin: ${raw.slice(0, 200)}\n`)
      process.stdout.write("{}\n")
      process.exit(0)
    }

    const token = process.env["TELEGRAM_BOT_TOKEN"]
    const chatId = process.env["TELEGRAM_CHAT_ID"]

    if (!token || !chatId) {
      process.stderr.write("notify: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping\n")
      process.stdout.write("{}\n")
      process.exit(0)
    }

    const ctx = gatherContext(input.cwd)
    const lastInstruction = extractLastInstruction(input.transcript_path)
    const message = formatNotification(input, ctx, lastInstruction)
    const threadId = await getOrCreateTopic(token, chatId, ctx.project)
    if (threadId !== null) {
      upsertSession(threadId, {
        session_id: input.session_id,
        pane_id: ctx.paneId,
        cwd: input.cwd,
        ts: Date.now(),
      })
    }
    await sendMessage(token, chatId, message, threadId ?? undefined)
  } catch (err) {
    process.stderr.write(`notify: unexpected error: ${err}\n`)
  }

  process.stdout.write("{}\n")
  process.exit(0)
}

main()
