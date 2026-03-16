import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { gatherContext } from "./context.js"
import { formatUserPrompt, formatAssistantReply, formatToolActivity } from "./format.js"
import { sendMessage, editMessage } from "./telegram.js"
import { upsertSession, removeSession } from "./sessions.js"
import {
  getOrCreateTopic,
  lookupTopic,
  deleteTopic,
  removeTopicFromCache,
  renameTopic,
  markTopicRenamed,
  isTopicRenamed,
} from "./topics.js"
import { extractLastInstruction } from "./transcript.js"
import { savePromptInfo, loadPromptInfo, clearPromptInfo, saveActivityInfo, loadActivityInfo, incrementToolCount } from "./prompt-cache.js"
import type { HookInput } from "./types.js"

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

    let input: HookInput
    try {
      input = JSON.parse(raw) as HookInput
    } catch {
      process.stderr.write(`notify: invalid JSON on stdin: ${raw.slice(0, 200)}\n`)
      process.stdout.write("{}\n")
      process.exit(0)
    }

    if (process.env["TELEGRAM_NOTIFY_DISABLED"]) {
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

    if (input.hook_event_name === "SessionEnd") {
      const threadId = lookupTopic(input.session_id)
      if (threadId !== null) {
        const deleted = await deleteTopic(token, chatId, threadId)
        if (deleted) {
          removeSession(threadId)
          removeTopicFromCache(input.session_id)
        }
      }
      process.stdout.write("{}\n")
      process.exit(0)
      return
    }

    const topicName = `${ctx.project} (${input.session_id.slice(0, 6)})`
    const threadId = await getOrCreateTopic(token, chatId, topicName, input.session_id)

    if (threadId !== null && process.env["LISTENER_ENABLED"]) {
      upsertSession(threadId, {
        session_id: input.session_id,
        pane_id: ctx.paneId,
        cwd: input.cwd,
        ts: Date.now(),
      })
    }

    if (input.hook_event_name === "UserPromptSubmit") {
      const message = formatUserPrompt(input, ctx)
      const result = await sendMessage(token, chatId, message, threadId ?? undefined)
      if (result.ok && result.messageId !== null) {
        savePromptInfo(input.session_id, result.messageId, Date.now())
      }
      if (threadId !== null && !isTopicRenamed(input.session_id) && input.prompt) {
        const prefix = `${ctx.project} · `
        const maxPromptLen = 64 - prefix.length
        const truncatedPrompt = input.prompt.length > maxPromptLen
          ? input.prompt.slice(0, maxPromptLen) + "…"
          : input.prompt
        await renameTopic(token, chatId, threadId, `${prefix}${truncatedPrompt}`)
        markTopicRenamed(input.session_id)
      }
    } else if (input.hook_event_name === "PostToolUse") {
      const toolName = input.tool_name ?? ""
      const toolInput = input.tool_input ?? {}
      const promptInfo = loadPromptInfo(input.session_id)
      if (promptInfo !== null) {
        const activityInfo = loadActivityInfo(input.session_id)
        const now = Date.now()
        const throttleMs = Number(process.env["ACTIVITY_THROTTLE_MS"] ?? 3000)
        const tooSoon =
          activityInfo !== null && now - activityInfo.activityTimestamp < throttleMs

        if (tooSoon) {
          incrementToolCount(input.session_id)
        } else {
          const newToolCount = (activityInfo?.toolCount ?? 0) + 1
          const message = formatToolActivity(toolName, toolInput, newToolCount)
          if (activityInfo === null) {
            const result = await sendMessage(
              token,
              chatId,
              message,
              threadId ?? undefined,
              promptInfo.messageId,
            )
            if (result.ok && result.messageId !== null) {
              saveActivityInfo(input.session_id, result.messageId, now, newToolCount)
            }
          } else {
            await editMessage(token, chatId, activityInfo.activityMessageId, message, threadId ?? undefined)
            saveActivityInfo(input.session_id, activityInfo.activityMessageId, now, newToolCount)
          }
        }
      }
    } else if (input.hook_event_name === "Stop") {
      const cached = loadPromptInfo(input.session_id)
      const elapsedMs = cached ? Date.now() - cached.timestamp : undefined
      const replyToMessageId = cached?.messageId ?? undefined
      const lastInstruction = extractLastInstruction(input.transcript_path)
      const message = formatAssistantReply(input, ctx, lastInstruction, elapsedMs)
      await sendMessage(token, chatId, message, threadId ?? undefined, replyToMessageId)
      clearPromptInfo(input.session_id)
    }
  } catch (err) {
    process.stderr.write(`notify: unexpected error: ${err}\n`)
  }

  process.stdout.write("{}\n")
  process.exit(0)
}

main()
