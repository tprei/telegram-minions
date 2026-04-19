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

  it("returns empty results when no package.json exists", async () => {
    const report = await runQualityGates(tmpDir)
    expect(report.results).toHaveLength(0)
    expect(report.allPassed).toBe(true)
  })

  it("detects test command from package.json", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "echo ok" } }),
    )
    const report = await runQualityGates(tmpDir)
    expect(report.results.some((r) => r.gate === "tests")).toBe(true)
  })

  it("skips default npm test placeholder", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    )
    const report = await runQualityGates(tmpDir)
    expect(report.results.some((r) => r.gate === "tests")).toBe(false)
  })

  it("detects typecheck from tsconfig.json", { timeout: 30_000 }, async () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ scripts: {} }))
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }))
    const report = await runQualityGates(tmpDir)
    expect(report.results.some((r) => r.gate === "typecheck")).toBe(true)
  })

  it("detects lint command", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { lint: "echo lint ok" } }),
    )
    const report = await runQualityGates(tmpDir)
    const lint = report.results.find((r) => r.gate === "lint")
    expect(lint).toBeDefined()
    expect(lint!.passed).toBe(true)
  })

  it("reports failure when test command fails", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "exit 1" } }),
    )
    const report = await runQualityGates(tmpDir)
    const tests = report.results.find((r) => r.gate === "tests")
    expect(tests).toBeDefined()
    expect(tests!.passed).toBe(false)
    expect(report.allPassed).toBe(false)
  })

  it("runs gates in parallel (wall-clock less than sum)", async () => {
    // Three gates each sleep 400ms. Serial would be 1200ms+; parallel ~400ms.
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        scripts: {
          test: "sleep 0.4 && echo test-ok",
          typecheck: "sleep 0.4 && echo tc-ok",
          lint: "sleep 0.4 && echo lint-ok",
        },
      }),
    )
    const start = Date.now()
    const report = await runQualityGates(tmpDir)
    const elapsed = Date.now() - start

    expect(report.results).toHaveLength(3)
    expect(report.allPassed).toBe(true)
    // Allow generous tolerance for CI variance but still well under serial 1200ms
    expect(elapsed).toBeLessThan(1100)
  }, 10_000)
})
