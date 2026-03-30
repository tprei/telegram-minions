import { spawn } from "node:child_process"
import type { TopicMessage } from "./types.js"
import type { ProviderProfile } from "./config/config-types.js"
import type { Logger } from "pino"

const MAX_ASSISTANT_CHARS = 4000

export interface ExtractionOptions {
  timeoutMs?: number
  profile?: ProviderProfile
  envOverrides?: Record<string, string>
  log: Logger
}

/**
 * Spawn the claude CLI with the given task and system prompt, returning stdout.
 */
export function runClaudeExtraction(
  task: string,
  systemPrompt: string,
  options: ExtractionOptions,
): Promise<string> {
  const { timeoutMs = 120_000, profile, envOverrides, log } = options

  return new Promise((resolve, reject) => {
    const args = [
      "--print",
      "--output-format", "text",
      "--model", "haiku",
      "--no-session-persistence",
      "--append-system-prompt", systemPrompt,
    ]

    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(profile?.baseUrl && { ANTHROPIC_BASE_URL: profile.baseUrl }),
        ...(profile?.authToken && { ANTHROPIC_AUTH_TOKEN: profile.authToken }),
        ...(profile?.haikuModel && { ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.haikuModel }),
        ...envOverrides,
      },
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString()
    })

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString()
    })

    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.on("error", (err) => {
      clearTimeout(timeout)
      reject(err)
    })

    child.on("close", (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve(stdout.trim())
      } else {
        const err = new Error(`claude CLI exited with code ${code}: ${stderr.trim()}`)
        ;(err as NodeJS.ErrnoException).code = code?.toString()
        reject(err)
      }
    })

    child.stdin.write(task)
    child.stdin.end()

    log.debug("spawned claude CLI")
  })
}

const MAX_RETRIES = 3
const INITIAL_DELAY_MS = 2000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableSpawnError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return (
    code === "ETIMEDOUT" ||
    code === "ENOENT" ||
    code === "EAGAIN" ||
    (err instanceof Error && err.message.includes("spawn"))
  )
}

export interface RetryResult<T> {
  data?: T
  error?: "system" | "parse"
  errorMessage?: string
}

/**
 * Run a claude extraction with retries on transient spawn errors.
 * The parser receives raw CLI output and returns parsed data or throws.
 */
export async function retryClaudeExtraction<T>(
  task: string,
  systemPrompt: string,
  parser: (output: string) => T,
  options: ExtractionOptions,
): Promise<RetryResult<T>> {
  const { log } = options
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log.debug({ attempt, maxRetries: MAX_RETRIES }, "attempt")
      const output = await runClaudeExtraction(task, systemPrompt, options)
      log.debug({ outputLength: output.length }, "raw output")

      const data = parser(output)
      return { data }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      if (isRetryableSpawnError(err) && attempt < MAX_RETRIES) {
        const delay = INITIAL_DELAY_MS * Math.pow(2, attempt - 1)
        log.warn({ attempt, delay, err }, "spawn error, retrying")
        await sleep(delay)
      } else {
        log.error({ err }, "extraction failed")
        return { error: "system", errorMessage: lastError.message }
      }
    }
  }

  return { error: "system", errorMessage: lastError?.message ?? "Unknown error" }
}

/**
 * Build a text representation of a conversation for extraction prompts.
 */
export function buildConversationText(conversation: TopicMessage[], directive?: string): string {
  const lines: string[] = ["## Conversation\n"]

  for (const msg of conversation) {
    const label = msg.role === "user" ? "**User**" : "**Agent**"
    lines.push(`${label}:`)
    if (msg.role === "assistant" && msg.text.length > MAX_ASSISTANT_CHARS) {
      lines.push(`[earlier output truncated]\n…${msg.text.slice(-MAX_ASSISTANT_CHARS)}`)
    } else {
      lines.push(msg.text)
    }
    lines.push("")
  }

  if (directive) {
    lines.push(`## Directive\n\n${directive}`)
  }

  return lines.join("\n")
}
