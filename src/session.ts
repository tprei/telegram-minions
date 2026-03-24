import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import fs from "node:fs"
import path from "node:path"
import type { GooseConfig, ClaudeConfig, McpConfig, ProviderProfile } from "./config-types.js"
import type { GooseStreamEvent, SessionMeta, SessionState } from "./types.js"
import { translateClaudeEvents } from "./claude-stream.js"
import { captureException, setContext, addBreadcrumb } from "./sentry.js"
import { DEFAULT_TASK_PROMPT, DEFAULT_PLAN_PROMPT, DEFAULT_THINK_PROMPT } from "./prompts.js"

export const SCREENSHOTS_DIR = ".screenshots"

export type SessionEventCallback = (event: GooseStreamEvent) => void
export type SessionDoneCallback = (meta: SessionMeta, state: "completed" | "errored") => void

export interface SessionConfig {
  goose: GooseConfig
  claude: ClaudeConfig
  mcp: McpConfig
  profile?: ProviderProfile
  /** List of environment variable names to pass through to minion sessions */
  sessionEnvPassthrough?: string[]
}

const PLAN_DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit"]
const THINK_DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit"]

type McpServerConfig = {
  command: string
  args: string[]
  env?: Record<string, string>
}

export class SessionHandle {
  private process: ChildProcess | null = null
  private state: SessionState = "spawning"
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly meta: SessionMeta,
    private readonly onEvent: SessionEventCallback,
    private readonly onDone: SessionDoneCallback,
    private readonly timeoutMs: number,
    private readonly sessionConfig: SessionConfig,
  ) {}

  start(task: string, systemPrompt?: string): void {
    setContext("session", {
      sessionId: this.meta.sessionId,
      repo: this.meta.repo,
      mode: this.meta.mode,
      topicName: this.meta.topicName,
    })
    addBreadcrumb({
      category: "session",
      message: `Starting ${this.meta.mode} session: ${this.meta.topicName}`,
      level: "info",
      data: { repo: this.meta.repo, sessionId: this.meta.sessionId },
    })

    if (this.meta.mode === "think" && !systemPrompt) {
      this.startClaudeThink(task)
    } else if (this.meta.mode === "plan" && !systemPrompt) {
      this.startClaude(task)
    } else {
      this.startGoose(task, systemPrompt)
    }
  }

  private buildMcpServers(): Record<string, McpServerConfig> {
    const servers: Record<string, McpServerConfig> = {}

    if (this.sessionConfig.mcp.browserEnabled) {
      servers.playwright = {
        command: "playwright-mcp",
        args: ["--browser", "chromium", "--headless", "--no-sandbox", "--isolated", "--caps", "vision"],
      }
    }

    if (this.sessionConfig.mcp.githubEnabled) {
      const token = process.env["GITHUB_TOKEN"]
      if (token) {
        servers.github = {
          command: "github-mcp-server",
          args: ["stdio"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
        }
      } else {
        process.stderr.write("MCP: GitHub MCP enabled but GITHUB_TOKEN is not set — skipping\n")
      }
    }

    if (this.sessionConfig.mcp.context7Enabled) {
      servers.context7 = {
        command: "context7-mcp",
        args: [],
      }
    }

    if (this.sessionConfig.mcp.sentryEnabled) {
      const sentryToken = process.env["SENTRY_ACCESS_TOKEN"]
      if (sentryToken) {
        const sentryArgs = ["-y", "@sentry/mcp-server@latest", "--access-token", sentryToken]
        if (this.sessionConfig.mcp.sentryOrgSlug) {
          sentryArgs.push("--organization-slug", this.sessionConfig.mcp.sentryOrgSlug)
        }
        if (this.sessionConfig.mcp.sentryProjectSlug) {
          sentryArgs.push("--project-slug", this.sessionConfig.mcp.sentryProjectSlug)
        }
        servers.sentry = {
          command: "npx",
          args: sentryArgs,
        }
      } else {
        process.stderr.write("MCP: Sentry MCP enabled but SENTRY_ACCESS_TOKEN is not set — skipping\n")
      }
    }

    return servers
  }

  private buildGooseExtensionArgs(): string[] {
    const args: string[] = []
    const servers = this.buildMcpServers()

    for (const [, server] of Object.entries(servers)) {
      const cmdWithArgs = [server.command, ...server.args].join(" ")
      args.push("--with-extension", cmdWithArgs)
    }

    return args
  }

  private buildClaudeMcpConfigArgs(): string[] {
    const servers = this.buildMcpServers()
    if (Object.keys(servers).length === 0) return []

    return ["--mcp-config", JSON.stringify({ mcpServers: servers })]
  }

  private buildIsolatedEnv(): Record<string, string> {
    const parentHome = process.env["HOME"] ?? "/root"
    const parentClaudeDir = path.join(parentHome, ".claude")
    const sessionHome = path.join(this.meta.cwd, ".home")

    const screenshotsDir = path.join(this.meta.cwd, SCREENSHOTS_DIR)
    fs.mkdirSync(screenshotsDir, { recursive: true })

    const sessionTmp = path.join(sessionHome, "tmp")
    const sessionConfig = path.join(sessionHome, ".config")
    const sessionCache = path.join(sessionHome, ".cache")
    const sessionDataDir = path.join(sessionHome, ".local", "share")
    const sessionStateDir = path.join(sessionHome, ".local", "state")
    const screenshotDir = path.join(sessionHome, "screenshots")

    fs.mkdirSync(path.join(sessionHome, ".claude"), { recursive: true })
    fs.mkdirSync(sessionTmp, { recursive: true })
    fs.mkdirSync(sessionConfig, { recursive: true })
    fs.mkdirSync(sessionCache, { recursive: true })
    fs.mkdirSync(sessionDataDir, { recursive: true })
    fs.mkdirSync(sessionStateDir, { recursive: true })
    fs.mkdirSync(screenshotDir, { recursive: true })

    this.meta.screenshotDir = screenshotDir

    const settingsSrc = path.join(parentClaudeDir, "settings.json")
    const settingsDst = path.join(sessionHome, ".claude", "settings.json")
    if (fs.existsSync(settingsSrc) && !fs.existsSync(settingsDst)) {
      fs.copyFileSync(settingsSrc, settingsDst)
    }

    const baseEnv: Record<string, string> = {
      PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: sessionHome,
      CLAUDE_CONFIG_DIR: parentClaudeDir,
      LANG: process.env["LANG"] ?? "C.UTF-8",
      TERM: process.env["TERM"] ?? "xterm",
      NODE_PATH: process.env["NODE_PATH"] ?? "",
      GITHUB_TOKEN: process.env["GITHUB_TOKEN"] ?? "",
      GIT_TERMINAL_PROMPT: "0",
      TMPDIR: sessionTmp,
      XDG_CONFIG_HOME: sessionConfig,
      XDG_CACHE_HOME: sessionCache,
      PLAYWRIGHT_BROWSERS_PATH:
        process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? "/opt/pw-browsers",
      CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: "30000",
      GITHUB_PERSONAL_ACCESS_TOKEN: process.env["GITHUB_TOKEN"] ?? "",
      SENTRY_ACCESS_TOKEN: process.env["SENTRY_ACCESS_TOKEN"] ?? "",
    }

    const profile = this.sessionConfig.profile
    if (profile) {
      if (profile.baseUrl) baseEnv["ANTHROPIC_BASE_URL"] = profile.baseUrl
      if (profile.authToken) baseEnv["ANTHROPIC_AUTH_TOKEN"] = profile.authToken
      if (profile.opusModel) baseEnv["ANTHROPIC_DEFAULT_OPUS_MODEL"] = profile.opusModel
      if (profile.sonnetModel) baseEnv["ANTHROPIC_DEFAULT_SONNET_MODEL"] = profile.sonnetModel
      if (profile.haikuModel) baseEnv["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = profile.haikuModel
    }

    // Add passthrough env vars from config
    const passthrough = this.sessionConfig.sessionEnvPassthrough ?? []
    for (const varName of passthrough) {
      const value = process.env[varName]
      if (value !== undefined) {
        baseEnv[varName] = value
      }
    }

    return baseEnv
  }

  private startGoose(task: string, systemPrompt?: string): void {
    const baseEnv = this.buildIsolatedEnv()
    const env: Record<string, string> = {
      ...baseEnv,
      GOOSE_MODE: "auto",
      GOOSE_MAX_TURNS: "200",
      GOOSE_CONTEXT_STRATEGY: "summarize",
      GOOSE_TELEMETRY_ENABLED: "false",
      GOOSE_CLI_SHOW_COST: "false",
      CLAUDE_THINKING_TYPE: "enabled",
      CLAUDE_THINKING_BUDGET: "16000",
    }

    const prompt = systemPrompt ?? DEFAULT_TASK_PROMPT

    this.process = spawn(
      "goose",
      [
        "run",
        "--text", task,
        "--output-format", "stream-json",
        "--name", this.meta.topicName,
        "--provider", this.sessionConfig.goose.provider,
        "--model", this.sessionConfig.goose.model,
        "--system", prompt,
        "--no-profile",
        "--with-builtin", "developer",
        ...this.buildGooseExtensionArgs(),
        "--quiet",
      ],
      {
        cwd: this.meta.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    this.attachProcessHandlers(this.parseGooseLine.bind(this))
  }

  private startClaude(task: string): void {
    const env = this.buildIsolatedEnv()

    this.process = spawn(
      "claude",
      [
        "--print",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--dangerously-skip-permissions",
        "--no-session-persistence",
        "--disallowed-tools", ...PLAN_DISALLOWED_TOOLS,
        ...this.buildClaudeMcpConfigArgs(),
        "--append-system-prompt", DEFAULT_PLAN_PROMPT,
        "--model", this.sessionConfig.claude.planModel,
        task,
      ],
      {
        cwd: this.meta.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    this.attachProcessHandlers(this.parseClaudeLine.bind(this))
  }

  private startClaudeThink(task: string): void {
    const env = this.buildIsolatedEnv()

    this.process = spawn(
      "claude",
      [
        "--print",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--dangerously-skip-permissions",
        "--no-session-persistence",
        "--disallowed-tools", ...THINK_DISALLOWED_TOOLS,
        ...this.buildClaudeMcpConfigArgs(),
        "--append-system-prompt", DEFAULT_THINK_PROMPT,
        "--model", this.sessionConfig.claude.thinkModel,
        task,
      ],
      {
        cwd: this.meta.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    this.attachProcessHandlers(this.parseClaudeLine.bind(this))
  }

  private parseGooseLine(trimmed: string): void {
    try {
      const event = JSON.parse(trimmed) as GooseStreamEvent
      if (event.type === "complete") {
        this.meta.totalTokens = event.total_tokens ?? undefined
      }
      this.onEvent(event)
    } catch {
      process.stderr.write(`session ${this.meta.sessionId}: invalid JSON line: ${trimmed}\n`)
    }
  }

  private parseClaudeLine(trimmed: string): void {
    try {
      const raw = JSON.parse(trimmed)
      const events = translateClaudeEvents(raw)
      for (const event of events) {
        if (event.type === "complete") {
          this.meta.totalTokens = event.total_tokens ?? undefined
        }
        this.onEvent(event)
      }
    } catch {
      process.stderr.write(`session ${this.meta.sessionId}: invalid Claude JSON line: ${trimmed}\n`)
    }
  }

  private attachProcessHandlers(parseLine: (line: string) => void): void {
    const proc = this.process!
    this.state = "working"

    const rl = createInterface({ input: proc.stdout! })

    rl.on("line", (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      parseLine(trimmed)
    })

    proc.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`session ${this.meta.sessionId} stderr: ${chunk.toString()}`)
    })

    proc.on("close", (code) => {
      this.clearTimeout()
      if (code !== 0 && code !== null) {
        captureException(new Error(`Session process exited with code ${code}`), {
          sessionId: this.meta.sessionId,
          repo: this.meta.repo,
          mode: this.meta.mode,
          exitCode: code,
        })
      }
      const finalState: "completed" | "errored" = code === 0 ? "completed" : "errored"
      this.state = finalState
      this.onDone(this.meta, finalState)
    })

    proc.on("error", (err) => {
      process.stderr.write(`session ${this.meta.sessionId}: process error: ${err}\n`)
      captureException(err, {
        sessionId: this.meta.sessionId,
        repo: this.meta.repo,
        mode: this.meta.mode,
      })
      this.clearTimeout()
      this.state = "errored"
      this.onEvent({ type: "error", error: err.message })
      this.onDone(this.meta, "errored")
    })

    this.timeoutHandle = setTimeout(() => {
      process.stderr.write(`session ${this.meta.sessionId}: timeout after ${this.timeoutMs}ms\n`)
      captureException(new Error("Session timed out"), {
        sessionId: this.meta.sessionId,
        repo: this.meta.repo,
        mode: this.meta.mode,
        timeoutMs: this.timeoutMs,
      })
      this.interrupt()
    }, this.timeoutMs)
  }

  interrupt(): void {
    if (this.process && this.state === "working") {
      this.process.kill("SIGINT")
    }
  }

  kill(gracefulMs = 5000): Promise<void> {
    if (!this.process || !this.isActive()) {
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      const proc = this.process!

      const onExit = () => {
        clearTimeout(escalation)
        resolve()
      }

      proc.once("close", onExit)

      proc.kill("SIGINT")

      const escalation = setTimeout(() => {
        if (this.isActive()) {
          process.stderr.write(`session ${this.meta.sessionId}: SIGINT timeout, sending SIGKILL\n`)
          proc.kill("SIGKILL")
        }
      }, gracefulMs)
    })
  }

  private clearTimeout(): void {
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle)
      this.timeoutHandle = null
    }
  }

  getState(): SessionState {
    return this.state
  }

  isActive(): boolean {
    return this.state === "spawning" || this.state === "working"
  }
}
