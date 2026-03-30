import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Observer } from "../src/session/observer.js"
import type { SessionMeta, GooseStreamEvent } from "../src/types.js"

function makeTelegram() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ messageId: 1 }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    deleteForumTopic: vi.fn().mockResolvedValue(undefined),
    createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 1 }),
    getUpdates: vi.fn().mockResolvedValue([]),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    sendMessageWithKeyboard: vi.fn().mockResolvedValue(1),
    downloadFile: vi.fn().mockResolvedValue(true),
    sendPhoto: vi.fn().mockResolvedValue(1),
  }
}

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "sess-1",
    threadId: 42,
    topicName: "bold-arc",
    repo: "test-repo",
    cwd: "/tmp/test",
    startedAt: Date.now(),
    mode: "task",
    ...overrides,
  }
}

describe("Observer", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("onSessionStart", () => {
    it("sends a session start message for task mode", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta({ mode: "task" })

      await observer.onSessionStart(meta, "fix the bug")

      expect(telegram.sendMessage).toHaveBeenCalledOnce()
      const msg = telegram.sendMessage.mock.calls[0][0]
      expect(msg).toContain("Session started")
      expect(msg).toContain("bold-arc")
    })

    it("sends a plan start message for plan mode", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta({ mode: "plan" })

      await observer.onSessionStart(meta, "plan the feature")

      const msg = telegram.sendMessage.mock.calls[0][0]
      expect(msg).toContain("Planning started")
      expect(msg).toContain("/execute")
    })

    it("sends a ship-think start message for ship-think mode", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta({ mode: "ship-think" })

      await observer.onSessionStart(meta, "build auth system")

      const msg = telegram.sendMessage.mock.calls[0][0]
      expect(msg).toContain("Ship: researching")
      expect(msg).toContain("Auto-advancing")
    })

    it("sends a ship-plan start message for ship-plan mode", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta({ mode: "ship-plan" })

      await observer.onSessionStart(meta, "build auth system")

      const msg = telegram.sendMessage.mock.calls[0][0]
      expect(msg).toContain("Ship: planning")
      expect(msg).toContain("implementation plan")
    })

    it("sends a ship-verify start message for ship-verify mode", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta({ mode: "ship-verify" })

      await observer.onSessionStart(meta, "build auth system")

      const msg = telegram.sendMessage.mock.calls[0][0]
      expect(msg).toContain("Ship: verifying")
      expect(msg).toContain("quality gates")
    })
  })

  describe("onEvent — text buffering", () => {
    it("buffers text and flushes after debounce timeout", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta()

      await observer.onSessionStart(meta, "task")
      telegram.sendMessage.mockClear()

      const textEvent: GooseStreamEvent = {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{ type: "text", text: "A".repeat(100) }],
        },
      }

      await observer.onEvent(meta, textEvent)

      expect(telegram.sendMessage).not.toHaveBeenCalled()

      // Advance past debounce + interval check to ensure flush triggers
      await vi.advanceTimersByTimeAsync(1700)

      expect(telegram.sendMessage).toHaveBeenCalledOnce()
      const msg = telegram.sendMessage.mock.calls[0][0]
      expect(msg).toContain("Reply")
    })

    it("does not flush text shorter than MIN_TEXT_LENGTH", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta()

      await observer.onSessionStart(meta, "task")
      telegram.sendMessage.mockClear()

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{ type: "text", text: "short" }],
        },
      })

      await vi.advanceTimersByTimeAsync(1700)

      expect(telegram.sendMessage).not.toHaveBeenCalled()
    })

    it("calls onTextCapture callback when flushing", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta()
      const captured: string[] = []

      await observer.onSessionStart(meta, "task", (_sid, text) => {
        captured.push(text)
      })
      telegram.sendMessage.mockClear()

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{ type: "text", text: "captured text here plus padding to exceed min length" }],
        },
      })

      await vi.advanceTimersByTimeAsync(1700)

      expect(captured).toHaveLength(1)
      expect(captured[0]).toContain("captured text here")
    })

    it("accumulates multiple text chunks before flushing", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta()

      await observer.onSessionStart(meta, "task")
      telegram.sendMessage.mockClear()

      for (let i = 0; i < 5; i++) {
        await observer.onEvent(meta, {
          type: "message",
          message: {
            role: "assistant",
            created: 0,
            content: [{ type: "text", text: "chunk ".repeat(5) }],
          },
        })
      }

      await vi.advanceTimersByTimeAsync(1700)

      expect(telegram.sendMessage).toHaveBeenCalledOnce()
    })

    it("uses single interval instead of per-chunk timers", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta()

      await observer.onSessionStart(meta, "task")
      telegram.sendMessage.mockClear()

      // Send multiple chunks rapidly - should use single interval, not create N timers
      const setIntervalSpy = vi.spyOn(global, "setInterval")
      const clearTimeoutSpy = vi.spyOn(global, "clearTimeout")

      for (let i = 0; i < 10; i++) {
        await observer.onEvent(meta, {
          type: "message",
          message: {
            role: "assistant",
            created: 0,
            content: [{ type: "text", text: `chunk ${i} `.repeat(10) }],
          },
        })
      }

      // Should have only called setInterval once (first chunk starts the interval)
      expect(setIntervalSpy).toHaveBeenCalledOnce()
      // Should not have called clearTimeout (old approach reset timer on each chunk)
      expect(clearTimeoutSpy).not.toHaveBeenCalled()

      setIntervalSpy.mockRestore()
      clearTimeoutSpy.mockRestore()
    })

    it("resets debounce when new text arrives during wait period", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta()

      await observer.onSessionStart(meta, "task")
      telegram.sendMessage.mockClear()

      // Send first chunk
      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{ type: "text", text: "A".repeat(100) }],
        },
      })

      // Advance time but not enough to trigger flush
      await vi.advanceTimersByTimeAsync(1000)

      // Send another chunk - this should reset the debounce
      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{ type: "text", text: "B".repeat(100) }],
        },
      })

      // Should not have flushed yet
      expect(telegram.sendMessage).not.toHaveBeenCalled()

      // Advance by another 1000ms - still not enough (debounce was reset)
      await vi.advanceTimersByTimeAsync(1000)
      expect(telegram.sendMessage).not.toHaveBeenCalled()

      // Advance past the full debounce period from last chunk
      await vi.advanceTimersByTimeAsync(1000)
      expect(telegram.sendMessage).toHaveBeenCalledOnce()
    })
  })

  describe("onEvent — tool requests", () => {
    it("sends a tool activity message", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta()

      await observer.onSessionStart(meta, "task")
      telegram.sendMessage.mockClear()

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{
            type: "toolRequest",
            id: "t1",
            toolCall: { name: "Bash", arguments: { command: "npm test" } },
          }],
        },
      })

      expect(telegram.sendMessage).toHaveBeenCalledOnce()
      const msg = telegram.sendMessage.mock.calls[0][0]
      expect(msg).toContain("Activity")
    })

    it("debounces edits to existing activity message within throttle window", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta()

      await observer.onSessionStart(meta, "task")
      telegram.sendMessage.mockClear()

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{
            type: "toolRequest",
            id: "t1",
            toolCall: { name: "Bash", arguments: { command: "ls" } },
          }],
        },
      })

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{
            type: "toolRequest",
            id: "t2",
            toolCall: { name: "Read", arguments: { file_path: "/a.ts" } },
          }],
        },
      })

      expect(telegram.sendMessage).toHaveBeenCalledOnce()
      expect(telegram.editMessage).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2000)

      expect(telegram.editMessage).toHaveBeenCalledOnce()
    })

    it("sends new activity message after throttle window expires", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 1000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta()

      await observer.onSessionStart(meta, "task")
      telegram.sendMessage.mockClear()

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{
            type: "toolRequest",
            id: "t1",
            toolCall: { name: "Bash", arguments: { command: "ls" } },
          }],
        },
      })

      vi.advanceTimersByTime(1500)

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{
            type: "toolRequest",
            id: "t2",
            toolCall: { name: "Read", arguments: { file_path: "/b.ts" } },
          }],
        },
      })

      expect(telegram.sendMessage).toHaveBeenCalledTimes(2)
    })

    it("flushes text buffer before tool request", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta()

      await observer.onSessionStart(meta, "task")
      telegram.sendMessage.mockClear()

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{ type: "text", text: "A".repeat(250) }],
        },
      })

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{
            type: "toolRequest",
            id: "t1",
            toolCall: { name: "Bash", arguments: { command: "ls" } },
          }],
        },
      })

      expect(telegram.sendMessage).toHaveBeenCalledTimes(2)
      expect(telegram.sendMessage.mock.calls[0][0]).toContain("Reply")
      expect(telegram.sendMessage.mock.calls[1][0]).toContain("Activity")
    })

    it("skips tool requests with errors", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta()

      await observer.onSessionStart(meta, "task")
      telegram.sendMessage.mockClear()

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{
            type: "toolRequest",
            id: "t1",
            toolCall: { error: "tool failed" },
          }],
        },
      })

      expect(telegram.sendMessage).not.toHaveBeenCalled()
    })
  })

  describe("onEvent — errors", () => {
    it("sends error message on error event", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta()

      await observer.onSessionStart(meta, "task")
      telegram.sendMessage.mockClear()

      await observer.onEvent(meta, { type: "error", error: "something broke" })

      expect(telegram.sendMessage).toHaveBeenCalledOnce()
      const msg = telegram.sendMessage.mock.calls[0][0]
      expect(msg).toContain("Error")
      expect(msg).toContain("something broke")
    })
  })

  describe("onEvent — ignores non-assistant messages", () => {
    it("ignores user role messages", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta()

      await observer.onSessionStart(meta, "task")
      telegram.sendMessage.mockClear()

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "user",
          created: 0,
          content: [{ type: "text", text: "user message" }],
        },
      })

      await vi.advanceTimersByTimeAsync(2000)
      expect(telegram.sendMessage).not.toHaveBeenCalled()
    })
  })

  describe("onSessionComplete", () => {
    it("sends completion message for completed sessions", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta()

      await observer.onSessionStart(meta, "task")
      telegram.sendMessage.mockClear()

      await observer.onSessionComplete(meta, "completed", 60000)

      expect(telegram.sendMessage).toHaveBeenCalledOnce()
      const msg = telegram.sendMessage.mock.calls[0][0]
      expect(msg).toContain("Complete")
    })

    it("sends error message for errored sessions", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta()

      await observer.onSessionStart(meta, "task")
      telegram.sendMessage.mockClear()

      await observer.onSessionComplete(meta, "errored", 30000)

      expect(telegram.sendMessage).toHaveBeenCalledOnce()
      const msg = telegram.sendMessage.mock.calls[0][0]
      expect(msg).toContain("Error")
    })

    it("flushes remaining text buffer before completing", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta()

      await observer.onSessionStart(meta, "task")
      telegram.sendMessage.mockClear()

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{ type: "text", text: "B".repeat(100) }],
        },
      })

      await observer.onSessionComplete(meta, "completed", 60000)

      expect(telegram.sendMessage).toHaveBeenCalledTimes(2)
      expect(telegram.sendMessage.mock.calls[0][0]).toContain("Reply")
      expect(telegram.sendMessage.mock.calls[1][0]).toContain("Complete")
    })
  })

  describe("flushAndComplete", () => {
    it("flushes text and cleans up session without sending completion message", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta()

      await observer.onSessionStart(meta, "task")
      telegram.sendMessage.mockClear()

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{ type: "text", text: "C".repeat(100) }],
        },
      })

      await observer.flushAndComplete(meta, "completed", 60000)

      expect(telegram.sendMessage).toHaveBeenCalledOnce()
      expect(telegram.sendMessage.mock.calls[0][0]).toContain("Reply")
    })
  })

  describe("screenshot detection", () => {
    let tmpDir: string
    let screenshotDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-screenshot-"))
      screenshotDir = path.join(tmpDir, ".screenshots")
      fs.mkdirSync(screenshotDir)
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it("sends screenshot photo after detecting browser_take_screenshot tool", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta({ cwd: tmpDir })

      await observer.onSessionStart(meta, "task")
      telegram.sendMessage.mockClear()

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{
            type: "toolRequest",
            id: "t1",
            toolCall: { name: "browser_take_screenshot", arguments: {} },
          }],
        },
      })

      fs.writeFileSync(path.join(screenshotDir, "screenshot-1.png"), Buffer.from("fake-png"))

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{ type: "text", text: "Here is the screenshot result with enough text to pass" }],
        },
      })

      expect(telegram.sendPhoto).toHaveBeenCalledOnce()
      expect(telegram.sendPhoto).toHaveBeenCalledWith(
        path.join(screenshotDir, "screenshot-1.png"),
        42,
        "📸 screenshot-1.png",
      )
    })

    it("does not send the same screenshot twice", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta({ cwd: tmpDir })

      await observer.onSessionStart(meta, "task")
      telegram.sendMessage.mockClear()

      fs.writeFileSync(path.join(screenshotDir, "screenshot-1.png"), Buffer.from("fake-png"))

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{
            type: "toolRequest",
            id: "t1",
            toolCall: { name: "browser_take_screenshot", arguments: {} },
          }],
        },
      })

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{ type: "text", text: "first result" }],
        },
      })

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{
            type: "toolRequest",
            id: "t2",
            toolCall: { name: "browser_take_screenshot", arguments: {} },
          }],
        },
      })

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{ type: "text", text: "second result" }],
        },
      })

      expect(telegram.sendPhoto).toHaveBeenCalledOnce()
    })

    it("sends pending screenshots on session complete", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta({ cwd: tmpDir })

      await observer.onSessionStart(meta, "task")
      telegram.sendMessage.mockClear()

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{
            type: "toolRequest",
            id: "t1",
            toolCall: { name: "mcp__playwright__browser_take_screenshot", arguments: {} },
          }],
        },
      })

      fs.writeFileSync(path.join(screenshotDir, "page-capture.png"), Buffer.from("fake-png"))

      await observer.onSessionComplete(meta, "completed", 60000)

      expect(telegram.sendPhoto).toHaveBeenCalledOnce()
      expect(telegram.sendPhoto).toHaveBeenCalledWith(
        path.join(screenshotDir, "page-capture.png"),
        42,
        "📸 page-capture.png",
      )
    })
  })

  describe("clearSession", () => {
    it("removes session state and cancels flush timer", async () => {
      const telegram = makeTelegram()
      const observer = new Observer(telegram as any, 3000, { textFlushDebounceMs: 1500, activityEditDebounceMs: 2000 })
      const meta = makeMeta()

      await observer.onSessionStart(meta, "task")

      await observer.onEvent(meta, {
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [{ type: "text", text: "buffered text here" }],
        },
      })

      observer.clearSession(meta.sessionId)

      await vi.advanceTimersByTimeAsync(2000)

      telegram.sendMessage.mockClear()
      expect(telegram.sendMessage).not.toHaveBeenCalled()
    })
  })
})
