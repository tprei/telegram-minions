import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { listSessionScreenshots, resolveScreenshotPath } from "../src/session/workspace-screenshots.js"

describe("listSessionScreenshots", () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "screenshots-"))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("returns an empty list when the .screenshots directory is missing", async () => {
    const result = await listSessionScreenshots(dir)
    expect(result).toEqual([])
  })

  it("ignores non-PNG files", async () => {
    const screenshotsDir = path.join(dir, ".screenshots")
    await fs.mkdir(screenshotsDir)
    await fs.writeFile(path.join(screenshotsDir, "a.png"), "x")
    await fs.writeFile(path.join(screenshotsDir, "notes.txt"), "y")

    const result = await listSessionScreenshots(dir)
    expect(result.map((r) => r.filename)).toEqual(["a.png"])
  })

  it("orders PNGs by mtime so the latest capture is last", async () => {
    const screenshotsDir = path.join(dir, ".screenshots")
    await fs.mkdir(screenshotsDir)

    const aPath = path.join(screenshotsDir, "a.png")
    const bPath = path.join(screenshotsDir, "b.png")
    await fs.writeFile(aPath, "x")
    await fs.writeFile(bPath, "y")

    // Force a timestamp gap so the ordering is deterministic.
    const past = new Date(Date.now() - 60_000)
    await fs.utimes(aPath, past, past)

    const result = await listSessionScreenshots(dir)
    expect(result.map((r) => r.filename)).toEqual(["a.png", "b.png"])
  })
})

describe("resolveScreenshotPath", () => {
  it("accepts a plain PNG filename", () => {
    const result = resolveScreenshotPath("/tmp/sess", "shot.png")
    expect(result).toBe(path.resolve("/tmp/sess/.screenshots/shot.png"))
  })

  it("rejects path traversal via ..", () => {
    expect(resolveScreenshotPath("/tmp/sess", "../etc/passwd")).toBeNull()
    expect(resolveScreenshotPath("/tmp/sess", "../../.ssh/id_rsa")).toBeNull()
  })

  it("rejects absolute paths", () => {
    expect(resolveScreenshotPath("/tmp/sess", "/etc/passwd")).toBeNull()
  })

  it("rejects non-PNG files", () => {
    expect(resolveScreenshotPath("/tmp/sess", "shot.txt")).toBeNull()
  })
})
