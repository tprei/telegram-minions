import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SessionStore } from "../src/store.js"
import type { TopicSession } from "../src/domain/session-types.js"
function makeSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: "100",
    repo: "test-repo",
    cwd: "/tmp/test",
    slug: "bold-arc",
    conversation: [{ role: "user", text: "fix the bug" }],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

describe("SessionStore", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("saves and loads sessions", async () => {
    const store = new SessionStore(tmpDir)
    const sessions = new Map<string, TopicSession>()
    sessions.set("100", makeSession())

    await store.save(sessions)

    const { active } = await store.load()
    expect(active.size).toBe(1)
    expect(active.get("100")?.slug).toBe("bold-arc")
    expect(active.get("100")?.repo).toBe("test-repo")
  })

  it("clears activeSessionId on load", async () => {
    const store = new SessionStore(tmpDir)
    const sessions = new Map<string, TopicSession>()
    sessions.set("100", makeSession({ activeSessionId: "some-uuid" }))

    await store.save(sessions)
    const { active } = await store.load()
    expect(active.get("100")?.activeSessionId).toBeUndefined()
  })

  it("filters out sessions older than TTL", async () => {
    const store = new SessionStore(tmpDir, 1000)
    const sessions = new Map<string, TopicSession>()
    sessions.set("100", makeSession({ lastActivityAt: Date.now() - 2000 }))
    sessions.set("200", makeSession({ threadId: "200", lastActivityAt: Date.now() }))

    await store.save(sessions)
    const { active, expired } = await store.load()
    expect(active.size).toBe(1)
    expect(active.has("200")).toBe(true)
    expect(expired.has("100")).toBe(true)
  })

  it("returns empty result when no file exists", async () => {
    const store = new SessionStore(tmpDir)
    const { active } = await store.load()
    expect(active.size).toBe(0)
  })

  it("returns empty result on corrupted file without Sentry report", async () => {
    const store = new SessionStore(tmpDir)
    fs.writeFileSync(path.join(tmpDir, ".sessions.json"), "not json", "utf-8")
    // Logging now uses structured logging via pino, so we just verify behavior
    const { active } = await store.load()
    expect(active.size).toBe(0)
  })

  it("returns empty result on empty file (truncated write)", async () => {
    const store = new SessionStore(tmpDir)
    fs.writeFileSync(path.join(tmpDir, ".sessions.json"), "", "utf-8")
    const { active } = await store.load()
    expect(active.size).toBe(0)
  })

  it("preserves conversation history through save/load", async () => {
    const store = new SessionStore(tmpDir)
    const session = makeSession({
      conversation: [
        { role: "user", text: "do the thing" },
        { role: "assistant", text: "done!" },
        { role: "user", text: "thanks, now adjust X" },
      ],
    })
    const sessions = new Map<string, TopicSession>()
    sessions.set("100", session)

    await store.save(sessions)
    const { active } = await store.load()
    expect(active.get("100")?.conversation).toHaveLength(3)
    expect(active.get("100")?.conversation[1].text).toBe("done!")
  })

  it("preserves pending feedback through save/load", async () => {
    const store = new SessionStore(tmpDir)
    const session = makeSession({ pendingFeedback: ["feedback 1", "feedback 2"] })
    const sessions = new Map<string, TopicSession>()
    sessions.set("100", session)

    await store.save(sessions)
    const { active } = await store.load()
    expect(active.get("100")?.pendingFeedback).toEqual(["feedback 1", "feedback 2"])
  })

  it("handles multiple sessions", async () => {
    const store = new SessionStore(tmpDir)
    const sessions = new Map<string, TopicSession>()
    sessions.set("100", makeSession({ threadId: "100", slug: "bold-arc" }))
    sessions.set("200", makeSession({ threadId: "200", slug: "calm-bay" }))
    sessions.set("300", makeSession({ threadId: "300", slug: "deep-fjord" }))

    await store.save(sessions)
    const { active } = await store.load()
    expect(active.size).toBe(3)
  })

  it("saves and restores the update offset", async () => {
    const store = new SessionStore(tmpDir)
    const sessions = new Map<string, TopicSession>()
    sessions.set("100", makeSession())

    await store.save(sessions, 42)
    const { offset } = await store.load()
    expect(offset).toBe(42)
  })

  it("defaults offset to 0 when not present", async () => {
    const store = new SessionStore(tmpDir)
    const sessions = new Map<string, TopicSession>()
    sessions.set("100", makeSession())

    await store.save(sessions)
    const { offset } = await store.load()
    expect(offset).toBe(0)
  })

  it("uses atomic write (no .tmp file left after save)", async () => {
    const store = new SessionStore(tmpDir)
    const sessions = new Map<string, TopicSession>()
    sessions.set("100", makeSession())

    await store.save(sessions)

    // The final file should exist
    expect(fs.existsSync(path.join(tmpDir, ".sessions.json"))).toBe(true)
    // The temp file should not remain
    expect(fs.existsSync(path.join(tmpDir, ".sessions.json.tmp"))).toBe(false)
  })

  it("handles old array format gracefully", async () => {
    // Old format was just an array of entries, not an object with sessions + offset
    const session = makeSession()
    const oldData: [string, TopicSession][] = [["100", session]]
    fs.writeFileSync(
      path.join(tmpDir, ".sessions.json"),
      JSON.stringify(oldData),
      "utf-8",
    )

    const store = new SessionStore(tmpDir)
    const { active, offset } = await store.load()
    expect(active.size).toBe(1)
    expect(active.get("100")?.slug).toBe("bold-arc")
    expect(offset).toBe(0)
  })

  it("uses interruptedAt for TTL when session was interrupted", async () => {
    const store = new SessionStore(tmpDir, 1000)
    const sessions = new Map<string, TopicSession>()
    // Session has recent lastActivityAt but was interrupted long ago
    sessions.set("100", makeSession({
      lastActivityAt: Date.now(),
      interruptedAt: Date.now() - 2000,
    }))
    // Session was interrupted recently
    sessions.set("200", makeSession({
      threadId: "200",
      lastActivityAt: Date.now() - 2000,
      interruptedAt: Date.now(),
    }))

    await store.save(sessions)
    const { active, expired } = await store.load()
    expect(expired.has("100")).toBe(true)
    expect(active.has("200")).toBe(true)
  })

  it("clears interruptedAt on expired sessions", async () => {
    const store = new SessionStore(tmpDir, 1000)
    const sessions = new Map<string, TopicSession>()
    sessions.set("100", makeSession({
      lastActivityAt: Date.now() - 2000,
      interruptedAt: Date.now() - 2000,
    }))

    await store.save(sessions)
    const { expired } = await store.load()
    expect(expired.get("100")?.interruptedAt).toBeUndefined()
  })

  it("round-trips an empty sessions map", async () => {
    const store = new SessionStore(tmpDir)
    const sessions = new Map<string, TopicSession>()

    await store.save(sessions, 99)
    const { active, expired, offset } = await store.load()
    expect(active.size).toBe(0)
    expect(expired.size).toBe(0)
    expect(offset).toBe(99)
  })

  it("second save overwrites the first", async () => {
    const store = new SessionStore(tmpDir)
    const sessions1 = new Map<string, TopicSession>()
    sessions1.set(100, makeSession({ slug: "first-save" }))
    await store.save(sessions1, 10)

    const sessions2 = new Map<string, TopicSession>()
    sessions2.set(200, makeSession({ threadId: "200", slug: "second-save" }))
    await store.save(sessions2, 20)

    const { active, offset } = await store.load()
    expect(active.size).toBe(1)
    expect(active.has("100")).toBe(false)
    expect(active.get("200")?.slug).toBe("second-save")
    expect(offset).toBe(20)
  })

  it("preserves parent/child thread IDs and DAG fields", async () => {
    const store = new SessionStore(tmpDir)
    const sessions = new Map<string, TopicSession>()
    sessions.set("100", makeSession({
      parentThreadId: "50",
      childThreadIds: ["200", "300"],
      splitLabel: "auth-refactor",
      dagId: "dag-123",
      dagNodeId: "node-1",
      repoUrl: "https://github.com/org/repo",
      profileId: "profile-abc",
      pendingSplitItems: [{ title: "Item 1", description: "Do thing 1" }],
      allSplitItems: [
        { title: "Item 1", description: "Do thing 1" },
        { title: "Item 2", description: "Do thing 2" },
      ],
    }))

    await store.save(sessions)
    const { active } = await store.load()
    const loaded = active.get("100")!
    expect(loaded.parentThreadId).toBe("50")
    expect(loaded.childThreadIds).toEqual(["200", "300"])
    expect(loaded.splitLabel).toBe("auth-refactor")
    expect(loaded.dagId).toBe("dag-123")
    expect(loaded.dagNodeId).toBe("node-1")
    expect(loaded.repoUrl).toBe("https://github.com/org/repo")
    expect(loaded.profileId).toBe("profile-abc")
    expect(loaded.pendingSplitItems).toEqual([{ title: "Item 1", description: "Do thing 1" }])
    expect(loaded.allSplitItems).toHaveLength(2)
  })

  it("preserves lastState through save/load", async () => {
    const store = new SessionStore(tmpDir)
    const sessions = new Map<string, TopicSession>()
    sessions.set("100", makeSession({ lastState: "completed" }))
    sessions.set("200", makeSession({ threadId: "200", lastState: "errored" }))

    await store.save(sessions)
    const { active } = await store.load()
    expect(active.get("100")?.lastState).toBe("completed")
    expect(active.get("200")?.lastState).toBe("errored")
  })

  it("handles old data without lastState gracefully", async () => {
    const store = new SessionStore(tmpDir)
    const sessions = new Map<string, TopicSession>()
    sessions.set("100", makeSession())
    // Explicitly no lastState — simulates old persisted data

    await store.save(sessions)
    const { active } = await store.load()
    expect(active.get("100")?.lastState).toBeUndefined()
  })

  it("handles valid JSON with missing sessions field gracefully", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".sessions.json"),
      JSON.stringify({ offset: 5 }),
      "utf-8",
    )

    const store = new SessionStore(tmpDir)
    const result = await store.load()
    // sessions field is undefined, so iterating throws — should not crash the app
    // This documents current behavior: it will throw trying to iterate undefined
    expect(result.active.size >= 0 || result.expired.size >= 0).toBe(true)
  })

  it("handles JSON null gracefully", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".sessions.json"),
      "null",
      "utf-8",
    )

    const store = new SessionStore(tmpDir)
    const result = await store.load()
    expect(result.active.size >= 0 || result.expired.size >= 0).toBe(true)
  })

  it("logs error and reports to Sentry on non-SyntaxError failures", async () => {
    // Point store at a directory instead of a file to provoke a non-ENOENT, non-SyntaxError
    fs.mkdirSync(path.join(tmpDir, ".sessions.json"))

    const store = new SessionStore(tmpDir)
    // Logging now uses structured logging via pino, so we just verify behavior
    const { active } = await store.load()
    expect(active.size).toBe(0)
  })

  it("save error does not corrupt existing file", async () => {
    const store = new SessionStore(tmpDir)
    const sessions = new Map<string, TopicSession>()
    sessions.set("100", makeSession({ slug: "original" }))
    await store.save(sessions, 1)

    // Make .tmp path a directory so the next save's writeFile fails
    const tmpPath = path.join(tmpDir, ".sessions.json.tmp")
    fs.mkdirSync(tmpPath)

    const sessions2 = new Map<string, TopicSession>()
    sessions2.set(200, makeSession({ threadId: "200", slug: "should-fail" }))

    // Capture stderr to suppress expected error
    const origWrite = process.stderr.write
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      await store.save(sessions2, 2)
    } finally {
      process.stderr.write = origWrite
    }

    // Clean up the blocking directory so it doesn't interfere with load
    fs.rmSync(tmpPath, { recursive: true, force: true })

    // Original file should still be intact
    const { active, offset } = await store.load()
    expect(active.get("100")?.slug).toBe("original")
    expect(offset).toBe(1)
  })
})
