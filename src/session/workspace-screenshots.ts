import fs from "node:fs/promises"
import path from "node:path"

const SCREENSHOTS_DIR = ".screenshots"

export interface ScreenshotEntry {
  filename: string
  sizeBytes: number
  capturedAt: string
}

/**
 * List the screenshots captured by a session.
 *
 * The Playwright MCP writes PNGs into `${session.cwd}/.screenshots/`. We list
 * them in capture order (mtime) so the newest screenshot is last — matching
 * the chat-style rendering in the PWA.
 */
export async function listSessionScreenshots(cwd: string): Promise<ScreenshotEntry[]> {
  const dir = path.join(cwd, SCREENSHOTS_DIR)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }

  const pngs = entries.filter((name) => name.endsWith(".png"))
  const enriched: ScreenshotEntry[] = []
  for (const name of pngs) {
    try {
      const stat = await fs.stat(path.join(dir, name))
      enriched.push({
        filename: name,
        sizeBytes: stat.size,
        capturedAt: stat.mtime.toISOString(),
      })
    } catch {
      // File disappeared between readdir and stat — skip.
    }
  }
  enriched.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
  return enriched
}

/**
 * Resolve a screenshot filename to an absolute path inside the session's
 * `.screenshots/` directory, rejecting anything that would escape the
 * directory via `..`, symlinks, or absolute paths.
 */
export function resolveScreenshotPath(cwd: string, filename: string): string | null {
  const base = path.resolve(cwd, SCREENSHOTS_DIR)
  const candidate = path.resolve(base, filename)
  if (!candidate.startsWith(base + path.sep) && candidate !== base) return null
  if (!filename.endsWith(".png")) return null
  return candidate
}
