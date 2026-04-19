import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { TranscriptStore } from "../src/transcript/transcript-store.js"
import type {
  AssistantTextEvent,
  StatusEvent,
  ToolCallEvent,
  TranscriptEvent,
  UserMessageEvent,
} from "../src/transcript/types.js"

const SLUG = "slow-knoll"
const TRANSCRIPT_DIR = ".transcripts"

function userMessage(overrides: Partial<UserMessageEvent> = {}): UserMessageEvent {
  return {
    type: "user_message",
    seq: 0,
    id: "evt_user_0",
    sessionId: SLUG,
    turn: 0,
    timestamp: 1_700_000_000_000,
    text: "hello",
    ...overrides,
  }
}

function assistantText(overrides: Partial<AssistantTextEvent> = {}): AssistantTextEvent {
  return {
    type: "assistant_text",
    seq: 1,
    id: "evt_assist_1",
    sessionId: SLUG,
    turn: 0,
    timestamp: 1_700_000_000_100,
    blockId: "block_a",
    text: "world",
    final: true,
    ...overrides,
  }
}

function toolCall(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    type: "tool_call",
    seq: 2,
    id: "evt_tool_2",
    sessionId: SLUG,
    turn: 0,
    timestamp: 1_700_000_000_200,
    call: {
      toolUseId: "tool_abc",
      name: "Bash",
      kind: "bash",
      title: "Run ls",
      input: { command: "ls" },
    },
    ...overrides,
  }
}

function status(overrides: Partial<StatusEvent> = {}): StatusEvent {
  return {
    type: "status",
    seq: 3,
    id: "evt_status_3",
    sessionId: SLUG,
    turn: 0,
    timestamp: 1_700_000_000_300,
    severity: "info",
    kind: "quota_sleep",
    message: "waiting",
    ...overrides,
  }
}

describe("TranscriptStore", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tstore-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("append / get", () => {
    it("buffers events in memory in the order they were appended", async () => {
      const store = new TranscriptStore(tmpDir)
      await store.append(SLUG, userMessage())
      await store.append(SLUG, assistantText())
      await store.append(SLUG, toolCall())

      const all = store.get(SLUG)
      expect(all).toHaveLength(3)
      expect(all.map((e) => e.type)).toEqual([
        "user_message",
        "assistant_text",
        "tool_call",
      ])
    })

    it("returns an empty array for an unknown slug", () => {
      const store = new TranscriptStore(tmpDir)
      expect(store.get(SLUG)).toEqual([])
    })

    it("get returns a defensive copy — mutating it does not affect the store", async () => {
      const store = new TranscriptStore(tmpDir)
      await store.append(SLUG, userMessage())
      const snapshot = store.get(SLUG)
      snapshot.push(assistantText())
      expect(store.get(SLUG)).toHaveLength(1)
    })

    it("rejects unsafe slugs to prevent path traversal", async () => {
      const store = new TranscriptStore(tmpDir)
      await expect(store.append("../escape", userMessage())).rejects.toThrow(/invalid transcript slug/)
      await expect(store.append("has spaces", userMessage())).rejects.toThrow(/invalid transcript slug/)
      await expect(store.append("UPPER", userMessage())).rejects.toThrow(/invalid transcript slug/)
      await expect(store.append("", userMessage())).rejects.toThrow(/invalid transcript slug/)
    })

    it("keeps transcripts for different slugs isolated", async () => {
      const store = new TranscriptStore(tmpDir)
      await store.append("slug-one", userMessage({ sessionId: "slug-one" }))
      await store.append(
        "slug-two",
        assistantText({ seq: 0, sessionId: "slug-two", id: "evt_other" }),
      )

      expect(store.get("slug-one").map((e) => e.type)).toEqual(["user_message"])
      expect(store.get("slug-two").map((e) => e.type)).toEqual(["assistant_text"])
      expect(new Set(store.slugs())).toEqual(new Set(["slug-one", "slug-two"]))
    })
  })

  describe("getSince / highWaterMark / has", () => {
    it("getSince returns only events with seq > afterSeq", async () => {
      const store = new TranscriptStore(tmpDir)
      await store.append(SLUG, userMessage({ seq: 0 }))
      await store.append(SLUG, assistantText({ seq: 1 }))
      await store.append(SLUG, toolCall({ seq: 2 }))
      await store.append(SLUG, status({ seq: 3 }))

      expect(store.getSince(SLUG, -1).map((e) => e.seq)).toEqual([0, 1, 2, 3])
      expect(store.getSince(SLUG, 0).map((e) => e.seq)).toEqual([1, 2, 3])
      expect(store.getSince(SLUG, 2).map((e) => e.seq)).toEqual([3])
      expect(store.getSince(SLUG, 3)).toEqual([])
      expect(store.getSince(SLUG, 99)).toEqual([])
    })

    it("getSince on an unknown slug returns []", () => {
      const store = new TranscriptStore(tmpDir)
      expect(store.getSince(SLUG, -1)).toEqual([])
    })

    it("highWaterMark returns -1 when no events exist and max seq otherwise", async () => {
      const store = new TranscriptStore(tmpDir)
      expect(store.highWaterMark(SLUG)).toBe(-1)
      await store.append(SLUG, userMessage({ seq: 0 }))
      await store.append(SLUG, assistantText({ seq: 5 }))
      expect(store.highWaterMark(SLUG)).toBe(5)
    })

    it("has returns false for unknown slug and true after appending", async () => {
      const store = new TranscriptStore(tmpDir)
      expect(store.has(SLUG)).toBe(false)
      await store.append(SLUG, userMessage())
      expect(store.has(SLUG)).toBe(true)
    })
  })

  describe("NDJSON persistence", () => {
    it("writes each appended event as a single NDJSON line to <root>/.transcripts/<slug>.ndjson", async () => {
      const store = new TranscriptStore(tmpDir)
      const events: TranscriptEvent[] = [
        userMessage({ seq: 0 }),
        assistantText({ seq: 1 }),
        toolCall({ seq: 2 }),
      ]
      for (const e of events) await store.append(SLUG, e)
      await store.flush(SLUG)

      const filePath = path.join(tmpDir, TRANSCRIPT_DIR, `${SLUG}.ndjson`)
      const raw = await fsp.readFile(filePath, "utf-8")

      const lines = raw.split("\n")
      expect(lines[lines.length - 1]).toBe("")
      const parsed = lines.slice(0, -1).map((l) => JSON.parse(l))
      expect(parsed).toEqual(events)
    })

    it("creates the .transcripts directory on first write", async () => {
      const store = new TranscriptStore(tmpDir)
      expect(fs.existsSync(path.join(tmpDir, TRANSCRIPT_DIR))).toBe(false)
      await store.append(SLUG, userMessage())
      await store.flush(SLUG)
      expect(fs.existsSync(path.join(tmpDir, TRANSCRIPT_DIR))).toBe(true)
    })

    it("serialises concurrent appends so NDJSON lines never interleave", async () => {
      const store = new TranscriptStore(tmpDir)
      const events: TranscriptEvent[] = Array.from({ length: 25 }, (_, i) =>
        assistantText({
          seq: i,
          id: `evt_${i}`,
          blockId: "block_concurrent",
          text: `chunk ${i}`,
        }),
      )

      await Promise.all(events.map((e) => store.append(SLUG, e)))
      await store.flush(SLUG)

      const raw = await fsp.readFile(
        path.join(tmpDir, TRANSCRIPT_DIR, `${SLUG}.ndjson`),
        "utf-8",
      )
      const lines = raw.split("\n").filter((l) => l.length > 0)
      expect(lines).toHaveLength(events.length)
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
      const parsedSeqs = lines.map((l) => (JSON.parse(l) as AssistantTextEvent).seq)
      expect(parsedSeqs).toEqual(events.map((e) => e.seq))
    })

    it("flush() without a slug waits for every pending write across slugs", async () => {
      const store = new TranscriptStore(tmpDir)
      await Promise.all([
        store.append("slug-one", userMessage({ sessionId: "slug-one" })),
        store.append(
          "slug-two",
          assistantText({ seq: 0, sessionId: "slug-two", id: "evt_other" }),
        ),
      ])
      await store.flush()

      for (const slug of ["slug-one", "slug-two"]) {
        const raw = await fsp.readFile(
          path.join(tmpDir, TRANSCRIPT_DIR, `${slug}.ndjson`),
          "utf-8",
        )
        expect(raw.split("\n").filter((l) => l.length > 0)).toHaveLength(1)
      }
    })
  })

  describe("load / reload", () => {
    it("rehydrates a transcript from NDJSON into a fresh store", async () => {
      const writer = new TranscriptStore(tmpDir)
      const events: TranscriptEvent[] = [
        userMessage({ seq: 0 }),
        assistantText({ seq: 1 }),
        toolCall({ seq: 2 }),
        status({ seq: 3 }),
      ]
      for (const e of events) await writer.append(SLUG, e)
      await writer.flush(SLUG)

      const reader = new TranscriptStore(tmpDir)
      expect(reader.has(SLUG)).toBe(false)
      const loaded = await reader.load(SLUG)
      expect(loaded).toEqual(events)
      expect(reader.get(SLUG)).toEqual(events)
      expect(reader.highWaterMark(SLUG)).toBe(3)
    })

    it("sorts events by seq when loading, even if the file is out of order", async () => {
      const dir = path.join(tmpDir, TRANSCRIPT_DIR)
      await fsp.mkdir(dir, { recursive: true })
      const out = [
        toolCall({ seq: 2 }),
        userMessage({ seq: 0 }),
        assistantText({ seq: 1 }),
      ]
      await fsp.writeFile(
        path.join(dir, `${SLUG}.ndjson`),
        out.map((e) => JSON.stringify(e)).join("\n") + "\n",
        "utf-8",
      )

      const store = new TranscriptStore(tmpDir)
      const loaded = await store.load(SLUG)
      expect(loaded.map((e) => e.seq)).toEqual([0, 1, 2])
    })

    it("treats a missing transcript file as an empty session", async () => {
      const store = new TranscriptStore(tmpDir)
      const loaded = await store.load(SLUG)
      expect(loaded).toEqual([])
      expect(store.has(SLUG)).toBe(false)
      expect(store.highWaterMark(SLUG)).toBe(-1)
    })

    it("skips malformed NDJSON lines without throwing", async () => {
      const dir = path.join(tmpDir, TRANSCRIPT_DIR)
      await fsp.mkdir(dir, { recursive: true })
      const good = userMessage({ seq: 0 })
      const content = [JSON.stringify(good), "{not json", JSON.stringify(assistantText({ seq: 1 }))].join("\n") + "\n"
      await fsp.writeFile(path.join(dir, `${SLUG}.ndjson`), content, "utf-8")

      const store = new TranscriptStore(tmpDir)
      const loaded = await store.load(SLUG)
      expect(loaded.map((e) => e.seq)).toEqual([0, 1])
    })

    it("is idempotent — a second load does not duplicate events or re-read the file", async () => {
      const writer = new TranscriptStore(tmpDir)
      await writer.append(SLUG, userMessage({ seq: 0 }))
      await writer.flush(SLUG)

      const reader = new TranscriptStore(tmpDir)
      await reader.load(SLUG)
      // Delete the file after first load to prove the second call doesn't hit disk.
      await fsp.rm(path.join(tmpDir, TRANSCRIPT_DIR, `${SLUG}.ndjson`))

      const again = await reader.load(SLUG)
      expect(again).toHaveLength(1)
    })

    it("append after load continues from the reloaded events and persists incrementally", async () => {
      const writer = new TranscriptStore(tmpDir)
      await writer.append(SLUG, userMessage({ seq: 0 }))
      await writer.flush(SLUG)

      const reader = new TranscriptStore(tmpDir)
      await reader.load(SLUG)
      await reader.append(SLUG, assistantText({ seq: 1 }))
      await reader.flush(SLUG)

      const raw = await fsp.readFile(
        path.join(tmpDir, TRANSCRIPT_DIR, `${SLUG}.ndjson`),
        "utf-8",
      )
      const lines = raw.split("\n").filter((l) => l.length > 0)
      expect(lines).toHaveLength(2)
      expect(reader.highWaterMark(SLUG)).toBe(1)
    })
  })

  describe("archive", () => {
    it("moves the NDJSON file into archive/ and clears in-memory state", async () => {
      const store = new TranscriptStore(tmpDir)
      await store.append(SLUG, userMessage())
      await store.flush(SLUG)

      const archived = await store.archive(SLUG, 1_700_000_001_000)
      expect(archived).toBe(
        path.join(tmpDir, TRANSCRIPT_DIR, "archive", `${SLUG}-1700000001000.ndjson`),
      )
      expect(fs.existsSync(path.join(tmpDir, TRANSCRIPT_DIR, `${SLUG}.ndjson`))).toBe(false)
      expect(fs.existsSync(archived!)).toBe(true)
      expect(store.has(SLUG)).toBe(false)
    })

    it("returns null and is a no-op on disk when no file was ever written", async () => {
      const store = new TranscriptStore(tmpDir)
      const archived = await store.archive(SLUG)
      expect(archived).toBeNull()
      expect(store.has(SLUG)).toBe(false)
    })
  })
})
