import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { SessionEntry } from "./types.js"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const CACHE_PATH = path.resolve(scriptDir, "..", "sessions-cache.json")

export function readCache(): Record<string, SessionEntry> {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) as Record<string, SessionEntry>
  } catch {
    return {}
  }
}

function writeCache(cache: Record<string, SessionEntry>): void {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2))
}

export function upsertSession(threadId: number, entry: SessionEntry): void {
  const cache = readCache()
  const cutoff = Date.now() - 86400000
  for (const key of Object.keys(cache)) {
    if (cache[key].ts < cutoff) {
      delete cache[key]
    }
  }
  cache[threadId.toString()] = entry
  writeCache(cache)
}
