import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

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

function run(cmd: string, cwd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      cwd,
      timeout: GATE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "true", NODE_ENV: "test" },
    })
    return { ok: true, output: output.toString().trim() }
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string }
    const out = e.stdout?.toString().trim() ?? ""
    const stderr = e.stderr?.toString().trim() ?? ""
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

export function runQualityGates(cwd: string): QualityReport {
  const results: GateResult[] = []

  // Ensure dependencies are installed
  const pkgPath = path.join(cwd, "package.json")
  const nodeModulesPath = path.join(cwd, "node_modules")
  if (fs.existsSync(pkgPath) && !fs.existsSync(nodeModulesPath)) {
    run("npm install", cwd)
  }

  const testCmd = detectTestCommand(cwd)
  if (testCmd) {
    const { ok, output } = run(testCmd, cwd)
    results.push({ gate: "tests", passed: ok, output })
  }

  const typecheckCmd = detectTypecheckCommand(cwd)
  if (typecheckCmd) {
    const { ok, output } = run(typecheckCmd, cwd)
    results.push({ gate: "typecheck", passed: ok, output })
  }

  const lintCmd = detectLintCommand(cwd)
  if (lintCmd) {
    const { ok, output } = run(lintCmd, cwd)
    results.push({ gate: "lint", passed: ok, output })
  }

  return {
    results,
    allPassed: results.every((r) => r.passed),
  }
}
