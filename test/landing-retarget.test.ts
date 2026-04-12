import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"

const { execFilePromise } = vi.hoisted(() => {
  return { execFilePromise: vi.fn() }
})

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  const { promisify } = await import("node:util")
  const mockFn = Object.assign(vi.fn(), {
    [promisify.custom]: execFilePromise,
  })
  return { ...actual, execFile: mockFn }
})

import { LandingManager } from "../src/dag/landing-manager.js"
import { createMockContext } from "./test-helpers.js"
import type { TopicSession } from "../src/domain/session-types.js"
import type { DagGraph } from "../src/dag/dag.js"

function makeSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 100,
    repo: "test-repo",
    cwd: "/tmp/test-landing",
    slug: "test-slug",
    conversation: [],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

function makeTwoNodeDag(): DagGraph {
  return {
    id: "dag-1",
    nodes: [
      {
        id: "a",
        title: "Step 0",
        description: "",
        status: "done",
        dependsOn: [],
        prUrl: "https://github.com/org/repo/pull/1",
        branch: "minion/a",
        mergeBase: "base-a",
      },
      {
        id: "b",
        title: "Step 1",
        description: "",
        status: "done",
        dependsOn: ["a"],
        prUrl: "https://github.com/org/repo/pull/2",
        branch: "minion/b",
        mergeBase: "base-b",
      },
    ],
    parentThreadId: 100,
    repo: "test-repo",
  }
}

describe("landing retarget fixes", () => {
  let tmpDir: string
  let callLog: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    tmpDir = fs.mkdtempSync(path.join("/tmp", "landing-retarget-"))
    fs.mkdirSync(path.join(tmpDir, ".git"))
    execFilePromise.mockReset()
    callLog = []
  })

  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function ok(stdout = ""): Promise<{ stdout: string; stderr: string }> {
    return Promise.resolve({ stdout, stderr: "" })
  }

  function installDefaultMock() {
    execFilePromise.mockImplementation((cmd: string, args: string[]) => {
      const key = `${cmd} ${args.join(" ")}`.trim()
      callLog.push(key)

      if (key.includes("repo view") && key.includes("defaultBranchRef")) return ok("master")
      if (key.includes("pr view") && key.includes(".state")) return ok("OPEN")
      if (key.includes("pr view") && key.includes("mergeable")) return ok("MERGEABLE")
      if (key.includes("rev-parse HEAD")) return ok("abc123")
      return ok()
    })
  }

  async function runLanding(manager: LandingManager, session: TopicSession) {
    const p = manager.handleLandCommand(session)
    await vi.runAllTimersAsync()
    return p
  }

  it("retargets downstream PRs before merging the current node", async () => {
    installDefaultMock()

    const ctx = createMockContext()
    ctx.dags.set("dag-1", makeTwoNodeDag())

    const manager = new LandingManager(ctx)
    const session = makeSession({ dagId: "dag-1", cwd: tmpDir })

    await runLanding(manager, session)

    const retargetIdx = callLog.findIndex(
      (c) => c.includes("pr edit") && c.includes("2") && c.includes("--base") && c.includes("master"),
    )
    const mergeIdx = callLog.findIndex(
      (c) => c.includes("pr merge") && c.includes("1") && c.includes("--squash"),
    )

    expect(retargetIdx).toBeGreaterThan(-1)
    expect(mergeIdx).toBeGreaterThan(-1)
    expect(retargetIdx).toBeLessThan(mergeIdx)
  })

  it("fetches downstream branch alongside baseBranch during restack", async () => {
    installDefaultMock()

    const ctx = createMockContext()
    ctx.dags.set("dag-1", makeTwoNodeDag())

    const manager = new LandingManager(ctx)
    const session = makeSession({ dagId: "dag-1", cwd: tmpDir })

    await runLanding(manager, session)

    const fetchCmd = callLog.find(
      (c) => c.startsWith("git fetch origin") && c.includes("minion/b"),
    )
    expect(fetchCmd).toBeDefined()
    expect(fetchCmd).toContain("master")
    expect(fetchCmd).toContain("minion/b")
  })

  it("reopens auto-closed PRs during restack", async () => {
    let prView2StateCount = 0
    execFilePromise.mockImplementation((cmd: string, args: string[]) => {
      const key = `${cmd} ${args.join(" ")}`.trim()
      callLog.push(key)

      if (key.includes("repo view") && key.includes("defaultBranchRef")) return ok("master")
      if (key.includes("pr view") && key.includes("2") && key.includes(".state")) {
        prView2StateCount++
        return ok(prView2StateCount === 1 ? "CLOSED" : "OPEN")
      }
      if (key.includes("pr view") && key.includes(".state")) return ok("OPEN")
      if (key.includes("pr view") && key.includes("mergeable")) return ok("MERGEABLE")
      if (key.includes("rev-parse HEAD")) return ok("abc123")
      return ok()
    })

    const ctx = createMockContext()
    ctx.dags.set("dag-1", makeTwoNodeDag())

    const manager = new LandingManager(ctx)
    const session = makeSession({ dagId: "dag-1", cwd: tmpDir })

    await runLanding(manager, session)

    const reopenCmd = callLog.find(
      (c) => c.includes("pr reopen") && c.includes("2"),
    )
    expect(reopenCmd).toBeDefined()
  })
})
