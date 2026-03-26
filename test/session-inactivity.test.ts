import { describe, it, expect, vi } from "vitest"
import { spawn } from "node:child_process"
import { SessionHandle, type SessionConfig } from "../src/session.js"
import type { SessionMeta } from "../src/types.js"

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
    zaiEnabled: false,
  },
}

const stubMeta: SessionMeta = {
  sessionId: "test-inactivity",
  threadId: 1,
  topicName: "test-inactivity",
  repo: "test",
  cwd: "/tmp",
  startedAt: Date.now(),
  mode: "task",
}

function makeHandle(inactivityMs: number): SessionHandle {
  return new SessionHandle(stubMeta, () => {}, () => {}, 60_000, inactivityMs, stubConfig)
}

function injectProcess(handle: SessionHandle, proc: ReturnType<typeof spawn>): void {
  const h = handle as unknown as { process: ReturnType<typeof spawn>; state: string }
  h.process = proc
  h.state = "working"
}

function getInactivityHandle(handle: SessionHandle): ReturnType<typeof setTimeout> | null {
  return (handle as unknown as { inactivityHandle: ReturnType<typeof setTimeout> | null }).inactivityHandle
}

describe("Session inactivity timeout", () => {
  it("fires interrupt when process produces no output", async () => {
    const handle = makeHandle(200)
    const interruptSpy = vi.spyOn(handle, "interrupt")

    const proc = spawn("node", ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    injectProcess(handle, proc)

    const attachHandlers = (handle as unknown as {
      attachProcessHandlers: (parseLine: (line: string) => void) => void
    }).attachProcessHandlers.bind(handle)
    attachHandlers(() => {})

    await new Promise((r) => setTimeout(r, 400))

    expect(interruptSpy).toHaveBeenCalled()

    try { process.kill(-proc.pid!, "SIGKILL") } catch {}
  })

  it("resets timer when stdout produces a line", async () => {
    const handle = makeHandle(300)
    const interruptSpy = vi.spyOn(handle, "interrupt")

    const proc = spawn(
      "node",
      ["-e", `
        setTimeout(() => process.stdout.write('{"type":"text"}\\n'), 150);
        setTimeout(() => {}, 30000);
      `],
      { stdio: ["ignore", "pipe", "pipe"], detached: true },
    )
    injectProcess(handle, proc)

    const attachHandlers = (handle as unknown as {
      attachProcessHandlers: (parseLine: (line: string) => void) => void
    }).attachProcessHandlers.bind(handle)
    attachHandlers(() => {})

    await new Promise((r) => setTimeout(r, 250))
    expect(interruptSpy).not.toHaveBeenCalled()

    await new Promise((r) => setTimeout(r, 200))
    expect(interruptSpy).not.toHaveBeenCalled()

    try { process.kill(-proc.pid!, "SIGKILL") } catch {}
  })

  it("resets timer when stderr produces data", async () => {
    const handle = makeHandle(300)
    const interruptSpy = vi.spyOn(handle, "interrupt")

    const proc = spawn(
      "node",
      ["-e", `
        setTimeout(() => process.stderr.write('progress output\\n'), 150);
        setTimeout(() => {}, 30000);
      `],
      { stdio: ["ignore", "pipe", "pipe"], detached: true },
    )
    injectProcess(handle, proc)

    const attachHandlers = (handle as unknown as {
      attachProcessHandlers: (parseLine: (line: string) => void) => void
    }).attachProcessHandlers.bind(handle)
    attachHandlers(() => {})

    await new Promise((r) => setTimeout(r, 250))
    expect(interruptSpy).not.toHaveBeenCalled()

    await new Promise((r) => setTimeout(r, 200))
    expect(interruptSpy).not.toHaveBeenCalled()

    try { process.kill(-proc.pid!, "SIGKILL") } catch {}
  })

  it("clears timer on normal process exit", async () => {
    const handle = makeHandle(200)
    const interruptSpy = vi.spyOn(handle, "interrupt")

    const proc = spawn("node", ["-e", "process.exit(0)"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    injectProcess(handle, proc)

    const attachHandlers = (handle as unknown as {
      attachProcessHandlers: (parseLine: (line: string) => void) => void
    }).attachProcessHandlers.bind(handle)
    attachHandlers(() => {})

    await new Promise((r) => setTimeout(r, 400))

    expect(interruptSpy).not.toHaveBeenCalled()
    expect(getInactivityHandle(handle)).toBeNull()
  })
})
