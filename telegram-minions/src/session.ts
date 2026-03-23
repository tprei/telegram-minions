import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import fs from "node:fs"
import path from "node:path"
import { config } from "./config.js"
import type { GooseStreamEvent, SessionMeta, SessionState } from "./types.js"
import { translateClaudeEvents } from "./claude-stream.js"
import { captureException, setContext, addBreadcrumb } from "./sentry.js"

export const SCREENSHOTS_DIR = ".screenshots"

export type SessionEventCallback = (event: GooseStreamEvent) => void
export type SessionDoneCallback = (meta: SessionMeta, state: "completed" | "errored") => void

export const TASK_SYSTEM_PROMPT = [
  "You are a coding minion running in a sandboxed environment.",
  "Your working directory is a fresh clone — local changes do not persist after this session ends.",
  "",
  "To deliver your work, you MUST:",
  "1. Create a new branch from the current HEAD",
  "2. Commit your changes to that branch",
  "3. Push the branch and open a pull request using `gh pr create`",
  "If you skip the PR, your work is lost.",
  "",
  "The `gh` CLI is available and authenticated via GITHUB_TOKEN.",
  "Use conventional commit messages: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.",
  "Keep commits focused — one logical change per commit.",
  "Stage specific files, not `git add .`.",
  "Never commit `.env`, credentials, or secrets.",
  "Never push to `main` or `master` directly.",
  "PR descriptions should explain what changed and why, not how.",
  "When your coding work is complete, use the `post-task-router` agent to classify the next action and delegate appropriately.",
  "If no tests exist for the area you're modifying, note this in the PR description.",
  "Document assumptions in your PR description since there's no human to ask.",
  "",
  "A headless Chromium browser is pre-installed. Use the Playwright MCP tools (browser_navigate, browser_snapshot, browser_screenshot, browser_click, etc.) for any web browsing tasks. Do NOT attempt to install a browser — it is already available.",
  "When browsing pages, wait for the page to fully load before taking snapshots or screenshots. Use browser_wait_for_navigation or browser_wait after navigating, clicking links, or submitting forms. Pages with JavaScript-heavy content (SPAs, dynamic dashboards) need extra time to render — wait for network requests to settle before capturing.",
].join("\n")

export const CI_FIX_SYSTEM_PROMPT = [
  "You are a CI-fix minion running in a sandboxed environment.",
  "A previous task session opened a pull request, but CI checks failed.",
  "Your ONLY job is to fix the CI failures described below and push the fixes.",
  "",
  "Follow the `ci-fix` agent guidelines: reproduce failures locally, fix root causes, verify fixes, then use `post-task-router` to commit and push.",
  "",
  "The `gh` CLI is available and authenticated via GITHUB_TOKEN.",
  "Never commit `.env`, credentials, or secrets.",
  "Never push to `main` or `master` directly.",
  "",
  "A headless Chromium browser is pre-installed. Use the Playwright MCP tools (browser_navigate, browser_snapshot, browser_screenshot, browser_click, etc.) for any web browsing tasks. Do NOT attempt to install a browser — it is already available.",
  "When browsing pages, wait for the page to fully load before taking snapshots or screenshots. Use browser_wait_for_navigation or browser_wait after navigating, clicking links, or submitting forms. Pages with JavaScript-heavy content (SPAs, dynamic dashboards) need extra time to render — wait for network requests to settle before capturing.",
].join("\n")

export const PLAN_SYSTEM_PROMPT = [
  "You are a planning minion running in a sandboxed environment.",
  "Your job is to explore the codebase, understand the architecture, and produce a detailed implementation plan.",
  "",
  "This is a READ-ONLY exploration phase. The Edit, Write, and NotebookEdit tools have been disabled.",
  "Do NOT use Bash to modify, create, or delete files. Use Bash only for read-only commands (git log, rg, find, ls, cat, etc.).",
  "Do NOT create branches, commits, or pull requests.",
  "",
  "Your workflow:",
  "1. Read and explore the relevant code to understand the architecture",
  "2. Identify files, functions, and dependencies that need changes",
  "3. Produce a detailed, step-by-step implementation plan",
  "4. Flag risks, edge cases, and open questions",
  "",
  "Present your plan in a clear, structured format with file paths and specific changes.",
  "When the user gives feedback, refine the plan accordingly.",
  "",
  "A headless Chromium browser is pre-installed. Use the Playwright MCP tools (browser_navigate, browser_snapshot, browser_screenshot, browser_click, etc.) for any web browsing tasks. Do NOT attempt to install a browser — it is already available.",
  "When browsing pages, wait for the page to fully load before taking snapshots or screenshots. Use browser_wait_for_navigation or browser_wait after navigating, clicking links, or submitting forms. Pages with JavaScript-heavy content (SPAs, dynamic dashboards) need extra time to render — wait for network requests to settle before capturing.",
].join("\n")

const PLAN_DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit"]

export const THINK_SYSTEM_PROMPT = [
  "You are a deep-research minion running in a sandboxed environment.",
  "Your job is to THINK deeply, search broadly, and understand thoroughly. You make NO changes whatsoever.",
  "",
  "This is a READ-ONLY research phase. The Edit, Write, and NotebookEdit tools have been disabled.",
  "Do NOT use Bash to modify, create, or delete files. Do NOT create branches, commits, or pull requests.",
  "",
  "## Web search specialist",
  "",
  "You have access to WebSearch and WebFetch tools. Use them aggressively:",
  "- Search the web for documentation, blog posts, GitHub issues, Stack Overflow threads, RFCs, and any relevant sources",
  "- Fetch and read full pages when search results look promising",
  "- Cross-reference multiple sources to validate findings",
  "- Search for known issues, CVEs, deprecation notices, and migration guides when relevant",
  "- Look up library changelogs, API documentation, and community discussions",
  "",
  "## Research workflow",
  "",
  "1. Deeply explore the codebase to build a thorough understanding of the architecture",
  "2. Search the web extensively for relevant context, documentation, and prior art",
  "3. Cross-reference codebase findings with external knowledge",
  "4. Synthesize everything into a clear, comprehensive analysis",
  "",
  "## Output expectations",
  "",
  "- Think step by step. Use extended thinking to reason through complex problems.",
  "- Be thorough — explore every relevant angle before drawing conclusions",
  "- Cite sources when referencing external information",
  "- Surface non-obvious insights, risks, and connections",
  "- Present findings in a structured, readable format",
  "- When the user gives follow-up questions, dig deeper",
  "",
  "A headless Chromium browser is pre-installed. Use the Playwright MCP tools (browser_navigate, browser_snapshot, browser_screenshot, browser_click, etc.) for any web browsing tasks. Do NOT attempt to install a browser — it is already available.",
  "When browsing pages, wait for the page to fully load before taking snapshots or screenshots. Use browser_wait_for_navigation or browser_wait after navigating, clicking links, or submitting forms. Pages with JavaScript-heavy content (SPAs, dynamic dashboards) need extra time to render — wait for network requests to settle before capturing.",
].join("\n")

const THINK_DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit"]

export class SessionHandle {
  private process: ChildProcess | null = null
  private state: SessionState = "spawning"
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly meta: SessionMeta,
    private readonly onEvent: SessionEventCallback,
    private readonly onDone: SessionDoneCallback,
    private readonly timeoutMs: number,
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

    fs.mkdirSync(path.join(sessionHome, ".claude"), { recursive: true })
    fs.mkdirSync(sessionTmp, { recursive: true })
    fs.mkdirSync(sessionConfig, { recursive: true })
    fs.mkdirSync(sessionCache, { recursive: true })
    fs.mkdirSync(sessionDataDir, { recursive: true })
    fs.mkdirSync(sessionStateDir, { recursive: true })

    const settingsSrc = path.join(parentClaudeDir, "settings.json")
    const settingsDst = path.join(sessionHome, ".claude", "settings.json")
    if (fs.existsSync(settingsSrc) && !fs.existsSync(settingsDst)) {
      fs.copyFileSync(settingsSrc, settingsDst)
    }

    return {
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
    }
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

    const prompt = systemPrompt ?? TASK_SYSTEM_PROMPT

    this.process = spawn(
      "goose",
      [
        "run",
        "--text", task,
        "--output-format", "stream-json",
        "--name", this.meta.topicName,
        "--provider", config.goose.provider,
        "--model", config.goose.model,
        "--system", prompt,
        "--no-profile",
        "--with-builtin", "developer",
        ...(config.mcp.browserEnabled ? [
          "--with-extension", `playwright-mcp --browser chromium --headless --no-sandbox --isolated --caps vision --output-dir ${path.join(this.meta.cwd, SCREENSHOTS_DIR)}`,
        ] : []),
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
        ...(config.mcp.browserEnabled ? [
          "--mcp-config", JSON.stringify({
            mcpServers: {
              playwright: {
                command: "playwright-mcp",
                args: ["--browser", "chromium", "--headless", "--no-sandbox", "--isolated", "--caps", "vision", "--output-dir", path.join(this.meta.cwd, SCREENSHOTS_DIR)],
              },
            },
          }),
        ] : []),
        "--append-system-prompt", PLAN_SYSTEM_PROMPT,
        "--model", config.claude.planModel,
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
        ...(config.mcp.browserEnabled ? [
          "--mcp-config", JSON.stringify({
            mcpServers: {
              playwright: {
                command: "playwright-mcp",
                args: ["--browser", "chromium", "--headless", "--no-sandbox", "--isolated", "--caps", "vision", "--output-dir", path.join(this.meta.cwd, SCREENSHOTS_DIR)],
              },
            },
          }),
        ] : []),
        "--append-system-prompt", THINK_SYSTEM_PROMPT,
        "--model", config.claude.thinkModel,
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
