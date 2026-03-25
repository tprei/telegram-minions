import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

describe("fetchClaudeUsage", () => {
  let tmpDir: string
  let origHome: string | undefined
  let origConfigDir: string | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-test-"))
    origHome = process.env.HOME
    origConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    if (origHome !== undefined) process.env.HOME = origHome
    else delete process.env.HOME
    if (origConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = origConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    vi.restoreAllMocks()
  })

  it("returns null when no credentials file exists", async () => {
    const { fetchClaudeUsage } = await import("../src/claude-usage.js")
    const result = await fetchClaudeUsage()
    expect(result).toBeNull()
  })

  it("returns null when credentials lack oauth data", async () => {
    fs.writeFileSync(path.join(tmpDir, ".credentials.json"), JSON.stringify({}))
    const { fetchClaudeUsage } = await import("../src/claude-usage.js")
    const result = await fetchClaudeUsage()
    expect(result).toBeNull()
  })

  it("returns usage data on successful API response", async () => {
    const mockUsage = {
      five_hour: { utilization: 10.0, resets_at: "2026-03-25T15:00:00Z" },
      seven_day: { utilization: 30.0, resets_at: "2026-03-30T00:00:00Z" },
      seven_day_opus: { utilization: 5.0, resets_at: null },
      seven_day_sonnet: { utilization: 15.0, resets_at: "2026-03-30T00:00:00Z" },
      extra_usage: null,
    }

    const creds = {
      claudeAiOauth: {
        accessToken: "test-token",
        refreshToken: "test-refresh",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    }
    fs.writeFileSync(path.join(tmpDir, ".credentials.json"), JSON.stringify(creds))

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockUsage), { status: 200 }),
    )

    const { fetchClaudeUsage } = await import("../src/claude-usage.js")
    const result = await fetchClaudeUsage()

    expect(result).toEqual(mockUsage)
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    )
  })

  it("returns null on API error", async () => {
    const creds = {
      claudeAiOauth: {
        accessToken: "test-token",
        refreshToken: "test-refresh",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    }
    fs.writeFileSync(path.join(tmpDir, ".credentials.json"), JSON.stringify(creds))

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    )

    const { fetchClaudeUsage } = await import("../src/claude-usage.js")
    const result = await fetchClaudeUsage()
    expect(result).toBeNull()
  })
})
