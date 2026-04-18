import { exec as execCb } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs"
import path from "node:path"

const exec = promisify(execCb)

export interface GateResult {
  gate: string
  passed: boolean
  output: string
}

export interface QualityReport {
  results: GateResult[]
  allPassed: boolean
}

const GATE_TIMEOUT_MS = 300_000

async function run(cmd: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout } = await exec(cmd, {
      cwd,
      timeout: GATE_TIMEOUT_MS,
      env: { ...process.env, CI: "true", NODE_ENV: "test" },
      maxBuffer: 10 * 1024 * 1024,
    })
    return { ok: true, output: stdout.toString().trim() }
  } catch (err: unknown) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string }
    const out = e.stdout ? e.stdout.toString().trim() : ""
    const stderr = e.stderr ? e.stderr.toString().trim() : ""
    return { ok: false, output: (out + "\n" + stderr).trim() || e.message || "unknown error" }
  }
}

function detectTestCommand(cwd: string): string | null {
  const pkgPath = path.join(cwd, "package.json")
  if (!fs.existsSync(pkgPath)) return null

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
    const scripts = pkg.scripts ?? {}
    if (scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') {
      return "npm test"
    }
  } catch {
    return null
  }

  return null
}

function detectTypecheckCommand(cwd: string): string | null {
  const pkgPath = path.join(cwd, "package.json")
  if (!fs.existsSync(pkgPath)) return null

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
    const scripts = pkg.scripts ?? {}
    if (scripts.typecheck) return "npm run typecheck"
    if (scripts["type-check"]) return "npm run type-check"
  } catch {
    return null
  }

  if (fs.existsSync(path.join(cwd, "tsconfig.json"))) {
    return "npx tsc --noEmit"
  }

  return null
}

function detectLintCommand(cwd: string): string | null {
  const pkgPath = path.join(cwd, "package.json")
  if (!fs.existsSync(pkgPath)) return null

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
    const scripts = pkg.scripts ?? {}
    if (scripts.lint) return "npm run lint"
  } catch {
    return null
  }

  return null
}

export async function runQualityGates(cwd: string): Promise<QualityReport> {
  // Ensure dependencies are installed (sequential — prerequisite for the gates)
  const pkgPath = path.join(cwd, "package.json")
  const nodeModulesPath = path.join(cwd, "node_modules")
  if (fs.existsSync(pkgPath) && !fs.existsSync(nodeModulesPath)) {
    await run("npm install", cwd)
  }

  // Run all gates in parallel. The gates are independent — they read the same
  // files but don't mutate shared state — so running them concurrently is
  // safe and cuts wall-clock time to roughly max(t_test, t_typecheck, t_lint)
  // instead of their sum.
  const gates: Array<Promise<GateResult | null>> = []

  const testCmd = detectTestCommand(cwd)
  if (testCmd) {
    gates.push(run(testCmd, cwd).then(({ ok, output }) => ({ gate: "tests", passed: ok, output })))
  }

  const typecheckCmd = detectTypecheckCommand(cwd)
  if (typecheckCmd) {
    gates.push(run(typecheckCmd, cwd).then(({ ok, output }) => ({ gate: "typecheck", passed: ok, output })))
  }

  const lintCmd = detectLintCommand(cwd)
  if (lintCmd) {
    gates.push(run(lintCmd, cwd).then(({ ok, output }) => ({ gate: "lint", passed: ok, output })))
  }

  const settled = await Promise.all(gates)
  const results = settled.filter((r): r is GateResult => r !== null)

  return {
    results,
    allPassed: results.every((r) => r.passed),
  }
}
