import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PushSubscriptionStore } from "../src/push/push-subscriptions.js"

describe("PushSubscriptionStore", () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "push-subs-"))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it("returns an empty list when no file exists", async () => {
    const store = new PushSubscriptionStore(root)
    await store.load()
    expect(store.list()).toEqual([])
  })

  it("persists subscriptions to disk and re-reads them", async () => {
    const a = new PushSubscriptionStore(root)
    await a.add({ endpoint: "https://push.example/a", keys: { p256dh: "pa", auth: "aa" } })
    await a.add({ endpoint: "https://push.example/b", keys: { p256dh: "pb", auth: "ab" } })

    const b = new PushSubscriptionStore(root)
    await b.load()
    expect(b.list().map((s) => s.endpoint)).toEqual([
      "https://push.example/a",
      "https://push.example/b",
    ])
  })

  it("deduplicates by endpoint — re-subscribing updates keys", async () => {
    const store = new PushSubscriptionStore(root)
    await store.add({ endpoint: "https://push.example/x", keys: { p256dh: "old", auth: "old" } })
    await store.add({ endpoint: "https://push.example/x", keys: { p256dh: "new", auth: "new" } })
    const subs = store.list()
    expect(subs).toHaveLength(1)
    expect(subs[0].keys).toEqual({ p256dh: "new", auth: "new" })
  })

  it("removes by endpoint and returns true when an entry was removed", async () => {
    const store = new PushSubscriptionStore(root)
    await store.add({ endpoint: "https://push.example/keep", keys: { p256dh: "k", auth: "k" } })
    await store.add({ endpoint: "https://push.example/drop", keys: { p256dh: "d", auth: "d" } })

    expect(await store.remove("https://push.example/drop")).toBe(true)
    expect(store.list().map((s) => s.endpoint)).toEqual(["https://push.example/keep"])
  })

  it("remove returns false for an unknown endpoint", async () => {
    const store = new PushSubscriptionStore(root)
    await store.add({ endpoint: "https://push.example/a", keys: { p256dh: "a", auth: "a" } })
    expect(await store.remove("https://push.example/nope")).toBe(false)
    expect(store.list()).toHaveLength(1)
  })
})
