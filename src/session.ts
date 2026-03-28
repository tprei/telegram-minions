import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import fs from "node:fs"
import path from "node:path"
import type { GooseConfig, ClaudeConfig, McpConfig, ProviderProfile } from "./config-types.js"
import type { GooseStreamEvent, SessionMeta, SessionState } from "./types.js"
import { translateClaudeEvents } from "./claude-stream.js"
import { captureException, setContext, addBreadcrumb } from "./sentry.js"
import { DEFAULT_TASK_PROMPT, DEFAULT_PLAN_PROMPT, DEFAULT_THINK_PROMPT, DEFAULT_REVIEW_PROMPT } from "./prompts.js"
import { createSessionLogger } from "./logger.js"

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
const REVIEW_DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit"]

type McpServerConfig = {
  command: string
  args: string[]
  env?: Record<string, string>
}

type McpHttpServerConfig = {
  type: "http"
  url: string
  headers: Record<string, string>
}

type McpConfigEntry = McpServerConfig | McpHttpServerConfig

export class SessionHandle {
  private process: ChildProcess | null = null
  private state: SessionState = "spawning"
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null
  private inactivityHandle: ReturnType<typeof setTimeout> | null = null
  private log: ReturnType<typeof createSessionLogger>

  constructor(
    readonly meta: SessionMeta,
    private readonly onEvent: SessionEventCallback,
    private readonly onDone: SessionDoneCallback,
    private readonly timeoutMs: number,
    private readonly inactivityTimeoutMs: number,
    private readonly sessionConfig: SessionConfig,
  ) {
    this.log = createSessionLogger(this.meta.topicName, this.meta.threadId, this.meta.sessionId)
  }

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
    } else if (this.meta.mode === "review" && !systemPrompt) {
      this.startClaudeReview(task)
    } else {
      this.startGoose(task, systemPrompt)
    }
  }

  private buildMcpServers(): Record<string, McpConfigEntry> {
    const servers: Record<string, McpConfigEntry> = {}

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
        this.log.warn("MCP: GitHub MCP enabled but GITHUB_TOKEN is not set — skipping")
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
        this.log.warn("MCP: Sentry MCP enabled but SENTRY_ACCESS_TOKEN is not set — skipping")
      }
    }

    if (this.sessionConfig.mcp.supabaseEnabled) {
      const supabaseToken = process.env["SUPABASE_ACCESS_TOKEN"]
      if (supabaseToken) {
        const supabaseArgs = ["-y", "@supabase/mcp-server-supabase@latest", "--access-token", supabaseToken]
        if (this.sessionConfig.mcp.supabaseProjectRef) {
          supabaseArgs.push("--project-ref", this.sessionConfig.mcp.supabaseProjectRef)
        }
        servers.supabase = {
          command: "npx",
          args: supabaseArgs,
        }
      } else {
        this.log.warn("MCP: Supabase MCP enabled but SUPABASE_ACCESS_TOKEN is not set — skipping")
      }
    }

    if (this.sessionConfig.mcp.zaiEnabled && this.sessionConfig.goose.provider === "z-ai") {
      // Prefer profile.authToken for z-ai, fall back to env var
      const zaiKey = this.sessionConfig.profile?.authToken || process.env["ZAI_API_KEY"]
      if (zaiKey) {
        servers["web-search-prime"] = {
          type: "http",
          url: "https://api.z.ai/api/mcp/web_search_prime/mcp",
          headers: {
            Authorization: `Bearer ${zaiKey}`,
          },
        }
      } else {
        this.log.warn("MCP: Z.AI MCP enabled but ZAI_API_KEY is not set — skipping")
      }
    }

    return servers
  }

  private buildGooseExtensionArgs(): string[] {
    const args: string[] = []
    const servers = this.buildMcpServers()

    for (const [, server] of Object.entries(servers)) {
      // Skip HTTP MCPs - Goose doesn't support HTTP transport
      if ("type" in server && server.type === "http") {
        continue
      }
      const stdioServer = server as McpServerConfig
      const envPrefix = stdioServer.env
        ? Object.entries(stdioServer.env).map(([k, v]) => `${k}=${v}`).join(" ") + " "
        : ""
      const cmdWithArgs = envPrefix + [stdioServer.command, ...stdioServer.args].join(" ")
      args.push("--with-extension", cmdWithArgs)
    }

    return args
  }

  private buildClaudeMcpConfigArgs(): string[] {
    const servers = this.buildMcpServers()
    if (Object.keys(servers).length === 0) return []

    const mcpConfig: Record<string, unknown> = {}
    for (const [name, server] of Object.entries(servers)) {
      if ("type" in server && server.type === "http") {
        mcpConfig[name] = {
          type: "http",
          url: server.url,
          headers: server.headers,
        }
      } else {
        const stdioServer = server as McpServerConfig
        mcpConfig[name] = {
          command: stdioServer.command,
          args: stdioServer.args,
          env: stdioServer.env,
        }
      }
    }

    return ["--mcp-config", JSON.stringify({ mcpServers: mcpConfig })]
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
      SUPABASE_ACCESS_TOKEN: process.env["SUPABASE_ACCESS_TOKEN"] ?? "",
      ZAI_API_KEY: process.env["ZAI_API_KEY"] ?? "",
    }

    const profile = this.sessionConfig.profile
    if (profile) {
      if (profile.baseUrl) baseEnv["ANTHROPIC_BASE_URL"] = profile.baseUrl
      if (profile.authToken) {
        // Use authToken for the appropriate provider
        if (this.sessionConfig.goose.provider === "z-ai") {
          baseEnv["ZAI_API_KEY"] = profile.authToken
        } else {
          baseEnv["ANTHROPIC_AUTH_TOKEN"] = profile.authToken
        }
      }
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
        detached: true,
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
        detached: true,
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
        detached: true,
      },
    )

    this.attachProcessHandlers(this.parseClaudeLine.bind(this))
  }

  private startClaudeReview(task: string): void {
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
        "--disallowed-tools", ...REVIEW_DISALLOWED_TOOLS,
        ...this.buildClaudeMcpConfigArgs(),
        "--append-system-prompt", DEFAULT_REVIEW_PROMPT,
        "--model", this.sessionConfig.claude.reviewModel,
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
      this.log.warn({ line: trimmed.slice(0, 200) }, "invalid JSON line")
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
      this.log.warn({ line: trimmed.slice(0, 200) }, "invalid Claude JSON line")
    }
  }

  private attachProcessHandlers(parseLine: (line: string) => void): void {
    const proc = this.process!
    this.state = "working"

    const rl = createInterface({ input: proc.stdout! })

    const resetInactivityTimer = () => {
      if (this.inactivityHandle !== null) clearTimeout(this.inactivityHandle)
      this.inactivityHandle = setTimeout(() => {
        this.log.warn({ inactivityTimeoutMs: this.inactivityTimeoutMs }, "inactivity timeout — no stdout, killing")
        captureException(new Error("Session inactivity timeout"), {
          sessionId: this.meta.sessionId,
          repo: this.meta.repo,
          mode: this.meta.mode,
          inactivityTimeoutMs: this.inactivityTimeoutMs,
        })
        this.interrupt()
      }, this.inactivityTimeoutMs)
    }
    resetInactivityTimer()

    rl.on("line", (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      resetInactivityTimer()
      parseLine(trimmed)
    })

    proc.stderr?.on("data", (chunk: Buffer) => {
      resetInactivityTimer()
      this.log.debug({ stderr: chunk.toString() }, "process stderr")
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
      this.log.error({ err }, "process error")
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
      this.log.warn({ timeoutMs: this.timeoutMs }, "session timeout")
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
      this.killProcessGroup(this.process, "SIGINT")
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

      this.killProcessGroup(proc, "SIGINT")

      const escalation = setTimeout(() => {
        if (this.isActive()) {
          this.log.warn("SIGINT timeout, sending SIGKILL")
          this.killProcessGroup(proc, "SIGKILL")
        }
      }, gracefulMs)
    })
  }

  private killProcessGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
    if (proc.pid) {
      try {
        process.kill(-proc.pid, signal)
        return
      } catch {
        // process group may already be gone; fall back to direct kill
      }
    }
    try {
      proc.kill(signal)
    } catch {
      // process already dead
    }
  }

  private clearTimeout(): void {
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle)
      this.timeoutHandle = null
    }
    if (this.inactivityHandle !== null) {
      clearTimeout(this.inactivityHandle)
      this.inactivityHandle = null
    }
  }

  getState(): SessionState {
    return this.state
  }

  isActive(): boolean {
    return this.state === "spawning" || this.state === "working"
  }
}
