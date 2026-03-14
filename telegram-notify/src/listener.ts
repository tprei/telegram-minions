import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readCache } from "./sessions.js"
import { safeInject } from "./safe-inject.js"
import type { TelegramUpdate } from "./types.js"

const require = createRequire(import.meta.url)
const dotenv = require("dotenv")

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(scriptDir, "..", ".env") })

if (!process.env["LISTENER_ENABLED"]) {
  process.stderr.write("listener: LISTENER_ENABLED not set — exiting\n")
  process.exit(0)
}

const token = process.env["TELEGRAM_BOT_TOKEN"]
const chatId = process.env["TELEGRAM_CHAT_ID"]

if (!token || !chatId) {
  throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set")
}

const allowedUserIds: number[] = (process.env["ALLOWED_USER_IDS"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map(Number)

async function sendReply(threadId: number, reason: string): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: reason, message_thread_id: threadId }),
    })
    if (!res.ok) {
      const body = await res.text()
      process.stderr.write(`listener: sendReply HTTP ${res.status}: ${body}\n`)
    }
  } catch (err) {
    process.stderr.write(`listener: sendReply fetch failed: ${err}\n`)
  }
}

async function poll(offset: number): Promise<number> {
  let res: Response
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offset, timeout: 30, allowed_updates: ["message"] }),
    })
  } catch (err) {
    process.stderr.write(`listener: getUpdates fetch failed: ${err}\n`)
    return offset
  }

  if (!res.ok) {
    const body = await res.text()
    process.stderr.write(`listener: getUpdates HTTP ${res.status}: ${body}\n`)
    return offset
  }

  const data = (await res.json()) as { ok: boolean; result: TelegramUpdate[] }

  if (!data.ok) {
    process.stderr.write(`listener: getUpdates response ok=false\n`)
    return offset
  }

  const updates = data.result

  if (updates.length === 0) {
    return offset
  }

  for (const update of updates) {
    try {
      const message = update.message
      if (!message) continue

      if (message.chat.id.toString() !== chatId) continue

      if (!allowedUserIds.includes(message.from?.id ?? -1)) continue

      if (message.message_thread_id === undefined) continue

      const threadKey = message.message_thread_id.toString()
      const cache = readCache()
      if (!(threadKey in cache)) continue

      if (!message.text) continue

      const entry = cache[threadKey]
      const result = await safeInject(message.text, entry.pane_id)

      if (!result.ok) {
        await sendReply(message.message_thread_id, result.reason)
      }
    } catch (err) {
      process.stderr.write(`listener: error processing update ${update.update_id}: ${err}\n`)
    }
  }

  return Math.max(...updates.map((u) => u.update_id)) + 1
}

async function main(): Promise<void> {
  let offset = 0
  while (true) {
    offset = await poll(offset)
  }
}

main()
