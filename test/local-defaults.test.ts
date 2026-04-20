import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  isLocalEnvironment,
  loadOrCreateApiToken,
  resolveLocalDefaults,
  applyLocalDefaults,
} from "../src/config/local-defaults.js"

const ENV_KEYS = [
  "WORKSPACE_ROOT",
  "MINION_API_TOKEN",
  "API_PORT",
  "GITHUB_TOKEN",
  "CORS_ALLOWED_ORIGINS",
  "MINION_LOCAL_MODE",
  "IS_SANDBOX",
  "FLY_APP_NAME",
  "FLY_MACHINE_ID",
] as const

describe("local-defaults", () => {
  const saved: Record<string, string | undefined> = {}
  let tmpDir: string

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minion-local-defaults-"))
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("isLocalEnvironment", () => {
    it("returns true when MINION_LOCAL_MODE=true", () => {
      process.env["MINION_LOCAL_MODE"] = "true"
      expect(isLocalEnvironment()).toBe(true)
    })

    it("returns false when MINION_LOCAL_MODE=false", () => {
      process.env["MINION_LOCAL_MODE"] = "false"
      expect(isLocalEnvironment()).toBe(false)
    })

    it("returns false when IS_SANDBOX=true (in container)", () => {
      process.env["IS_SANDBOX"] = "true"
      expect(isLocalEnvironment()).toBe(false)
    })

    it("returns false on Fly.io (FLY_APP_NAME set)", () => {
      process.env["FLY_APP_NAME"] = "my-app"
      expect(isLocalEnvironment()).toBe(false)
    })
  })

  describe("loadOrCreateApiToken", () => {
    it("creates a new token file when absent", () => {
      const tokenPath = path.join(tmpDir, ".api-token")
      expect(fs.existsSync(tokenPath)).toBe(false)

      const token = loadOrCreateApiToken(tmpDir)
      expect(token.length).toBeGreaterThanOrEqual(32)
      expect(fs.readFileSync(tokenPath, "utf8").trim()).toBe(token)
    })

    it("returns existing token when file present", () => {
      const tokenPath = path.join(tmpDir, ".api-token")
      const existing = "a".repeat(64)
      fs.writeFileSync(tokenPath, existing)

      const token = loadOrCreateApiToken(tmpDir)
      expect(token).toBe(existing)
    })

    it("regenerates if stored token is too short", () => {
      const tokenPath = path.join(tmpDir, ".api-token")
      fs.writeFileSync(tokenPath, "short")

      const token = loadOrCreateApiToken(tmpDir)
      expect(token).not.toBe("short")
      expect(token.length).toBeGreaterThanOrEqual(32)
    })
  })

  describe("resolveLocalDefaults", () => {
    it("uses ./.minion-data as default workspace when WORKSPACE_ROOT unset", () => {
      const defaults = resolveLocalDefaults()
      expect(defaults.workspaceRoot).toBe(path.resolve(process.cwd(), ".minion-data"))
      expect(defaults.notices.some((n) => n.includes("WORKSPACE_ROOT not set"))).toBe(true)
    })

    it("respects explicit WORKSPACE_ROOT", () => {
      process.env["WORKSPACE_ROOT"] = tmpDir
      const defaults = resolveLocalDefaults()
      expect(defaults.workspaceRoot).toBe(tmpDir)
      expect(defaults.notices.some((n) => n.includes("WORKSPACE_ROOT not set"))).toBe(false)
    })

    it("auto-generates an API token when unset", () => {
      process.env["WORKSPACE_ROOT"] = tmpDir
      const defaults = resolveLocalDefaults()
      expect(defaults.apiToken.length).toBeGreaterThanOrEqual(32)
      expect(defaults.notices.some((n) => n.includes("MINION_API_TOKEN"))).toBe(true)
    })

    it("respects explicit MINION_API_TOKEN", () => {
      process.env["WORKSPACE_ROOT"] = tmpDir
      process.env["MINION_API_TOKEN"] = "explicit-token-value"
      const defaults = resolveLocalDefaults()
      expect(defaults.apiToken).toBe("explicit-token-value")
    })

    it("defaults API_PORT to 8080", () => {
      process.env["WORKSPACE_ROOT"] = tmpDir
      const defaults = resolveLocalDefaults()
      expect(defaults.apiPort).toBe(8080)
    })

    it("respects explicit API_PORT", () => {
      process.env["WORKSPACE_ROOT"] = tmpDir
      process.env["API_PORT"] = "9000"
      const defaults = resolveLocalDefaults()
      expect(defaults.apiPort).toBe(9000)
    })

    it("allows CORS for localhost:5173 by default", () => {
      process.env["WORKSPACE_ROOT"] = tmpDir
      const defaults = resolveLocalDefaults()
      expect(defaults.corsAllowedOrigins).toContain("http://localhost:5173")
    })

    it("respects explicit CORS_ALLOWED_ORIGINS", () => {
      process.env["WORKSPACE_ROOT"] = tmpDir
      process.env["CORS_ALLOWED_ORIGINS"] = "https://my.app"
      const defaults = resolveLocalDefaults()
      expect(defaults.corsAllowedOrigins).toEqual(["https://my.app"])
    })
  })

  describe("applyLocalDefaults", () => {
    it("mutates process.env for unset vars", () => {
      process.env["WORKSPACE_ROOT"] = tmpDir
      applyLocalDefaults()
      expect(process.env["MINION_API_TOKEN"]).toBeDefined()
      expect(process.env["MINION_API_TOKEN"]!.length).toBeGreaterThanOrEqual(32)
      expect(process.env["API_PORT"]).toBe("8080")
      expect(process.env["CORS_ALLOWED_ORIGINS"]).toContain("localhost:5173")
    })

    it("leaves explicit vars untouched", () => {
      process.env["WORKSPACE_ROOT"] = tmpDir
      process.env["MINION_API_TOKEN"] = "preset-token"
      process.env["API_PORT"] = "9999"
      applyLocalDefaults()
      expect(process.env["MINION_API_TOKEN"]).toBe("preset-token")
      expect(process.env["API_PORT"]).toBe("9999")
    })

    it("returns the list of notices for CLI logging", () => {
      process.env["WORKSPACE_ROOT"] = tmpDir
      const notices = applyLocalDefaults()
      expect(notices).toBeInstanceOf(Array)
      expect(notices.some((n) => n.includes("MINION_API_TOKEN"))).toBe(true)
    })
  })
})
