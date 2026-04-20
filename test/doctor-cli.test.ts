import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  checkNodeVersion,
  checkWorkspaceRoot,
  checkApiPort,
  checkMinionApiToken,
  checkGitHubToken,
  checkTelegram,
  renderReport,
  type DoctorReport,
} from "../src/config/doctor.js"

const ENV_KEYS = [
  "WORKSPACE_ROOT",
  "MINION_API_TOKEN",
  "API_PORT",
  "GITHUB_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "ALLOWED_USER_IDS",
] as const

describe("doctor checks", () => {
  const saved: Record<string, string | undefined> = {}
  let tmpDir: string

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minion-doctor-"))
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("checkNodeVersion", () => {
    it("reports current Node version", () => {
      const result = checkNodeVersion()
      expect(["ok", "warn", "fail"]).toContain(result.status)
      expect(result.message).toContain(process.versions.node)
    })
  })

  describe("checkWorkspaceRoot", () => {
    it("passes for a writable directory", () => {
      process.env["WORKSPACE_ROOT"] = tmpDir
      const result = checkWorkspaceRoot()
      expect(result.status).toBe("ok")
      expect(result.message).toContain(tmpDir)
    })

    it("fails for an unwritable path", () => {
      // Collide with a regular file: mkdir will refuse to create a directory
      // where a file already exists.
      const collision = path.join(tmpDir, "blocker")
      fs.writeFileSync(collision, "not a dir")
      process.env["WORKSPACE_ROOT"] = path.join(collision, "sub")
      const result = checkWorkspaceRoot()
      expect(result.status).toBe("fail")
      expect(result.fix).toBeDefined()
    })
  })

  describe("checkApiPort", () => {
    it("fails for invalid port values", async () => {
      process.env["API_PORT"] = "not-a-number"
      const result = await checkApiPort()
      expect(result.status).toBe("fail")
    })

    it("passes when a free port is picked", async () => {
      // Pick an ephemeral port unlikely to collide
      const srv = (await import("node:net")).createServer()
      await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()))
      const freePort = (srv.address() as { port: number }).port
      await new Promise<void>((resolve) => srv.close(() => resolve()))

      process.env["API_PORT"] = String(freePort)
      const result = await checkApiPort()
      expect(result.status).toBe("ok")
      expect(result.message).toContain(String(freePort))
    })
  })

  describe("checkMinionApiToken", () => {
    it("warns when not set", () => {
      const result = checkMinionApiToken()
      expect(result.status).toBe("warn")
    })

    it("warns when token is short", () => {
      process.env["MINION_API_TOKEN"] = "short"
      const result = checkMinionApiToken()
      expect(result.status).toBe("warn")
      expect(result.fix).toBeDefined()
    })

    it("passes for a strong token", () => {
      process.env["MINION_API_TOKEN"] = "a".repeat(64)
      const result = checkMinionApiToken()
      expect(result.status).toBe("ok")
    })
  })

  describe("checkGitHubToken", () => {
    it("passes when GITHUB_TOKEN is set", () => {
      process.env["GITHUB_TOKEN"] = "ghp_" + "x".repeat(40)
      const result = checkGitHubToken()
      expect(result.status).toBe("ok")
    })
  })

  describe("checkTelegram", () => {
    it("passes when no Telegram credentials are present (PWA-only)", () => {
      const result = checkTelegram()
      expect(result.status).toBe("ok")
      expect(result.message).toContain("PWA-only")
    })

    it("warns when only bot token is set", () => {
      process.env["TELEGRAM_BOT_TOKEN"] = "abc"
      const result = checkTelegram()
      expect(result.status).toBe("warn")
    })

    it("passes when all three vars are set", () => {
      process.env["TELEGRAM_BOT_TOKEN"] = "abc"
      process.env["TELEGRAM_CHAT_ID"] = "-100"
      process.env["ALLOWED_USER_IDS"] = "123"
      const result = checkTelegram()
      expect(result.status).toBe("ok")
    })
  })

  describe("renderReport", () => {
    it("produces human-readable output with fix hints", () => {
      const report: DoctorReport = {
        ok: false,
        checks: [
          { name: "Thing", status: "ok", message: "fine" },
          { name: "Other", status: "fail", message: "broken", fix: "do the thing" },
        ],
      }
      const out = renderReport(report)
      expect(out).toContain("telegram-minion doctor")
      expect(out).toContain("[ok]")
      expect(out).toContain("[fail]")
      expect(out).toContain("do the thing")
      expect(out).toContain("Some checks failed")
    })

    it("shows success summary when all ok", () => {
      const report: DoctorReport = {
        ok: true,
        checks: [{ name: "X", status: "ok", message: "fine" }],
      }
      const out = renderReport(report)
      expect(out).toContain("All checks passed")
    })
  })
})
