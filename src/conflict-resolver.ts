import { spawn, execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"
import { readFileSync } from "node:fs"
import path from "node:path"
import { loggers } from "./logger.js"

const log = loggers.conflictResolver
const execFile = promisify(execFileCb)

const CONFLICT_TIMEOUT_MS = 120_000
const MAX_FILE_PREVIEW_BYTES = 8_000

interface UnmergedStages {
  base?: string
  ours?: string
  theirs?: string
}

export function parseUnmergedEntries(raw: string): Map<string, UnmergedStages> {
  const byPath = new Map<string, UnmergedStages>()
  for (const line of raw.split("\n").filter(Boolean)) {
    const match = line.match(/^\d+ ([a-f0-9]+) (\d)\t(.+)$/)
    if (!match) continue
    const [, blob, stageStr, filePath] = match
    const stage = parseInt(stageStr, 10)
    const entry = byPath.get(filePath) ?? {}
    if (stage === 1) entry.base = blob
    else if (stage === 2) entry.ours = blob
    else if (stage === 3) entry.theirs = blob
    byPath.set(filePath, entry)
  }
  return byPath
}

export async function resolvePhantomConflicts(
  cwd: string,
): Promise<{ resolved: string[]; remaining: string[] }> {
  const { stdout: raw } = await execFile("git", ["ls-files", "--unmerged"], {
    cwd,
    encoding: "utf-8",
  })
  const byPath = parseUnmergedEntries(raw)
  if (byPath.size === 0) return { resolved: [], remaining: [] }

  const resolved: string[] = []
  const remaining: string[] = []

  for (const [filePath, stages] of byPath) {
    let isPhantom = false

    if (stages.base && stages.theirs && !stages.ours) {
      try {
        const { stdout } = await execFile(
          "git",
          ["rev-parse", "--verify", `HEAD:${filePath}`],
          { cwd, encoding: "utf-8" },
        )
        if (stdout.trim() === stages.base) isPhantom = true
      } catch {
        // file genuinely absent from HEAD
      }
    } else if (stages.base && stages.ours && stages.theirs && stages.base === stages.ours) {
      isPhantom = true
    }

    if (isPhantom) {
      if (stages.ours) {
        await execFile("git", ["checkout", "--theirs", "--", filePath], { cwd })
      }
      await execFile("git", ["add", "--", filePath], { cwd })
      resolved.push(filePath)
    } else {
      remaining.push(filePath)
    }
  }

  log.info(
    { resolved, remaining: remaining.length > 0 ? remaining : "(none)" },
    "phantom conflict resolution result",
  )
  return { resolved, remaining }
}

function readFilePreview(cwd: string, file: string): string | null {
  try {
    const content = readFileSync(path.join(cwd, file), "utf-8")
    if (content.length > MAX_FILE_PREVIEW_BYTES) {
      return content.slice(0, MAX_FILE_PREVIEW_BYTES) + "\n... (truncated)"
    }
    return content
  } catch {
    return null
  }
}

export function buildConflictResolutionPrompt(
  branch: string,
  targetBranch: string,
  conflictFiles: string[],
  fileContents?: Map<string, string>,
): string {
  const lines = [
    `You are resolving merge conflicts during a rebase of branch \`${branch}\` onto \`${targetBranch}\`.`,
    "",
    `${conflictFiles.length} file(s) have conflicts:`,
    ...conflictFiles.map((f) => `- ${f}`),
    "",
  ]

  if (fileContents && fileContents.size > 0) {
    lines.push("## Current file contents (with conflict markers)")
    lines.push("")
    for (const [file, content] of fileContents) {
      lines.push(`### ${file}`)
      lines.push("```")
      lines.push(content)
      lines.push("```")
      lines.push("")
    }
  }

  lines.push(
    "## Resolution steps",
    "",
    "1. Read each conflicted file (if not shown above) to understand the conflict markers (<<<<<<< / ======= / >>>>>>>)",
    "2. Resolve each conflict by choosing the correct combination of changes",
    "3. For import path conflicts: check which module actually exists and use that path",
    "4. Stage each resolved file with `git add <file>`",
    "5. Run `npx tsc --noEmit` to verify the resolution compiles — if it fails, fix the type errors and re-stage",
    "",
    `Prefer incoming changes (from ${branch}) for new features. Prefer target changes (from ${targetBranch}) for infrastructure/structural code.`,
    "",
    "Do NOT run `git rebase --continue` — that will be handled externally.",
    "Do NOT create new files or make unrelated changes.",
  )

  return lines.join("\n")
}

export async function resolveConflictsWithAgent(
  cwd: string,
  branch: string,
  targetBranch: string,
): Promise<boolean> {
  let conflictFiles: string[]
  try {
    const { stdout: raw } = await execFile("git", ["diff", "--name-only", "--diff-filter=U"], { cwd, encoding: "utf-8" })
    conflictFiles = raw.trim().split("\n").filter(Boolean)
  } catch {
    return false
  }

  if (conflictFiles.length === 0) return false

  const fileContents = new Map<string, string>()
  for (const file of conflictFiles) {
    const content = readFilePreview(cwd, file)
    if (content) fileContents.set(file, content)
  }

  const prompt = buildConflictResolutionPrompt(branch, targetBranch, conflictFiles, fileContents)
  log.info({ branch, targetBranch, conflictFiles }, "spawning conflict resolution agent")

  const proc = spawn("claude", [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
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
    const { stdout } = await execFile("git", ["diff", "--name-only", "--diff-filter=U"], { cwd, encoding: "utf-8" })
    const remaining = stdout.trim()
    const resolved = remaining.length === 0
    log.info({ resolved, remaining: remaining || "(none)" }, "conflict resolution result")
    return resolved
  } catch {
    return false
  }
}
