import { describe, it, expect, vi } from "vitest"
import { spawn } from "node:child_process"
import { SessionHandle, type SessionConfig } from "../src/session.js"
import type { SessionMeta } from "../src/types.js"

const stubConfig: SessionConfig = {
  goose: { provider: "test", model: "test" },
  claude: { planModel: "test", thinkModel: "test" },
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
  sessionId: "test-kill",
  threadId: 1,
  topicName: "test-kill",
  repo: "test",
  cwd: "/tmp",
  startedAt: Date.now(),
  mode: "task",
}

function makeHandle(): SessionHandle {
  return new SessionHandle(stubMeta, () => {}, () => {}, 60_000, stubConfig)
}

function injectProcess(handle: SessionHandle, proc: ReturnType<typeof spawn>): void {
  const h = handle as unknown as { process: ReturnType<typeof spawn>; state: string }
  h.process = proc
  h.state = "working"
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("SessionHandle.kill", () => {
  it("resolves immediately when no process is running", async () => {
    const handle = makeHandle()
    await handle.kill()
  })

  it("resolves immediately when process already exited", async () => {
    const handle = makeHandle()
    const h = handle as unknown as { state: string }
    h.state = "completed"
    await handle.kill()
  })

  it("sends SIGINT and resolves when process exits gracefully", async () => {
    const handle = makeHandle()
    const proc = spawn("node", ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
      detached: true,
    })
    const pid = proc.pid!
    injectProcess(handle, proc)

    const start = Date.now()
    await handle.kill(5000)
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(3000)
    await new Promise((r) => setTimeout(r, 50))
    expect(isProcessAlive(pid)).toBe(false)
  })

  it("escalates to SIGKILL when process ignores SIGINT", async () => {
    const handle = makeHandle()
    const proc = spawn(
      "node",
      ["-e", "process.on('SIGINT',()=>{}); process.stdout.write('ready'); setTimeout(()=>{},30000)"],
      { stdio: ["ignore", "pipe", "ignore"], detached: true },
    )
    const pid = proc.pid!
    injectProcess(handle, proc)

    await new Promise<void>((resolve) => {
      proc.stdout!.once("data", () => resolve())
    })

    const start = Date.now()
    await handle.kill(200)
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(180)
    expect(elapsed).toBeLessThan(3000)
    await new Promise((r) => setTimeout(r, 50))
    expect(isProcessAlive(pid)).toBe(false)
  })

  it("falls back to direct kill when process group kill fails", async () => {
    const handle = makeHandle()
    // Spawn WITHOUT detached — process.kill(-pid) will fail, falling back to proc.kill()
    const proc = spawn("node", ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    })
    const pid = proc.pid!
    injectProcess(handle, proc)

    await handle.kill(5000)
    await new Promise((r) => setTimeout(r, 50))
    expect(isProcessAlive(pid)).toBe(false)
  })
})

describe("SessionHandle.killProcessGroup", () => {
  it("sends signal to negative pid for process group", () => {
    const handle = makeHandle()
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true)

    const killProcessGroup = (handle as unknown as {
      killProcessGroup: (proc: { pid: number | undefined; kill: (s: string) => void }, signal: string) => void
    }).killProcessGroup.bind(handle)

    const mockProc = { pid: 12345, kill: vi.fn() }
    killProcessGroup(mockProc, "SIGINT")

    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGINT")
    expect(mockProc.kill).not.toHaveBeenCalled()

    killSpy.mockRestore()
  })

  it("falls back to proc.kill when process.kill(-pid) throws", () => {
    const handle = makeHandle()
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH")
    })

    const killProcessGroup = (handle as unknown as {
      killProcessGroup: (proc: { pid: number | undefined; kill: (s: string) => void }, signal: string) => void
    }).killProcessGroup.bind(handle)

    const mockProc = { pid: 12345, kill: vi.fn() }
    killProcessGroup(mockProc, "SIGKILL")

    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGKILL")
    expect(mockProc.kill).toHaveBeenCalledWith("SIGKILL")

    killSpy.mockRestore()
  })

  it("falls back to proc.kill when pid is undefined", () => {
    const handle = makeHandle()

    const killProcessGroup = (handle as unknown as {
      killProcessGroup: (proc: { pid: number | undefined; kill: (s: string) => void }, signal: string) => void
    }).killProcessGroup.bind(handle)

    const mockProc = { pid: undefined, kill: vi.fn() }
    killProcessGroup(mockProc, "SIGTERM")

    expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM")
  })

  it("does not throw when both process.kill and proc.kill fail", () => {
    const handle = makeHandle()
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH")
    })

    const killProcessGroup = (handle as unknown as {
      killProcessGroup: (proc: { pid: number | undefined; kill: (s: string) => void }, signal: string) => void
    }).killProcessGroup.bind(handle)

    const mockProc = {
      pid: 12345,
      kill: vi.fn().mockImplementation(() => { throw new Error("already dead") }),
    }

    expect(() => killProcessGroup(mockProc, "SIGKILL")).not.toThrow()

    killSpy.mockRestore()
  })
})

describe("SessionHandle.interrupt", () => {
  it("calls killProcessGroup with SIGINT", () => {
    const handle = makeHandle()
    const killGroupSpy = vi.fn()
    const h = handle as unknown as {
      process: { pid: number };
      state: string;
      killProcessGroup: typeof killGroupSpy;
    }
    h.process = { pid: 999 } as unknown as { pid: number }
    h.state = "working"
    h.killProcessGroup = killGroupSpy

    handle.interrupt()
    expect(killGroupSpy).toHaveBeenCalledWith(h.process, "SIGINT")
  })
})
