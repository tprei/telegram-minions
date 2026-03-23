import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SessionStore } from "../src/store.js"
import type { TopicSession } from "../src/types.js"

function makeSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 100,
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

  it("saves and loads sessions", () => {
    const store = new SessionStore(tmpDir)
    const sessions = new Map<number, TopicSession>()
    sessions.set(100, makeSession())

    store.save(sessions)

    const { active } = store.load()
    expect(active.size).toBe(1)
    expect(active.get(100)?.slug).toBe("bold-arc")
    expect(active.get(100)?.repo).toBe("test-repo")
  })

  it("clears activeSessionId on load", () => {
    const store = new SessionStore(tmpDir)
    const sessions = new Map<number, TopicSession>()
    sessions.set(100, makeSession({ activeSessionId: "some-uuid" }))

    store.save(sessions)
    const { active } = store.load()
    expect(active.get(100)?.activeSessionId).toBeUndefined()
  })

  it("filters out sessions older than TTL", () => {
    const store = new SessionStore(tmpDir, 1000)
    const sessions = new Map<number, TopicSession>()
    sessions.set(100, makeSession({ lastActivityAt: Date.now() - 2000 }))
    sessions.set(200, makeSession({ threadId: 200, lastActivityAt: Date.now() }))

    store.save(sessions)
    const { active, expired } = store.load()
    expect(active.size).toBe(1)
    expect(active.has(200)).toBe(true)
    expect(expired.has(100)).toBe(true)
  })

  it("returns empty result when no file exists", () => {
    const store = new SessionStore(tmpDir)
    const { active } = store.load()
    expect(active.size).toBe(0)
  })

  it("returns empty result on corrupted file", () => {
    const store = new SessionStore(tmpDir)
    fs.writeFileSync(path.join(tmpDir, ".sessions.json"), "not json", "utf-8")
    const { active } = store.load()
    expect(active.size).toBe(0)
  })

  it("preserves conversation history through save/load", () => {
    const store = new SessionStore(tmpDir)
    const session = makeSession({
      conversation: [
        { role: "user", text: "do the thing" },
        { role: "assistant", text: "done!" },
        { role: "user", text: "thanks, now adjust X" },
      ],
    })
    const sessions = new Map<number, TopicSession>()
    sessions.set(100, session)

    store.save(sessions)
    const { active } = store.load()
    expect(active.get(100)?.conversation).toHaveLength(3)
    expect(active.get(100)?.conversation[1].text).toBe("done!")
  })

  it("preserves pending feedback through save/load", () => {
    const store = new SessionStore(tmpDir)
    const session = makeSession({ pendingFeedback: ["feedback 1", "feedback 2"] })
    const sessions = new Map<number, TopicSession>()
    sessions.set(100, session)

    store.save(sessions)
    const { active } = store.load()
    expect(active.get(100)?.pendingFeedback).toEqual(["feedback 1", "feedback 2"])
  })

  it("handles multiple sessions", () => {
    const store = new SessionStore(tmpDir)
    const sessions = new Map<number, TopicSession>()
    sessions.set(100, makeSession({ threadId: 100, slug: "bold-arc" }))
    sessions.set(200, makeSession({ threadId: 200, slug: "calm-bay" }))
    sessions.set(300, makeSession({ threadId: 300, slug: "deep-fjord" }))

    store.save(sessions)
    const { active } = store.load()
    expect(active.size).toBe(3)
  })
})
