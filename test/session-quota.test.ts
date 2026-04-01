import { describe, it, expect, vi } from "vitest"
import { spawn } from "node:child_process"
import { SessionHandle, type SessionConfig } from "../src/session/session.js"
import { SDKSessionHandle } from "../src/session/sdk-session.js"
import type { SessionMeta, GooseStreamEvent, SessionDoneState } from "../src/types.js"

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
    zaiEnabled: false,
  },
}

const stubMeta: SessionMeta = {
  sessionId: "test-quota",
  threadId: 1,
  topicName: "test-quota",
  repo: "test",
  cwd: "/tmp",
  startedAt: Date.now(),
  mode: "task",
}

function injectProcess(handle: SessionHandle | SDKSessionHandle, proc: ReturnType<typeof spawn>): void {
  const h = handle as unknown as { process: ReturnType<typeof spawn>; state: string }
  h.process = proc
  h.state = "working"
}

function attachHandlers(handle: SessionHandle | SDKSessionHandle): void {
  const h = handle as unknown as {
    attachProcessHandlers: (parseLine: (line: string) => void) => void
  }
  h.attachProcessHandlers.bind(handle)(() => {})
}

describe("Session quota detection", () => {
  describe("SessionHandle", () => {
    it("signals quota_exhausted when stderr contains a quota error", async () => {
      const events: GooseStreamEvent[] = []
      let doneState: SessionDoneState | null = null

      const handle = new SessionHandle(
        stubMeta,
        (event) => events.push(event),
        (_meta, state) => { doneState = state },
        60_000,
        300_000,
        stubConfig,
      )

      // Spawn a process that writes a quota error to stderr and exits with code 1
      const proc = spawn("node", ["-e", `
        process.stderr.write("You have hit your usage limit. Usage resets at 5 PM UTC.");
        process.exit(1);
      `], { stdio: ["ignore", "pipe", "pipe"] })

      injectProcess(handle, proc)
      attachHandlers(handle)

      const result = await handle.waitForCompletion()

      expect(result).toBe("quota_exhausted")
      expect(doneState).toBe("quota_exhausted")

      const quotaEvent = events.find((e) => e.type === "quota_exhausted")
      expect(quotaEvent).toBeDefined()
      expect(quotaEvent!.type).toBe("quota_exhausted")
      if (quotaEvent!.type === "quota_exhausted") {
        expect(quotaEvent!.resetAt).toBeGreaterThan(0)
        expect(quotaEvent!.rawMessage).toContain("usage limit")
      }
    })

    it("signals errored for non-quota stderr on non-zero exit", async () => {
      let doneState: SessionDoneState | null = null

      const handle = new SessionHandle(
        stubMeta,
        () => {},
        (_meta, state) => { doneState = state },
        60_000,
        300_000,
        stubConfig,
      )

      const proc = spawn("node", ["-e", `
        process.stderr.write("some random error");
        process.exit(1);
      `], { stdio: ["ignore", "pipe", "pipe"] })

      injectProcess(handle, proc)
      attachHandlers(handle)

      const result = await handle.waitForCompletion()

      expect(result).toBe("errored")
      expect(doneState).toBe("errored")
    })

    it("signals completed for exit code 0 even with quota-like stderr", async () => {
      let doneState: SessionDoneState | null = null

      const handle = new SessionHandle(
        stubMeta,
        () => {},
        (_meta, state) => { doneState = state },
        60_000,
        300_000,
        stubConfig,
      )

      // Exit code 0 — quota detection should not trigger
      const proc = spawn("node", ["-e", `
        process.stderr.write("Usage limit warning");
        process.exit(0);
      `], { stdio: ["ignore", "pipe", "pipe"] })

      injectProcess(handle, proc)
      attachHandlers(handle)

      const result = await handle.waitForCompletion()

      expect(result).toBe("completed")
      expect(doneState).toBe("completed")
    })
  })

  describe("SDKSessionHandle", () => {
    it("signals quota_exhausted when stderr contains a quota error", async () => {
      const events: GooseStreamEvent[] = []
      let doneState: SessionDoneState | null = null

      const handle = new SDKSessionHandle(
        stubMeta,
        (event) => events.push(event),
        (_meta, state) => { doneState = state },
        60_000,
        300_000,
        stubConfig,
      )

      const proc = spawn("node", ["-e", `
        process.stderr.write("You've exceeded your rate limit. Try again in 30 minutes.");
        process.exit(1);
      `], { stdio: ["ignore", "pipe", "pipe"] })

      injectProcess(handle, proc)
      attachHandlers(handle)

      const result = await handle.waitForCompletion()

      expect(result).toBe("quota_exhausted")
      expect(doneState).toBe("quota_exhausted")

      const quotaEvent = events.find((e) => e.type === "quota_exhausted")
      expect(quotaEvent).toBeDefined()
      if (quotaEvent!.type === "quota_exhausted") {
        expect(quotaEvent!.resetAt).toBeGreaterThan(0)
        expect(quotaEvent!.rawMessage).toContain("rate limit")
      }
    })

    it("signals errored for non-quota stderr on non-zero exit", async () => {
      let doneState: SessionDoneState | null = null

      const handle = new SDKSessionHandle(
        stubMeta,
        () => {},
        (_meta, state) => { doneState = state },
        60_000,
        300_000,
        stubConfig,
      )

      const proc = spawn("node", ["-e", `
        process.stderr.write("connection refused");
        process.exit(1);
      `], { stdio: ["ignore", "pipe", "pipe"] })

      injectProcess(handle, proc)
      attachHandlers(handle)

      const result = await handle.waitForCompletion()

      expect(result).toBe("errored")
      expect(doneState).toBe("errored")
    })
  })

  describe("stderr truncation", () => {
    it("truncates rawMessage to 500 chars in the quota_exhausted event", async () => {
      const events: GooseStreamEvent[] = []

      const handle = new SessionHandle(
        stubMeta,
        (event) => events.push(event),
        () => {},
        60_000,
        300_000,
        stubConfig,
      )

      // Write a long message with quota error pattern at the start
      const longMessage = "You have hit your usage limit. " + "x".repeat(600)
      const proc = spawn("node", ["-e", `
        process.stderr.write(${JSON.stringify(longMessage)});
        process.exit(1);
      `], { stdio: ["ignore", "pipe", "pipe"] })

      injectProcess(handle, proc)
      attachHandlers(handle)

      await handle.waitForCompletion()

      const quotaEvent = events.find((e) => e.type === "quota_exhausted")
      expect(quotaEvent).toBeDefined()
      if (quotaEvent!.type === "quota_exhausted") {
        expect(quotaEvent!.rawMessage.length).toBeLessThanOrEqual(500)
      }
    })
  })
})
