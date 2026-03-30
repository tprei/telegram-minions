import fs from "node:fs"
import path from "node:path"
import type { TopicSession, SessionMeta } from "../types.js"
import type { QualityReport } from "../ci/quality-gates.js"
import { loggers } from "../logger.js"

const log = loggers.sessionLog

export interface SessionLogEntry {
  slug: string
  repo: string
  mode: string
  task: string
  startedAt: number
  completedAt: number
  durationMs: number
  totalTokens: number
  state: "completed" | "errored"
  qualityGates?: QualityReport
  conversationLength: number
}

export function writeSessionLog(
  topicSession: TopicSession,
  meta: SessionMeta,
  state: "completed" | "errored",
  durationMs: number,
  qualityReport?: QualityReport,
): void {
  const entry: SessionLogEntry = {
    slug: topicSession.slug,
    repo: topicSession.repo,
    mode: topicSession.mode,
    task: topicSession.conversation[0]?.text ?? "",
    startedAt: meta.startedAt,
    completedAt: Date.now(),
    durationMs,
    totalTokens: meta.totalTokens ?? 0,
    state,
    qualityGates: qualityReport,
    conversationLength: topicSession.conversation.length,
  }

  const logPath = path.join(topicSession.cwd, "session-log.json")
  try {
    fs.mkdirSync(topicSession.cwd, { recursive: true })
    fs.writeFileSync(logPath, JSON.stringify(entry, null, 2), "utf-8")
  } catch (err) {
    log.error({ err, logPath, slug: topicSession.slug }, "failed to write session log")
  }
}
