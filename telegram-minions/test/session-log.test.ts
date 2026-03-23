import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { writeSessionLog, type SessionLogEntry } from "../src/session-log.js"
import type { TopicSession, SessionMeta } from "../src/types.js"

describe("writeSessionLog", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slog-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeTopicSession(overrides?: Partial<TopicSession>): TopicSession {
    return {
      threadId: 123,
      repo: "test-repo",
      cwd: tmpDir,
      slug: "bold-arc",
      conversation: [{ role: "user", text: "fix the bug" }],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      ...overrides,
    }
  }

  function makeMeta(overrides?: Partial<SessionMeta>): SessionMeta {
    return {
      sessionId: "abc-123",
      threadId: 123,
      topicName: "bold-arc",
      repo: "test-repo",
      cwd: tmpDir,
      startedAt: Date.now() - 60000,
      totalTokens: 5000,
      mode: "task",
      ...overrides,
    }
  }

  it("writes session-log.json to the workspace", () => {
    writeSessionLog(makeTopicSession(), makeMeta(), "completed", 60000)

    const logPath = path.join(tmpDir, "session-log.json")
    expect(fs.existsSync(logPath)).toBe(true)

    const entry: SessionLogEntry = JSON.parse(fs.readFileSync(logPath, "utf-8"))
    expect(entry.slug).toBe("bold-arc")
    expect(entry.repo).toBe("test-repo")
    expect(entry.mode).toBe("task")
    expect(entry.state).toBe("completed")
    expect(entry.durationMs).toBe(60000)
    expect(entry.totalTokens).toBe(5000)
    expect(entry.task).toBe("fix the bug")
  })

  it("includes quality report when provided", () => {
    const report = {
      results: [{ gate: "tests", passed: true, output: "ok" }],
      allPassed: true,
    }
    writeSessionLog(makeTopicSession(), makeMeta(), "completed", 60000, report)

    const logPath = path.join(tmpDir, "session-log.json")
    const entry: SessionLogEntry = JSON.parse(fs.readFileSync(logPath, "utf-8"))
    expect(entry.qualityGates).toBeDefined()
    expect(entry.qualityGates!.allPassed).toBe(true)
  })
})
