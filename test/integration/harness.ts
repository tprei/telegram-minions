/**
 * Integration test harness — creates isolated mini-repos with mock agent
 * binaries for testing minion session behavior end-to-end without real
 * LLM calls or network access.
 *
 * Usage:
 *   const harness = await createTestHarness({ scenario: simpleSuccess() })
 *   const result = await harness.runSession("Implement feature X")
 *   expect(result.events).toContainEqual(expect.objectContaining({ type: "complete" }))
 *   harness.cleanup()
 */

import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { installMockAgent, writeScenarioFile } from "../mock-agent/index.js"
import type { MockAgentInstall } from "../mock-agent/index.js"
import type { Scenario } from "../mock-agent/index.js"
import { FakeTelegram } from "./fake-telegram.js"
import { SessionHandle } from "../../src/session/session.js"
import type { SessionConfig } from "../../src/session/session.js"
import type { GooseStreamEvent, SessionMeta, SessionMode } from "../../src/types.js"

// ── Types ──

export interface HarnessOptions {
  /** Initial scenario for the mock agent */
  scenario: Scenario
  /** Files to seed in the mini-repo (path relative to repo root → content) */
  files?: Record<string, string>
  /** Session mode (default: "task") */
  mode?: SessionMode
  /** Session timeout in ms (default: 10_000) */
  timeoutMs?: number
  /** Inactivity timeout in ms (default: 5_000) */
  inactivityTimeoutMs?: number
  /** Whether to initialize as a git repo (default: true) */
  initGit?: boolean
  /** Optional callback port for mock agent invocation inspection */
  callbackPort?: number
}

export interface SessionResult {
  /** All events emitted by the session */
  events: GooseStreamEvent[]
  /** Final session state */
  state: "completed" | "errored"
  /** The SessionMeta at completion */
  meta: SessionMeta
}

export interface TestHarness {
  /** The isolated workspace directory (a git repo) */
  workDir: string
  /** FakeTelegram instance for Telegram API assertions */
  telegram: FakeTelegram
  /** The mock agent install (for scenario switching) */
  mockAgent: MockAgentInstall
  /** Path to the current scenario file */
  scenarioPath: string

  /**
   * Run a session to completion and return collected events.
   * Creates a SessionHandle, starts it, and waits for the done callback.
   */
  runSession(task: string, opts?: RunSessionOptions): Promise<SessionResult>

  /**
   * Create a SessionHandle without starting it (for manual control).
   */
  createSession(opts?: CreateSessionOptions): SessionHandle

  /** Switch the mock agent to a different scenario */
  setScenario(scenario: Scenario): void

  /** Write a file into the mini-repo */
  writeFile(relativePath: string, content: string): void

  /** Read a file from the mini-repo */
  readFile(relativePath: string): string

  /** Run a git command in the mini-repo */
  git(args: string): string

  /** Clean up all temp directories */
  cleanup(): void
}

export interface RunSessionOptions {
  mode?: SessionMode
  threadId?: number
  systemPrompt?: string
}

export interface CreateSessionOptions {
  mode?: SessionMode
  threadId?: number
}

// ── Defaults ──

const DEFAULT_SESSION_CONFIG: SessionConfig = {
  goose: { provider: "mock", model: "mock-model" },
  claude: { planModel: "mock-plan", thinkModel: "mock-think", reviewModel: "mock-review" },
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

let sessionCounter = 0

function nextSessionId(): string {
  return `test-session-${++sessionCounter}`
}

/** Reset session counter between test suites */
export function resetHarnessState(): void {
  sessionCounter = 0
}

// ── Harness factory ──

/**
 * Create an isolated test harness with a mini-repo and mock agent.
 *
 * The mini-repo is a real git repository in a temp directory, initialized
 * with an initial commit. The mock agent binary is installed via PATH
 * override so that `spawn("claude", ...)` and `spawn("goose", ...)` both
 * resolve to the mock.
 */
export function createTestHarness(opts: HarnessOptions): TestHarness {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "minion-harness-"))
  const workDir = path.join(rootDir, "repo")
  fs.mkdirSync(workDir, { recursive: true })

  // Initialize git repo
  const initGit = opts.initGit !== false
  if (initGit) {
    const gitOpts = { cwd: workDir, stdio: "pipe" as const, timeout: 10_000 }
    execSync("git init", gitOpts)
    execSync('git config user.email "test@minion.test"', gitOpts)
    execSync('git config user.name "Test Minion"', gitOpts)

    // Seed files
    if (opts.files) {
      for (const [relPath, content] of Object.entries(opts.files)) {
        const absPath = path.join(workDir, relPath)
        fs.mkdirSync(path.dirname(absPath), { recursive: true })
        fs.writeFileSync(absPath, content)
      }
    }

    // Always create at least one file for the initial commit
    const readmePath = path.join(workDir, "README.md")
    if (!fs.existsSync(readmePath)) {
      fs.writeFileSync(readmePath, "# Test repo\n")
    }

    execSync("git add -A", gitOpts)
    execSync('git commit -m "initial commit"', gitOpts)
  } else if (opts.files) {
    for (const [relPath, content] of Object.entries(opts.files)) {
      const absPath = path.join(workDir, relPath)
      fs.mkdirSync(path.dirname(absPath), { recursive: true })
      fs.writeFileSync(absPath, content)
    }
  }

  // Write scenario and install mock agent
  const scenarioDir = path.join(rootDir, "scenarios")
  fs.mkdirSync(scenarioDir, { recursive: true })
  let scenarioPath = writeScenarioFile(opts.scenario, scenarioDir)

  const mockAgent = installMockAgent({
    scenarioPath,
    callbackPort: opts.callbackPort,
  })

  const telegram = new FakeTelegram()

  // Set mock agent env vars in process.env so buildIsolatedEnv() can
  // pass them through via sessionEnvPassthrough
  const savedEnv = {
    PATH: process.env["PATH"],
    MOCK_SCENARIO_PATH: process.env["MOCK_SCENARIO_PATH"],
    MOCK_CALLBACK_PORT: process.env["MOCK_CALLBACK_PORT"],
  }

  const timeoutMs = opts.timeoutMs ?? 30_000
  const inactivityTimeoutMs = opts.inactivityTimeoutMs ?? 15_000
  const defaultMode = opts.mode ?? "task"

  function buildSessionMeta(overrides?: { mode?: SessionMode; threadId?: number }): SessionMeta {
    const sessionId = nextSessionId()
    const mode = overrides?.mode ?? defaultMode
    const threadId = overrides?.threadId ?? 1
    return {
      sessionId,
      threadId,
      topicName: `test-${sessionId}`,
      repo: "test/repo",
      cwd: workDir,
      startedAt: Date.now(),
      mode,
    }
  }

  function buildSessionConfig(): SessionConfig {
    const passthroughVars = ["MOCK_SCENARIO_PATH"]
    if (opts.callbackPort) passthroughVars.push("MOCK_CALLBACK_PORT")
    return { ...DEFAULT_SESSION_CONFIG, sessionEnvPassthrough: passthroughVars }
  }

  function createSession(createOpts?: CreateSessionOptions): SessionHandle {
    const meta = buildSessionMeta(createOpts)
    const config = buildSessionConfig()

    return new SessionHandle(
      meta,
      () => {},
      () => {},
      timeoutMs,
      inactivityTimeoutMs,
      config,
    )
  }

  function applyMockEnv(): void {
    process.env["PATH"] = mockAgent.env.PATH
    process.env["MOCK_SCENARIO_PATH"] = mockAgent.env.MOCK_SCENARIO_PATH
    if (mockAgent.env.MOCK_CALLBACK_PORT) {
      process.env["MOCK_CALLBACK_PORT"] = mockAgent.env.MOCK_CALLBACK_PORT
    }
  }

  function restoreMockEnv(): void {
    process.env["PATH"] = savedEnv.PATH
    if (savedEnv.MOCK_SCENARIO_PATH !== undefined) {
      process.env["MOCK_SCENARIO_PATH"] = savedEnv.MOCK_SCENARIO_PATH
    } else {
      delete process.env["MOCK_SCENARIO_PATH"]
    }
    if (savedEnv.MOCK_CALLBACK_PORT !== undefined) {
      process.env["MOCK_CALLBACK_PORT"] = savedEnv.MOCK_CALLBACK_PORT
    } else {
      delete process.env["MOCK_CALLBACK_PORT"]
    }
  }

  async function runSession(task: string, runOpts?: RunSessionOptions): Promise<SessionResult> {
    const meta = buildSessionMeta(runOpts)
    const config = buildSessionConfig()
    const events: GooseStreamEvent[] = []

    // Override process.env so buildIsolatedEnv() picks up the mock agent
    // PATH and sessionEnvPassthrough forwards MOCK_SCENARIO_PATH.
    applyMockEnv()

    return new Promise<SessionResult>((resolve) => {
      const handle = new SessionHandle(
        meta,
        (event) => { events.push(event) },
        (doneMeta, state) => {
          restoreMockEnv()
          resolve({ events, state, meta: doneMeta })
        },
        timeoutMs,
        inactivityTimeoutMs,
        config,
      )

      handle.start(task, runOpts?.systemPrompt)
    })
  }

  const harness: TestHarness = {
    workDir,
    telegram,
    mockAgent,
    scenarioPath,

    runSession,
    createSession,

    setScenario(scenario: Scenario) {
      scenarioPath = writeScenarioFile(scenario, scenarioDir)
      mockAgent.setScenario(scenarioPath)
      harness.scenarioPath = scenarioPath
    },

    writeFile(relativePath: string, content: string) {
      const absPath = path.join(workDir, relativePath)
      fs.mkdirSync(path.dirname(absPath), { recursive: true })
      fs.writeFileSync(absPath, content)
    },

    readFile(relativePath: string): string {
      return fs.readFileSync(path.join(workDir, relativePath), "utf-8")
    },

    git(args: string): string {
      return execSync(`git ${args}`, {
        cwd: workDir,
        stdio: "pipe",
        timeout: 10_000,
        encoding: "utf-8",
      }).trim()
    },

    cleanup() {
      mockAgent.cleanup()
      try {
        fs.rmSync(rootDir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    },
  }

  return harness
}
