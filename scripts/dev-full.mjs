#!/usr/bin/env node
// Run engine + PWA dev server side-by-side with prefixed, color-coded logs.
//
// Equivalent to `concurrently "npm:dev" "npm:dev:ui"` but without the extra
// dependency. Good enough for the local "one command to start everything"
// promise.
//
// Usage: npm run dev:full
//
// Ctrl-C propagates to both children; one crashing tears down the other.

import { spawn } from "node:child_process"
import path from "node:path"
import process from "node:process"

const ROOT = path.resolve(new URL("..", import.meta.url).pathname)

const tasks = [
  { name: "engine", color: "\x1b[36m", cmd: "npm", args: ["run", "dev"], cwd: ROOT },
  { name: "ui    ", color: "\x1b[35m", cmd: "npm", args: ["run", "dev"], cwd: path.join(ROOT, "ui") },
]

const RESET = "\x1b[0m"
const children = []
let shuttingDown = false

function log(task, line) {
  if (!line) return
  process.stdout.write(`${task.color}[${task.name}]${RESET} ${line}\n`)
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) {
      try { child.kill("SIGTERM") } catch { /* noop */ }
    }
  }
  setTimeout(() => process.exit(code), 500).unref()
}

process.on("SIGINT", () => shutdown(130))
process.on("SIGTERM", () => shutdown(143))

for (const task of tasks) {
  const child = spawn(task.cmd, task.args, {
    cwd: task.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.push(child)

  let stdoutBuf = ""
  let stderrBuf = ""
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString()
    const lines = stdoutBuf.split("\n")
    stdoutBuf = lines.pop() ?? ""
    for (const line of lines) log(task, line)
  })
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString()
    const lines = stderrBuf.split("\n")
    stderrBuf = lines.pop() ?? ""
    for (const line of lines) log(task, line)
  })
  child.on("exit", (code, signal) => {
    log(task, `exited (code=${code}, signal=${signal})`)
    shutdown(code ?? 1)
  })
}
