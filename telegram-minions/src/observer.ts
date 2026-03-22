import type { TelegramClient } from "./telegram.js"
import type { GooseStreamEvent, GooseMessage, GooseToolRequestContent, SessionMeta } from "./types.js"
import {
  formatToolLine,
  formatActivityLog,
  formatSessionStart,
  formatSessionComplete,
  formatSessionError,
  formatAssistantText,
} from "./format.js"

// Text flush delay: if no new text chunk arrives within this window, send what's buffered.
const TEXT_FLUSH_DEBOUNCE_MS = 1500

// Maximum number of recent tool lines to keep in the activity log.
const MAX_ACTIVITY_LINES = 6

export type TextCaptureCallback = (sessionId: string, text: string) => void

interface SessionState {
  // Text buffering: Goose streams text token-by-token; we accumulate and flush.
  textBuffer: string
  flushTimer: ReturnType<typeof setTimeout> | null
  // Tool activity tracking
  activityMessageId: number | null
  activityLastSentAt: number
  toolCount: number
  activityLog: string[]
  // Optional callback for capturing flushed text (used by plan mode)
  onTextCapture?: TextCaptureCallback
}

export class Observer {
  private readonly sessions = new Map<string, SessionState>()

  constructor(
    private readonly telegram: TelegramClient,
    private readonly throttleMs: number,
  ) {}

  async onSessionStart(
    meta: SessionMeta,
    task: string,
    onTextCapture?: TextCaptureCallback,
  ): Promise<void> {
    this.sessions.set(meta.sessionId, {
      textBuffer: "",
      flushTimer: null,
      activityMessageId: null,
      activityLastSentAt: 0,
      toolCount: 0,
      activityLog: [],
      onTextCapture,
    })
    await this.telegram.sendMessage(
      formatSessionStart(meta.repo, meta.topicName, task),
      meta.threadId,
    )
  }

  async onEvent(meta: SessionMeta, event: GooseStreamEvent): Promise<void> {
    switch (event.type) {
      case "message":
        await this.handleMessage(meta, event.message)
        break

      case "error":
        await this.flushTextBuffer(meta)
        await this.telegram.sendMessage(
          formatSessionError(meta.topicName, event.error),
          meta.threadId,
        )
        break

      case "complete":
      case "notification":
        break
    }
  }

  private async handleMessage(meta: SessionMeta, message: GooseMessage): Promise<void> {
    if (message.role !== "assistant") return

    for (const block of message.content) {
      if (block.type === "text") {
        const text = (block as { type: "text"; text: string }).text
        if (text) {
          this.bufferText(meta, text)
        }
      } else if (block.type === "toolRequest") {
        // Flush buffered text before showing tool activity
        await this.flushTextBuffer(meta)
        await this.handleToolRequest(meta, block as GooseToolRequestContent)
      }
    }
  }

  private bufferText(meta: SessionMeta, chunk: string): void {
    const state = this.sessions.get(meta.sessionId)
    if (!state) return

    state.textBuffer += chunk

    // Reset debounce timer
    if (state.flushTimer !== null) clearTimeout(state.flushTimer)
    state.flushTimer = setTimeout(() => {
      this.flushTextBuffer(meta).catch((err) => {
        process.stderr.write(`observer: flush error: ${err}\n`)
      })
    }, TEXT_FLUSH_DEBOUNCE_MS)
  }

  private async flushTextBuffer(meta: SessionMeta): Promise<void> {
    const state = this.sessions.get(meta.sessionId)
    if (!state) return

    if (state.flushTimer !== null) {
      clearTimeout(state.flushTimer)
      state.flushTimer = null
    }

    const text = state.textBuffer.trim()
    state.textBuffer = ""

    if (text) {
      if (state.onTextCapture) {
        state.onTextCapture(meta.sessionId, text)
      }
      await this.telegram.sendMessage(
        formatAssistantText(meta.topicName, text),
        meta.threadId,
      )
      // Reset activity tracking so the next tool burst gets a fresh message
      state.activityMessageId = null
      state.activityLog = []
    }
  }

  private async handleToolRequest(
    meta: SessionMeta,
    block: GooseToolRequestContent,
  ): Promise<void> {
    if ("error" in block.toolCall) return

    const { name, arguments: args } = block.toolCall
    const now = Date.now()
    const state = this.sessions.get(meta.sessionId)
    if (!state) return

    state.toolCount++

    // Append to rolling activity log
    const line = formatToolLine(name, args)
    state.activityLog.push(line)
    if (state.activityLog.length > MAX_ACTIVITY_LINES) {
      state.activityLog.shift()
    }

    const html = formatActivityLog(state.activityLog, state.toolCount)

    if (now - state.activityLastSentAt < this.throttleMs && state.activityMessageId !== null) {
      // Within throttle window: edit existing activity message
      state.activityLastSentAt = now
      await this.telegram.editMessage(state.activityMessageId, html, meta.threadId)
      return
    }

    // Outside throttle window or no existing message: send new activity message
    state.activityLastSentAt = now
    const { messageId } = await this.telegram.sendMessage(html, meta.threadId)
    state.activityMessageId = messageId
  }

  async onSessionComplete(
    meta: SessionMeta,
    finalState: "completed" | "errored",
    durationMs: number,
  ): Promise<void> {
    // Flush any remaining buffered text before posting summary
    await this.flushTextBuffer(meta)
    this.sessions.delete(meta.sessionId)

    if (finalState === "errored") {
      await this.telegram.sendMessage(
        formatSessionError(meta.topicName, "Session ended with an error. Check logs."),
        meta.threadId,
      )
    } else {
      await this.telegram.sendMessage(
        formatSessionComplete(meta.topicName, durationMs, meta.totalTokens),
        meta.threadId,
      )
    }
  }

  clearSession(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state?.flushTimer !== null) clearTimeout(state!.flushTimer)
    this.sessions.delete(sessionId)
  }
}
