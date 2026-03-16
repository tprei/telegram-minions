import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const CACHE_PATH = path.resolve(scriptDir, "..", "topics-cache.json")

interface TopicEntry {
  threadId: number
  renamed: boolean
}

function readCache(): Record<string, TopicEntry> {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) as Record<string, TopicEntry>
  } catch {
    return {}
  }
}

function writeCache(cache: Record<string, TopicEntry>): void {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2))
}

export async function getOrCreateTopic(
  token: string,
  chatId: string,
  topicName: string,
  sessionId: string,
): Promise<number | null> {
  const cache = readCache()
  if (cache[sessionId] !== undefined) return cache[sessionId].threadId

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/createForumTopic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, name: topicName }),
    })

    if (!res.ok) {
      const body = await res.text()
      process.stderr.write(`telegram: createForumTopic HTTP ${res.status}: ${body}\n`)
      return null
    }

    const data = (await res.json()) as { ok: boolean; result: { message_thread_id: number } }
    const threadId = data.result.message_thread_id
    cache[sessionId] = { threadId, renamed: false }
    writeCache(cache)
    return threadId
  } catch (err) {
    process.stderr.write(`telegram: createForumTopic failed: ${err}\n`)
    return null
  }
}

export function lookupTopic(sessionId: string): number | null {
  const cache = readCache()
  return cache[sessionId]?.threadId ?? null
}

export function isTopicRenamed(sessionId: string): boolean {
  const cache = readCache()
  return cache[sessionId]?.renamed ?? false
}

export function markTopicRenamed(sessionId: string): void {
  const cache = readCache()
  if (cache[sessionId]) {
    cache[sessionId].renamed = true
    writeCache(cache)
  }
}

export async function renameTopic(
  token: string,
  chatId: string,
  threadId: number,
  newName: string,
): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/editForumTopic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_thread_id: threadId, name: newName }),
    })

    if (!res.ok) {
      const body = await res.text()
      process.stderr.write(`telegram: editForumTopic HTTP ${res.status}: ${body}\n`)
      return false
    }

    const data = (await res.json()) as { ok: boolean }
    return data.ok === true
  } catch (err) {
    process.stderr.write(`telegram: editForumTopic failed: ${err}\n`)
    return false
  }
}

export function removeTopicFromCache(sessionId: string): void {
  const cache = readCache()
  delete cache[sessionId]
  writeCache(cache)
}

export async function deleteTopic(
  token: string,
  chatId: string,
  threadId: number,
): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/deleteForumTopic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_thread_id: threadId }),
    })

    if (!res.ok) {
      const body = await res.text()
      process.stderr.write(`telegram: deleteForumTopic HTTP ${res.status}: ${body}\n`)
      return false
    }

    const data = (await res.json()) as { ok: boolean }
    return data.ok === true
  } catch (err) {
    process.stderr.write(`telegram: deleteForumTopic failed: ${err}\n`)
    return false
  }
}
