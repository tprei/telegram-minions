import { describe, it, expect } from "vitest"
import { spawn } from "node:child_process"
import type { Interface } from "node:readline"
import { SessionHandle, type SessionConfig } from "../src/session/session.js"
import { SDKSessionHandle } from "../src/session/sdk-session.js"
import type { SessionMeta } from "../src/domain/session-types.js"

const stubConfig: SessionConfig = {
  goose: { provider: "test", model: "test" },
  claude: { planModel: "test", thinkModel: "test", reviewModel: "test" },
  mcp: {
    browserEnabled: false,
    githubEnabled: false,
    context7Enabled: false,
    sentryEnabled: false,
    sentryOrgSlug: "",
    sentryProjectSlug: "",
    supabaseEnabled: false,
    supabaseProjectRef: "",
    flyEnabled: false,
    flyOrg: "",
    zaiEnabled: false,
  },
}

const stubMeta: SessionMeta = {
  sessionId: "test-rl-close",
  threadId: 1,
  topicName: "test-rl-close",
  repo: "test",
  cwd: "/tmp",
  startedAt: Date.now(),
  mode: "task",
}

function makeHandle(): SessionHandle {
  return new SessionHandle(stubMeta, () => {}, () => {}, 60_000, 300_000, stubConfig)
}

function makeSDKHandle(): SDKSessionHandle {
  return new SDKSessionHandle(stubMeta, () => {}, () => {}, 60_000, 300_000, stubConfig)
}

function injectProcess(handle: SessionHandle | SDKSessionHandle, proc: ReturnType<typeof spawn>): void {
  const h = handle as unknown as { process: ReturnType<typeof spawn>; state: string }
  h.process = proc
  h.state = "working"
}

function getRl(handle: SessionHandle | SDKSessionHandle): Interface | null {
  return (handle as unknown as { rl: Interface | null }).rl
}

function attachHandlers(handle: SessionHandle | SDKSessionHandle): void {
  if (handle instanceof SessionHandle) {
    const attach = (handle as unknown as {
      attachProcessHandlers: (parseLine: (line: string) => void) => void
    }).attachProcessHandlers.bind(handle)
    attach(() => {})
  } else {
    const attach = (handle as unknown as {
      attachProcessHandlers: () => void
    }).attachProcessHandlers.bind(handle)
    attach()
  }
}

describe("SessionHandle readline cleanup", () => {
  it("stores readline interface on the instance", () => {
    const handle = makeHandle()
    const proc = spawn("node", ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    injectProcess(handle, proc)

    expect(getRl(handle)).toBeNull()
    attachHandlers(handle)
    expect(getRl(handle)).not.toBeNull()

    try { process.kill(-proc.pid!, "SIGKILL") } catch {}
  })

  it("closes readline when process exits normally", async () => {
    const handle = makeHandle()
    const proc = spawn("node", ["-e", "process.exit(0)"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    injectProcess(handle, proc)
    attachHandlers(handle)

    expect(getRl(handle)).not.toBeNull()

    await new Promise((r) => setTimeout(r, 200))

    expect(getRl(handle)).toBeNull()
  })

  it("closes readline when process exits with error", async () => {
    const handle = makeHandle()
    const proc = spawn("node", ["-e", "process.exit(1)"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    injectProcess(handle, proc)
    attachHandlers(handle)

    expect(getRl(handle)).not.toBeNull()

    await new Promise((r) => setTimeout(r, 200))

    expect(getRl(handle)).toBeNull()
  })
})

describe("SDKSessionHandle readline cleanup", () => {
  it("stores readline interface on the instance", () => {
    const handle = makeSDKHandle()
    const proc = spawn("node", ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    injectProcess(handle, proc)

    expect(getRl(handle)).toBeNull()
    attachHandlers(handle)
    expect(getRl(handle)).not.toBeNull()

    try { process.kill(-proc.pid!, "SIGKILL") } catch {}
  })

  it("closes readline when process exits normally", async () => {
    const handle = makeSDKHandle()
    const proc = spawn("node", ["-e", "process.exit(0)"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    injectProcess(handle, proc)
    attachHandlers(handle)

    expect(getRl(handle)).not.toBeNull()

    await new Promise((r) => setTimeout(r, 200))

    expect(getRl(handle)).toBeNull()
  })

  it("closes readline when process exits with error", async () => {
    const handle = makeSDKHandle()
    const proc = spawn("node", ["-e", "process.exit(1)"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    injectProcess(handle, proc)
    attachHandlers(handle)

    expect(getRl(handle)).not.toBeNull()

    await new Promise((r) => setTimeout(r, 200))

    expect(getRl(handle)).toBeNull()
  })
})