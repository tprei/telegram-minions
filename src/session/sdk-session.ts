import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import fs from "node:fs"
import path from "node:path"
import type { GooseStreamEvent } from "../domain/goose-types.js"
import type { SessionMeta, SessionState, SessionPort, SessionDoneState } from "../domain/session-types.js"
import { translateClaudeEvents } from "./claude-stream.js"
import { captureException, setContext, addBreadcrumb } from "../sentry.js"
import { isQuotaError, parseResetTime } from "./quota-detection.js"
import { DEFAULT_TASK_PROMPT, DEFAULT_PLAN_PROMPT, DEFAULT_THINK_PROMPT, DEFAULT_REVIEW_PROMPT, DEFAULT_DAG_REVIEW_PROMPT, DEFAULT_SHIP_PLAN_PROMPT, DEFAULT_SHIP_VERIFY_PROMPT } from "../config/prompts.js"
import { createSessionLogger } from "../logger.js"
import { injectAgentFiles } from "./inject-assets.js"
import { CappedStderrBuffer } from "./capped-stderr-buffer.js"
import { type SessionConfig, SCREENSHOTS_DIR } from "./session.js"

export type SDKSessionEventCallback = (event: GooseStreamEvent) => void
export type SDKSessionDoneCallback = (meta: SessionMeta, state: SessionDoneState) => void

const READONLY_DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit"]

interface SpawnOpts {
  task: string
  systemPrompt: string
  model: string
  disallowedTools?: string[]
}

type McpServerConfig = {
  type?: never
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

/**
 * SDK-based session that uses `claude --input-format stream-json` to enable
 * mid-execution reply injection. User replies are written as NDJSON to stdin
 * and processed by Claude before the next tool call.
 */
export class SDKSessionHandle implements SessionPort {
  private process: ChildProcess | null = null
  private state: SessionState = "spawning"
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null
  private inactivityHandle: ReturnType<typeof setTimeout> | null = null
  private completionResolve: ((result: SessionDoneState) => void) | null = null
  private completionPromise: Promise<SessionDoneState>
  private stderrBuffer = new CappedStderrBuffer()
  private log: ReturnType<typeof createSessionLogger>
  private lastStdoutAt: number = 0
  private stdoutLineCount: number = 0
  private startedAt: number = 0

  constructor(
    readonly meta: SessionMeta,
    private readonly onEvent: SDKSessionEventCallback,
    private readonly onDone: SDKSessionDoneCallback,
    private readonly timeoutMs: number,
    private readonly inactivityTimeoutMs: number,
    private readonly sessionConfig: SessionConfig,
  ) {
    this.log = createSessionLogger(this.meta.topicName, this.meta.threadId, this.meta.sessionId)
    this.completionPromise = new Promise((resolve) => {
      this.completionResolve = resolve
    })
  }

  private static readonly claudeModeConfigs: Record<string, (cfg: SessionConfig) => Omit<SpawnOpts, "task">> = {
    plan: (cfg) => ({
      systemPrompt: DEFAULT_PLAN_PROMPT,
      model: cfg.claude.planModel,
      disallowedTools: READONLY_DISALLOWED_TOOLS,
    }),
    think: (cfg) => ({
      systemPrompt: DEFAULT_THINK_PROMPT,
      model: cfg.claude.thinkModel,
      disallowedTools: READONLY_DISALLOWED_TOOLS,
    }),
    "ship-think": (cfg) => ({
      systemPrompt: DEFAULT_THINK_PROMPT,
      model: cfg.claude.thinkModel,
      disallowedTools: READONLY_DISALLOWED_TOOLS,
    }),
    review: (cfg) => ({
      systemPrompt: DEFAULT_REVIEW_PROMPT,
      model: cfg.claude.reviewModel,
      disallowedTools: READONLY_DISALLOWED_TOOLS,
    }),
    "dag-review": (cfg) => ({
      systemPrompt: DEFAULT_DAG_REVIEW_PROMPT,
      model: cfg.claude.reviewModel,
      disallowedTools: READONLY_DISALLOWED_TOOLS,
    }),
    "ship-plan": (cfg) => ({
      systemPrompt: DEFAULT_SHIP_PLAN_PROMPT,
      model: cfg.claude.planModel,
      disallowedTools: READONLY_DISALLOWED_TOOLS,
    }),
    "ship-verify": (cfg) => ({
      systemPrompt: DEFAULT_SHIP_VERIFY_PROMPT,
      model: cfg.claude.reviewModel,
    }),
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
      message: `Starting SDK ${this.meta.mode} session: ${this.meta.topicName}`,
      level: "info",
      data: { repo: this.meta.repo, sessionId: this.meta.sessionId },
    })

    const modeConfig = !systemPrompt ? SDKSessionHandle.claudeModeConfigs[this.meta.mode] : undefined
    if (modeConfig) {
      this.spawnClaude({ task, ...modeConfig(this.sessionConfig) })
    } else {
      this.spawnClaude({
        task,
        systemPrompt: systemPrompt ?? DEFAULT_TASK_PROMPT,
        model: this.sessionConfig.claude.thinkModel,
      })
    }
  }

  /**
   * Inject a user reply into the running session. The message is written as
   * NDJSON to Claude's stdin and processed before the next tool call.
   */
  injectReply(text: string, images?: string[]): boolean {
    if (!this.process?.stdin?.writable) {
      this.log.warn("cannot inject reply: stdin not writable")
      return false
    }

    let content: string | Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>
    if (images && images.length > 0) {
      const blocks: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> = []
      for (const imgPath of images) {
        try {
          const data = fs.readFileSync(imgPath).toString("base64")
          const ext = path.extname(imgPath).toLowerCase()
          const mediaType = ext === ".png" ? "image/png"
            : ext === ".gif" ? "image/gif"
            : ext === ".webp" ? "image/webp"
            : "image/jpeg"
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: mediaType, data },
          })
        } catch (err) {
          this.log.warn({ err, imgPath }, "failed to read image for reply injection")
        }
      }
      blocks.push({ type: "text", text })
      content = blocks
    } else {
      content = text
    }

    const message = JSON.stringify({
      type: "user",
      session_id: "",
      message: { role: "user", content },
      parent_tool_use_id: null,
    })

    this.process.stdin.write(message + "\n", (err) => {
      if (err) {
        this.log.warn({ err }, "failed to write reply to stdin")
      } else {
        this.log.info({ textLength: text.length, imageCount: images?.length ?? 0 }, "injected reply via stdin")
      }
    })
    return true
  }

  waitForCompletion(): Promise<SessionDoneState> {
    return this.completionPromise
  }

  isClosed(): boolean {
    return this.state === "completed" || this.state === "errored"
  }

  getState(): SessionState {
    return this.state
  }

  isActive(): boolean {
    return this.state === "spawning" || this.state === "working"
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

    if (this.sessionConfig.mcp.flyEnabled) {
      const flyToken = process.env["FLY_API_TOKEN"]
      if (flyToken) {
        const flyArgs = ["mcp", "server"]
        if (this.sessionConfig.mcp.flyOrg) {
          flyArgs.push("--org", this.sessionConfig.mcp.flyOrg)
        }
        servers.fly = {
          command: "fly",
          args: flyArgs,
          env: { FLY_API_TOKEN: flyToken },
        }
      } else {
        this.log.warn("MCP: Fly MCP enabled but FLY_API_TOKEN is not set — skipping")
      }
    }

    if (this.sessionConfig.mcp.zaiEnabled && this.sessionConfig.goose.provider === "z-ai") {
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
        mcpConfig[name] = {
          command: server.command,
          args: server.args,
          env: server.env,
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
      PATH: [
        "/opt/uv-tools/bin",
        process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
      ].join(":"),
      HOME: sessionHome,
      CLAUDE_CONFIG_DIR: parentClaudeDir,
      LANG: process.env["LANG"] ?? "C.UTF-8",
      TERM: process.env["TERM"] ?? "xterm",
      NODE_PATH: process.env["NODE_PATH"] ?? "",
      GITHUB_TOKEN: process.env["GITHUB_TOKEN"] ?? "",
      GITHUB_TOKEN_FILE: process.env["GITHUB_TOKEN_FILE"] ?? "",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: process.env["GIT_ASKPASS"] ?? "",
      GIT_CONFIG_GLOBAL: path.join(parentHome, ".gitconfig"),
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
      UV_CACHE_DIR: path.join(sessionHome, ".cache", "uv"),
      UV_PYTHON_PREFERENCE: "only-managed",
      UV_LINK_MODE: "copy",
    }

    const profile = this.sessionConfig.profile
    if (profile) {
      if (profile.baseUrl) baseEnv["ANTHROPIC_BASE_URL"] = profile.baseUrl
      if (profile.authToken) {
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

    try {
      injectAgentFiles(this.meta.cwd, this.sessionConfig.agentDefs)
    } catch (err) {
      this.log.warn({ err }, "failed to inject agent files (non-fatal)")
    }

    const passthrough = this.sessionConfig.sessionEnvPassthrough ?? []
    for (const varName of passthrough) {
      const value = process.env[varName]
      if (value !== undefined) {
        baseEnv[varName] = value
      }
    }

    return baseEnv
  }

  private spawnClaude(opts: SpawnOpts): void {
    const env = this.buildIsolatedEnv()

    const args = [
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
      ...(opts.disallowedTools ? ["--disallowed-tools", ...opts.disallowedTools] : []),
      ...this.buildClaudeMcpConfigArgs(),
      "--append-system-prompt", opts.systemPrompt,
      "--model", opts.model,
    ]

    this.process = spawn("claude", args, {
      cwd: this.meta.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    })

    // Write the initial task as the first user message to stdin
    const initialMessage = JSON.stringify({
      type: "user",
      session_id: "",
      message: { role: "user", content: opts.task },
      parent_tool_use_id: null,
    })
    this.process.stdin!.write(initialMessage + "\n")

    this.attachProcessHandlers()
  }

  private parseClaudeLine(trimmed: string): void {
    try {
      const raw = JSON.parse(trimmed)
      const events = translateClaudeEvents(raw)
      for (const event of events) {
        if (event.type === "complete") {
          this.meta.totalTokens = event.total_tokens ?? undefined
          this.meta.totalCostUsd = event.total_cost_usd ?? undefined
          this.meta.numTurns = event.num_turns ?? undefined
        }
        this.onEvent(event)
      }
    } catch {
      this.log.warn({ line: trimmed.slice(0, 200) }, "invalid Claude JSON line")
    }
  }

  private attachProcessHandlers(): void {
    const proc = this.process!
    this.state = "working"
    this.startedAt = Date.now()
    this.lastStdoutAt = this.startedAt

    const rl = createInterface({ input: proc.stdout! })

    const resetInactivityTimer = () => {
      if (this.inactivityHandle !== null) clearTimeout(this.inactivityHandle)
      this.inactivityHandle = setTimeout(() => {
        const now = Date.now()
        const sinceLastStdout = now - this.lastStdoutAt
        const sinceStart = now - this.startedAt
        this.log.warn(
          {
            inactivityTimeoutMs: this.inactivityTimeoutMs,
            slug: this.meta.topicName,
            cwd: this.meta.cwd,
            mode: this.meta.mode,
            stdoutLineCount: this.stdoutLineCount,
            msSinceLastStdout: sinceLastStdout,
            msSinceStart: sinceStart,
            stderrTail: this.stderrBuffer.toString().slice(-1500),
          },
          "inactivity timeout — no stdout, killing",
        )
        captureException(new Error("SDK session inactivity timeout"), {
          sessionId: this.meta.sessionId,
          repo: this.meta.repo,
          mode: this.meta.mode,
          inactivityTimeoutMs: this.inactivityTimeoutMs,
          stdoutLineCount: this.stdoutLineCount,
          msSinceLastStdout: sinceLastStdout,
        })
        this.interrupt()
      }, this.inactivityTimeoutMs)
    }
    resetInactivityTimer()

    rl.on("line", (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      this.lastStdoutAt = Date.now()
      this.stdoutLineCount++
      resetInactivityTimer()
      this.parseClaudeLine(trimmed)
    })

    proc.stderr?.on("data", (chunk: Buffer) => {
      resetInactivityTimer()
      const text = chunk.toString()
      this.stderrBuffer.push(text)
      this.log.debug({ stderr: text }, "process stderr")
    })

    proc.on("close", (code, signal) => {
      this.clearTimers()
      const stderrText = this.stderrBuffer.toString()

      if (code !== 0 && code !== null) {
        if (isQuotaError(stderrText)) {
          const sleepMs = parseResetTime(stderrText)
          this.log.warn({ sleepMs }, "quota exhausted detected in SDK session")
          this.state = "errored"
          this.onEvent({ type: "quota_exhausted", resetAt: sleepMs, rawMessage: stderrText.slice(0, 500) })
          this.completionResolve?.("quota_exhausted")
          this.onDone(this.meta, "quota_exhausted")
          return
        }

        this.log.error(
          { exitCode: code, signal, stderrTail: stderrText.slice(-2000), stderrBytes: this.stderrBuffer.byteLength },
          "SDK session process exited non-zero",
        )
        captureException(new Error(`SDK session process exited with code ${code}`), {
          sessionId: this.meta.sessionId,
          repo: this.meta.repo,
          mode: this.meta.mode,
          exitCode: code,
          stderrTail: stderrText.slice(-2000),
        })
      }
      const finalState: SessionDoneState = code === 0 ? "completed" : "errored"
      this.state = finalState
      this.completionResolve?.(finalState)
      this.onDone(this.meta, finalState)
    })

    proc.on("error", (err) => {
      this.log.error({ err }, "process error")
      captureException(err, {
        sessionId: this.meta.sessionId,
        repo: this.meta.repo,
        mode: this.meta.mode,
      })
      this.clearTimers()
      this.state = "errored"
      this.onEvent({ type: "error", error: err.message })
      this.completionResolve?.("errored")
      this.onDone(this.meta, "errored")
    })

    this.timeoutHandle = setTimeout(() => {
      this.log.warn(
        {
          timeoutMs: this.timeoutMs,
          slug: this.meta.topicName,
          cwd: this.meta.cwd,
          mode: this.meta.mode,
          stdoutLineCount: this.stdoutLineCount,
          msSinceLastStdout: Date.now() - this.lastStdoutAt,
        },
        "session timeout",
      )
      captureException(new Error("SDK session timed out"), {
        sessionId: this.meta.sessionId,
        repo: this.meta.repo,
        mode: this.meta.mode,
        timeoutMs: this.timeoutMs,
        stdoutLineCount: this.stdoutLineCount,
      })
      this.interrupt()
    }, this.timeoutMs)
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

  private clearTimers(): void {
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle)
      this.timeoutHandle = null
    }
    if (this.inactivityHandle !== null) {
      clearTimeout(this.inactivityHandle)
      this.inactivityHandle = null
    }
  }
}
