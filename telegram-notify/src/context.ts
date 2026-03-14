import { execSync } from "node:child_process"
import os from "node:os"
import path from "node:path"

export interface EnvContext {
  project: string
  branch: string
  hostname: string
  tmuxWindow: string | null
}

export function gatherContext(cwd: string): EnvContext {
  return {
    project: path.basename(cwd),
    branch: gitBranch(cwd),
    hostname: os.hostname(),
    tmuxWindow: tmuxWindowName(),
  }
}

function tmuxWindowName(): string | null {
  if (!process.env["TMUX"]) return null
  try {
    return execSync("tmux display-message -p '#W'", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null
  } catch {
    return null
  }
}

function gitBranch(cwd: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return "n/a"
  }
}
