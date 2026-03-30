import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DagStore } from "../src/dag-store.js"
import type { DagGraph } from "../src/dag/dag.js"

function makeGraph(overrides: Partial<DagGraph> = {}): DagGraph {
  return {
    id: "dag-test",
    nodes: [
      { id: "a", title: "Task A", description: "Do A", dependsOn: [], status: "done" },
      { id: "b", title: "Task B", description: "Do B", dependsOn: ["a"], status: "ready" },
    ],
    parentThreadId: 100,
    repo: "org/repo",
    repoUrl: "https://github.com/org/repo",
    createdAt: Date.now(),
    ...overrides,
  }
}

describe("DagStore", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dag-store-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("round-trips save and load", async () => {
    const store = new DagStore(tmpDir)
    const dags = new Map<string, DagGraph>()
    dags.set("dag-1", makeGraph({ id: "dag-1" }))

    await store.save(dags)

    const loaded = await store.load()
    expect(loaded.size).toBe(1)
    expect(loaded.get("dag-1")?.id).toBe("dag-1")
    expect(loaded.get("dag-1")?.nodes).toHaveLength(2)
    expect(loaded.get("dag-1")?.repo).toBe("org/repo")
  })

  it("returns empty map when no file exists", async () => {
    const store = new DagStore(tmpDir)
    const loaded = await store.load()
    expect(loaded.size).toBe(0)
  })

  it("returns empty map on corrupt JSON", async () => {
    const store = new DagStore(tmpDir)
    fs.writeFileSync(path.join(tmpDir, ".dags.json"), "not json", "utf-8")
    const loaded = await store.load()
    expect(loaded.size).toBe(0)
  })

  it("falls back to backup when main file is corrupt", async () => {
    const store = new DagStore(tmpDir)
    const dags = new Map<string, DagGraph>()
    dags.set("dag-1", makeGraph({ id: "dag-1" }))
    await store.save(dags)

    fs.writeFileSync(path.join(tmpDir, ".dags.json"), "corrupted!", "utf-8")

    const loaded = await store.load()
    expect(loaded.size).toBe(1)
    expect(loaded.get("dag-1")?.id).toBe("dag-1")
  })

  it("handles multiple DAGs", async () => {
    const store = new DagStore(tmpDir)
    const dags = new Map<string, DagGraph>()
    dags.set("dag-1", makeGraph({ id: "dag-1" }))
    dags.set("dag-2", makeGraph({ id: "dag-2", repo: "org/other" }))
    dags.set("dag-3", makeGraph({ id: "dag-3" }))

    await store.save(dags)

    const loaded = await store.load()
    expect(loaded.size).toBe(3)
    expect(loaded.get("dag-2")?.repo).toBe("org/other")
  })

  it("second save overwrites the first", async () => {
    const store = new DagStore(tmpDir)
    const dags1 = new Map<string, DagGraph>()
    dags1.set("dag-1", makeGraph({ id: "dag-1" }))
    await store.save(dags1)

    const dags2 = new Map<string, DagGraph>()
    dags2.set("dag-2", makeGraph({ id: "dag-2" }))
    await store.save(dags2)

    const loaded = await store.load()
    expect(loaded.size).toBe(1)
    expect(loaded.has("dag-1")).toBe(false)
    expect(loaded.get("dag-2")?.id).toBe("dag-2")
  })

  it("round-trips an empty map", async () => {
    const store = new DagStore(tmpDir)
    await store.save(new Map())

    const loaded = await store.load()
    expect(loaded.size).toBe(0)
  })

  it("uses atomic write (no .tmp file left after save)", async () => {
    const store = new DagStore(tmpDir)
    await store.save(new Map([["dag-1", makeGraph()]]))

    expect(fs.existsSync(path.join(tmpDir, ".dags.json"))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, ".dags.json.tmp"))).toBe(false)
  })

  it("preserves node status and metadata through save/load", async () => {
    const store = new DagStore(tmpDir)
    const graph = makeGraph()
    graph.nodes[0].prUrl = "https://github.com/org/repo/pull/1"
    graph.nodes[0].branch = "minion/test-slug"
    graph.nodes[0].error = "Session errored"
    graph.nodes[0].recoveryAttempted = true
    graph.nodes[0].threadId = 200

    const dags = new Map<string, DagGraph>()
    dags.set("dag-1", graph)
    await store.save(dags)

    const loaded = await store.load()
    const loadedNode = loaded.get("dag-1")!.nodes[0]
    expect(loadedNode.prUrl).toBe("https://github.com/org/repo/pull/1")
    expect(loadedNode.branch).toBe("minion/test-slug")
    expect(loadedNode.error).toBe("Session errored")
    expect(loadedNode.recoveryAttempted).toBe(true)
    expect(loadedNode.threadId).toBe(200)
  })

  it("returns empty map on empty file", async () => {
    const store = new DagStore(tmpDir)
    fs.writeFileSync(path.join(tmpDir, ".dags.json"), "", "utf-8")
    const loaded = await store.load()
    expect(loaded.size).toBe(0)
  })

  it("handles JSON null gracefully", async () => {
    const store = new DagStore(tmpDir)
    fs.writeFileSync(path.join(tmpDir, ".dags.json"), "null", "utf-8")
    const loaded = await store.load()
    expect(loaded.size).toBe(0)
  })
})
