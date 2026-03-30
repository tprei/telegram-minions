import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { runQualityGates } from "../src/ci/quality-gates.js"

describe("runQualityGates", { timeout: 30000 }, () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns empty results when no package.json exists", () => {
    const report = runQualityGates(tmpDir)
    expect(report.results).toHaveLength(0)
    expect(report.allPassed).toBe(true)
  })

  it("detects test command from package.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "echo ok" } }),
    )
    const report = runQualityGates(tmpDir)
    expect(report.results.some((r) => r.gate === "tests")).toBe(true)
  })

  it("skips default npm test placeholder", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    )
    const report = runQualityGates(tmpDir)
    expect(report.results.some((r) => r.gate === "tests")).toBe(false)
  })

  it("detects typecheck from tsconfig.json", { timeout: 30_000 }, () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ scripts: {} }))
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }))
    const report = runQualityGates(tmpDir)
    expect(report.results.some((r) => r.gate === "typecheck")).toBe(true)
  })

  it("detects lint command", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { lint: "echo lint ok" } }),
    )
    const report = runQualityGates(tmpDir)
    const lint = report.results.find((r) => r.gate === "lint")
    expect(lint).toBeDefined()
    expect(lint!.passed).toBe(true)
  })

  it("reports failure when test command fails", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "exit 1" } }),
    )
    const report = runQualityGates(tmpDir)
    const tests = report.results.find((r) => r.gate === "tests")
    expect(tests).toBeDefined()
    expect(tests!.passed).toBe(false)
    expect(report.allPassed).toBe(false)
  })
})
