import { spawn, execFileSync } from "node:child_process"
import { loggers } from "./logger.js"

const log = loggers.conflictResolver

const CONFLICT_TIMEOUT_MS = 120_000

export function buildConflictResolutionPrompt(
  branch: string,
  targetBranch: string,
  conflictFiles: string[],
): string {
  return [
    `You are resolving merge conflicts during a rebase of branch \`${branch}\` onto \`${targetBranch}\`.`,
    "",
    "The following files have conflicts:",
    ...conflictFiles.map((f) => `- ${f}`),
    "",
    "Your task:",
    "1. Read each conflicted file to understand the conflict markers (<<<<<<< / ======= / >>>>>>>)",
    "2. Resolve each conflict by choosing the correct combination of changes",
    "3. Stage each resolved file with `git add <file>`",
    "",
    `Prefer incoming changes (from ${branch}) for new features. Prefer target changes (from ${targetBranch}) for infrastructure/structural code.`,
    "",
    "Do NOT run `git rebase --continue` — that will be handled externally.",
    "Do NOT create new files or make unrelated changes.",
  ].join("\n")
}

export async function resolveConflictsWithAgent(
  cwd: string,
  branch: string,
  targetBranch: string,
): Promise<boolean> {
  let conflictFiles: string[]
  try {
    const raw = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], { cwd, encoding: "utf-8" }).trim()
    conflictFiles = raw.split("\n").filter(Boolean)
  } catch {
    return false
  }

  if (conflictFiles.length === 0) return false

  const prompt = buildConflictResolutionPrompt(branch, targetBranch, conflictFiles)
  log.info({ branch, targetBranch, conflictFiles }, "spawning conflict resolution agent")

  const proc = spawn("claude", [
    "--print",
    "--output-format", "stream-json",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--model", "sonnet",
    "--max-turns", "10",
    prompt,
  ], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  })

  let stderr = ""
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL")
      resolve(null)
    }, CONFLICT_TIMEOUT_MS)

    proc.on("close", (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })

  if (exitCode !== 0) {
    log.warn({ exitCode, stderr: stderr.slice(0, 500) }, "conflict resolver exited with error")
  }

  try {
    const remaining = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], { cwd, encoding: "utf-8" }).trim()
    const resolved = remaining.length === 0
    log.info({ resolved, remaining: remaining || "(none)" }, "conflict resolution result")
    return resolved
  } catch {
    return false
  }
}
