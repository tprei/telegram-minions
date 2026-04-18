import fs from "node:fs"
import path from "node:path"
import type { ChatPlatform } from "../provider/chat-platform.js"
import type { MessageId } from "../provider/types.js"
import type { GooseStreamEvent, GooseMessage, GooseToolRequestContent, GooseToolResponseContent } from "../domain/goose-types.js"
import { isTextContent, isToolRequestContent, isToolResponseContent } from "../domain/goose-types.js"
import type { SessionMeta, SessionDoneState } from "../domain/session-types.js"
import { captureException } from "../sentry.js"
import { loggers } from "../logger.js"
import { isThreadNotFoundError } from "../errors.js"
import type { EngineEventBus } from "../engine/events.js"
import {
  formatToolLine,
  formatActivityLog,
  formatActivityLogPlain,
  formatSessionStart,
  formatPlanStart,
  formatThinkStart,
  formatReviewStart,
  formatDagReviewStart,
  formatShipThinkStart,
  formatShipPlanStart,
  formatShipVerifyStart,
  formatSessionComplete,
  formatSessionError,
  formatAssistantTextChunks,
} from "./format.js"

const log = loggers.observer

// How often to check if buffered text should be flushed (interval-based instead of per-chunk timer).
const FLUSH_CHECK_INTERVAL_MS = 200

// Maximum number of recent tool lines to keep in the activity log.
const MAX_ACTIVITY_LINES = 6

// Maximum text buffer size in bytes before forcing an immediate flush.
// Prevents burst memory spikes when Goose streams text continuously without pausing.
const MAX_TEXT_BUFFER_SIZE = 64 * 1024 // 64 KB

const SCREENSHOTS_DIR = ".screenshots"
const MIN_TEXT_LENGTH = 20
const PRE_TOOL_NARRATION_LIMIT = 60
// Delay between sending multi-chunk messages to avoid Telegram rate limits.
const CHUNK_SEND_DELAY_MS = 100

export type TextCaptureCallback = (sessionId: string, text: string) => void

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface SessionState {
  // Text buffering: Goose streams text token-by-token; we accumulate and flush.
  textBuffer: string
  lastTextAt: number // timestamp of last text chunk
  flushInterval: ReturnType<typeof setInterval> | null
  // Tool activity tracking (per-flush window)
  activityMessageId: MessageId | null
  activityLastSentAt: number
  toolCount: number
  activityLog: string[]
  activityEditTimer: ReturnType<typeof setTimeout> | null
  // Session-level stats for completion recap
  sessionToolCount: number
  // Screenshot tracking
  screenshotPending: boolean
  sentScreenshots: Set<string>
  // Optional callback for capturing flushed text (used by plan mode)
  onTextCapture?: TextCaptureCallback
  // Optional callback fired when the Telegram thread no longer exists
  onDeadThread?: () => void
  // Optional callback fired when tool activity is posted to Telegram — the
  // plain-text activity summary, so API consumers (e.g. the PWA) can surface
  // tool use in the conversation feed just like Telegram users see it.
  onActivityCapture?: (sessionId: string, activityText: string) => void
}

export class Observer {
  private readonly sessions = new Map<string, SessionState>()
  private readonly textFlushDebounceMs: number
  private readonly activityEditDebounceMs: number
  private readonly events?: EngineEventBus

  constructor(
    private readonly platform: ChatPlatform,
    private readonly throttleMs: number,
    opts?: { textFlushDebounceMs?: number; activityEditDebounceMs?: number; events?: EngineEventBus },
  ) {
    this.textFlushDebounceMs = opts?.textFlushDebounceMs ?? 5000
    this.activityEditDebounceMs = opts?.activityEditDebounceMs ?? 5000
    this.events = opts?.events
  }

  async onSessionStart(
    meta: SessionMeta,
    task: string,
    onTextCapture?: TextCaptureCallback,
    onDeadThread?: () => void,
    onActivityCapture?: (sessionId: string, activityText: string) => void,
  ): Promise<void> {
    this.sessions.set(meta.sessionId, {
      textBuffer: "",
      lastTextAt: 0,
      flushInterval: null,
      activityMessageId: null,
      activityLastSentAt: 0,
      toolCount: 0,
      activityLog: [],
      activityEditTimer: null,
      sessionToolCount: 0,
      screenshotPending: false,
      sentScreenshots: new Set(),
      onTextCapture,
      onDeadThread,
      onActivityCapture,
    })
    const msg = meta.mode === "ship-think"
      ? formatShipThinkStart(meta.repo, meta.topicName, task)
      : meta.mode === "ship-plan"
      ? formatShipPlanStart(meta.repo, meta.topicName, task)
      : meta.mode === "ship-verify"
      ? formatShipVerifyStart(meta.repo, meta.topicName, task)
      : meta.mode === "think"
      ? formatThinkStart(meta.repo, meta.topicName, task)
      : meta.mode === "plan"
      ? formatPlanStart(meta.repo, meta.topicName, task)
      : meta.mode === "review"
      ? formatReviewStart(meta.repo, meta.topicName, task)
      : meta.mode === "dag-review"
      ? formatDagReviewStart(meta.repo, meta.topicName, task)
      : formatSessionStart(meta.repo, meta.topicName, task)
    await this.safeSendMessage(meta, msg)
  }

  private async safeSendMessage(
    meta: SessionMeta,
    html: string,
  ): Promise<{ ok: boolean; messageId: MessageId | null }> {
    try {
      return await this.platform.chat.sendMessage(html, String(meta.threadId))
    } catch (err) {
      if (isThreadNotFoundError(err)) {
        log.warn({ threadId: meta.threadId, slug: meta.topicName }, "thread not found, triggering cleanup")
        const state = this.sessions.get(meta.sessionId)
        state?.onDeadThread?.()
        return { ok: false, messageId: null }
      }
      throw err
    }
  }

  async onEvent(meta: SessionMeta, event: GooseStreamEvent): Promise<void> {
    switch (event.type) {
      case "message":
        await this.handleMessage(meta, event.message)
        break

      case "error":
        await this.flushTextBuffer(meta)
        await this.safeSendMessage(meta, formatSessionError(meta.topicName, event.error))
        break

      case "complete":
      case "notification":
        break
    }
  }

  private async scanAndSendScreenshots(meta: SessionMeta): Promise<void> {
    const state = this.sessions.get(meta.sessionId)
    if (!state?.screenshotPending) return

    state.screenshotPending = false
    const dir = path.join(meta.cwd, SCREENSHOTS_DIR)

    try {
      const entries = fs.readdirSync(dir)
      for (const entry of entries) {
        if (!entry.endsWith(".png")) continue
        if (state.sentScreenshots.has(entry)) continue

        const filePath = path.join(dir, entry)
        state.sentScreenshots.add(entry)
        await this.platform.files?.sendPhoto(filePath, String(meta.threadId), `📸 ${entry}`)
        if (this.events) {
          void this.events.emit({
            type: "screenshot_captured",
            sessionId: meta.sessionId,
            path: filePath,
            timestamp: Date.now(),
          })
        }
      }
    } catch {
      // Directory may not exist yet
    }
  }

  private async handleMessage(meta: SessionMeta, message: GooseMessage): Promise<void> {
    // Process tool responses from any role (user messages carry toolResponse blocks)
    for (const block of message.content) {
      if (isToolResponseContent(block)) {
        await this.handleToolResponse(meta, block)
      }
    }

    if (message.role !== "assistant") return

    await this.scanAndSendScreenshots(meta)

    for (const block of message.content) {
      if (isTextContent(block)) {
        if (block.text) {
          this.bufferText(meta, block.text)
        }
      } else if (isToolRequestContent(block)) {
        // Flush buffered text before showing tool activity
        await this.flushTextBuffer(meta, "tool")
        await this.handleToolRequest(meta, block)
      }
    }
  }

  private async handleToolResponse(meta: SessionMeta, block: GooseToolResponseContent): Promise<void> {
    const result = block.toolResult
    if (!result) return

    // toolResult can be an array of content blocks or a single object
    const items = Array.isArray(result) ? result : [result]

    for (const item of items) {
      if (
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        (item as { type: string }).type === "image" &&
        "data" in item
      ) {
        const imageItem = item as { type: string; data: string; mimeType?: string }
        try {
          const buffer = Buffer.from(imageItem.data, "base64")
          const ext = imageItem.mimeType === "image/jpeg" ? "jpg" : "png"
          await this.platform.files?.sendPhotoBuffer(buffer, `screenshot.${ext}`, String(meta.threadId))
        } catch (err) {
          log.warn({ err, sessionId: meta.sessionId }, "failed to send base64 screenshot")
        }
      }
    }
  }

  private bufferText(meta: SessionMeta, chunk: string): void {
    const state = this.sessions.get(meta.sessionId)
    if (!state) return

    state.textBuffer += chunk
    state.lastTextAt = Date.now()

    // Force immediate flush if buffer exceeds size cap to prevent memory spikes
    if (state.textBuffer.length >= MAX_TEXT_BUFFER_SIZE) {
      this.flushTextBuffer(meta).catch((err) => {
        log.error({ err, sessionId: meta.sessionId }, "flush error")
        captureException(err, { operation: "observer.flush", sessionId: meta.sessionId })
      })
      return
    }

    if (state.flushInterval === null) {
      state.flushInterval = setInterval(() => {
        const currentState = this.sessions.get(meta.sessionId)
        if (!currentState) {
          if (state.flushInterval !== null) {
            clearInterval(state.flushInterval)
            state.flushInterval = null
          }
          return
        }

        const now = Date.now()
        if (now - currentState.lastTextAt >= this.textFlushDebounceMs && currentState.textBuffer.length > 0) {
          this.flushTextBuffer(meta).catch((err) => {
            log.error({ err, sessionId: meta.sessionId }, "flush error")
            captureException(err, { operation: "observer.flush", sessionId: meta.sessionId })
          })
        }
      }, FLUSH_CHECK_INTERVAL_MS)
    }
  }

  private async flushTextBuffer(
    meta: SessionMeta,
    reason: "timer" | "tool" | "end" = "timer",
  ): Promise<void> {
    const state = this.sessions.get(meta.sessionId)
    if (!state) return

    if (state.flushInterval !== null) {
      clearInterval(state.flushInterval)
      state.flushInterval = null
    }

    await this.scanAndSendScreenshots(meta)

    const text = state.textBuffer.trim()
    state.textBuffer = ""

    if (!text) return

    if (state.onTextCapture) {
      state.onTextCapture(meta.sessionId, text)
    }

    if (this.events) {
      void this.events.emit({
        type: "assistant_text",
        sessionId: meta.sessionId,
        text,
        timestamp: Date.now(),
      })
    }

    if (text.length < MIN_TEXT_LENGTH) return
    if (reason === "tool" && text.length < PRE_TOOL_NARRATION_LIMIT) return

    const toolLines = state.activityLog.length > 0 ? [...state.activityLog] : undefined
    const toolCount = state.toolCount > 0 ? state.toolCount : undefined

    // Get formatted chunks (may be single message or multiple with headers like "1/3")
    const chunks = formatAssistantTextChunks(meta.topicName, text, toolLines, toolCount)

    // Send each chunk as a separate message with a small delay to avoid rate limits
    for (let i = 0; i < chunks.length; i++) {
      await this.safeSendMessage(meta, chunks[i])
      // Add delay between chunks (but not after the last one)
      if (i < chunks.length - 1) {
        await sleep(CHUNK_SEND_DELAY_MS)
      }
    }
    if (state.activityEditTimer !== null) {
      clearTimeout(state.activityEditTimer)
      state.activityEditTimer = null
    }
    state.activityMessageId = null
    state.activityLog = []
    state.toolCount = 0
  }

  private async handleToolRequest(
    meta: SessionMeta,
    block: GooseToolRequestContent,
  ): Promise<void> {
    if ("error" in block.toolCall) return

    const { name: rawName, arguments: rawArgs } = block.toolCall
    const name = typeof rawName === "string" && rawName.length > 0 ? rawName : "unknown"
    const args: Record<string, unknown> = rawArgs && typeof rawArgs === "object" ? rawArgs as Record<string, unknown> : {}
    if (name === "unknown") {
      log.warn({ sessionId: meta.sessionId, toolCallId: block.id }, "toolRequest missing name — treating as 'unknown'")
    }
    const now = Date.now()
    const state = this.sessions.get(meta.sessionId)
    if (!state) return

    if (name.includes("browser_take_screenshot")) {
      state.screenshotPending = true
    }

    state.toolCount++
    state.sessionToolCount++

    // Append to rolling activity log
    const line = formatToolLine(name, args)
    state.activityLog.push(line)
    if (state.activityLog.length > MAX_ACTIVITY_LINES) {
      state.activityLog.shift()
    }

    const html = formatActivityLog(state.activityLog, state.toolCount)

    if (now - state.activityLastSentAt < this.throttleMs && state.activityMessageId !== null) {
      state.activityLastSentAt = now
      if (state.activityEditTimer !== null) clearTimeout(state.activityEditTimer)
      const messageId = state.activityMessageId
      state.activityEditTimer = setTimeout(() => {
        state.activityEditTimer = null
        const latestHtml = formatActivityLog(state.activityLog, state.toolCount)
        this.platform.chat.editMessage(messageId, latestHtml, String(meta.threadId)).catch((err) => {
          log.warn({ err, sessionId: meta.sessionId }, "edit error")
        })
      }, this.activityEditDebounceMs)
      return
    }

    if (state.activityEditTimer !== null) {
      clearTimeout(state.activityEditTimer)
      state.activityEditTimer = null
    }

    // Outside throttle window or no existing message: send new activity message
    state.activityLastSentAt = now
    const { messageId } = await this.safeSendMessage(meta, html)
    state.activityMessageId = messageId

    const activityPlain = formatActivityLogPlain(state.activityLog, state.toolCount)

    if (state.onActivityCapture) {
      state.onActivityCapture(meta.sessionId, activityPlain)
    }

    if (this.events) {
      void this.events.emit({
        type: "assistant_activity",
        sessionId: meta.sessionId,
        activity: activityPlain,
        timestamp: Date.now(),
      })
    }
  }

  async onSessionComplete(
    meta: SessionMeta,
    finalState: SessionDoneState,
    durationMs: number,
  ): Promise<void> {
    const state = this.sessions.get(meta.sessionId)
    const sessionToolCount = state?.sessionToolCount ?? 0
    // Send any pending screenshots before posting summary
    if (state) state.screenshotPending = true
    await this.scanAndSendScreenshots(meta)
    // Flush any remaining buffered text before posting summary
    await this.flushTextBuffer(meta, "end")
    this.sessions.delete(meta.sessionId)

    if (finalState === "errored") {
      await this.safeSendMessage(meta, formatSessionError(meta.topicName, "Session ended with an error. Check logs."))
    } else {
      await this.safeSendMessage(meta, formatSessionComplete(meta.topicName, durationMs, meta.totalTokens, sessionToolCount, meta.totalCostUsd, meta.numTurns))
    }
  }

  async flushAndComplete(
    meta: SessionMeta,
    _finalState: SessionDoneState,
    _durationMs: number,
  ): Promise<void> {
    await this.flushTextBuffer(meta)
    this.sessions.delete(meta.sessionId)
  }

  clearSession(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state?.flushInterval !== null) clearInterval(state!.flushInterval)
    if (state?.activityEditTimer !== null) clearTimeout(state!.activityEditTimer)
    this.sessions.delete(sessionId)
  }
}
