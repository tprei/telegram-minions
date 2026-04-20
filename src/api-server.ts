import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { EventEmitter } from "node:events"
import type { TopicSession, SessionState, SessionDoneState } from "./domain/session-types.js"
import type { ActiveSession } from "./session/session-manager.js"
import type { DagGraph } from "./dag/dag.js"
import { loggers } from "./logger.js"
import { computeWorkspaceDiff } from "./session/workspace-diff.js"
import { listSessionScreenshots, resolveScreenshotPath } from "./session/workspace-screenshots.js"
import { fetchPrPreview } from "./github/pr-preview.js"
import type { PushSubscriptionStore } from "./push/push-subscriptions.js"
import type { VapidKeys } from "./push/vapid-keys.js"
import type { TranscriptEvent, TranscriptSnapshot } from "./transcript/types.js"
import pkg from "../package.json" with { type: "json" }

const log = loggers.apiServer

export type AttentionReason =
  | "failed"
  | "waiting_for_feedback"
  | "interrupted"
  | "ci_fix"
  | "idle_long"

export type QuickActionType =
  | "make_pr"
  | "retry"
  | "resume"

export interface QuickAction {
  type: QuickActionType
  label: string
  message: string
}

export type PlanActionType = "execute" | "split" | "stack" | "dag"

export interface ConversationMessage {
  role: "user" | "assistant"
  text: string
}

export interface ApiSession {
  id: string
  slug: string
  status: "pending" | "running" | "completed" | "failed"
  command: string
  repo?: string
  branch?: string
  prUrl?: string
  threadId?: number
  chatId?: number
  createdAt: string
  updatedAt: string
  parentId?: string
  childIds: string[]
  needsAttention: boolean
  attentionReasons: AttentionReason[]
  quickActions: QuickAction[]
  mode: string
  conversation: ConversationMessage[]
  /** Path to the structured transcript for this session. Stable across the
   *  session's lifetime — PWA clients GET for snapshot + `after=<seq>`
   *  replay, and watch the SSE stream for incremental `transcript_event`s. */
  transcriptUrl: string
}

export interface ApiDagNode {
  id: string
  slug: string
  status: "pending" | "running" | "completed" | "failed" | "skipped" | "ci-pending" | "ci-failed" | "landed"
  dependencies: string[]
  dependents: string[]
  session?: ApiSession
}

export interface ApiDagGraph {
  id: string
  rootTaskId: string
  nodes: Record<string, ApiDagNode>
  status: "pending" | "running" | "completed" | "failed"
  createdAt: string
  updatedAt: string
}

export interface ApiResponse<T> {
  data: T
  error?: string
}

export interface CommandResult {
  success: boolean
  error?: string
}

export type SseEvent =
  | { type: "session_created"; session: ApiSession }
  | { type: "session_updated"; session: ApiSession }
  | { type: "session_deleted"; sessionId: string }
  | { type: "dag_created"; dag: ApiDagGraph }
  | { type: "dag_updated"; dag: ApiDagGraph }
  | { type: "dag_deleted"; dagId: string }
  | { type: "transcript_event"; sessionId: string; event: TranscriptEvent }

export type MinionCommand =
  | { action: "reply"; sessionId: string; message: string }
  | { action: "stop"; sessionId: string }
  | { action: "close"; sessionId: string }
  | { action: "plan_action"; sessionId: string; planAction: PlanActionType }

export type CreateSessionMode = "task" | "plan" | "think" | "review" | "ship-think"

export interface CreateSessionRequest {
  repo?: string
  prompt: string
  mode?: CreateSessionMode
  profileId?: string
}

export type CreateSessionVariantResult =
  | { slug: string; threadId: number }
  | { error: string }

export interface DispatcherApi {
  getSessions(): Map<number, ActiveSession>
  getTopicSessions(): Map<number, TopicSession>
  getDags(): Map<string, DagGraph>
  getSessionState(threadId: number): SessionState | undefined
  sendReply(threadId: number, message: string): Promise<void>
  stopSession(threadId: number): void
  closeSession(threadId: number): Promise<void>
  handleIncomingText(text: string, sessionSlug?: string): Promise<void>
  createSession(request: CreateSessionRequest): Promise<{ slug: string; threadId: number }>
  createSessionVariants(request: CreateSessionRequest, count: number): Promise<CreateSessionVariantResult[]>
  /**
   * Return a snapshot of the structured transcript for `slug`, containing
   * only events with `seq > afterSeq`. Returns `undefined` when the session
   * is unknown. Returning an empty-events snapshot is valid (e.g. a session
   * whose transcript hasn't started yet).
   *
   * Optional so minions without a TranscriptStore wired up still satisfy the
   * interface — in that case the REST endpoint responds 501.
   */
  getTranscript?(slug: string, afterSeq: number): TranscriptSnapshot | undefined
}

export class StateBroadcaster extends EventEmitter {
  broadcast(event: SseEvent): void {
    this.emit("event", event)
  }
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_TYPES[ext] ?? "application/octet-stream"
}

const IDLE_LONG_THRESHOLD_MS = 30 * 60 * 1000 // 30 minutes

export function computeAttentionReasons(
  session: TopicSession,
  status: ApiSession["status"],
): AttentionReason[] {
  const reasons: AttentionReason[] = []

  if (status === "failed") {
    reasons.push("failed")
  }

  if (session.pendingFeedback && session.pendingFeedback.length > 0) {
    reasons.push("waiting_for_feedback")
  }

  if (session.interruptedAt && !session.activeSessionId) {
    reasons.push("interrupted")
  }

  if (session.mode === "ci-fix") {
    reasons.push("ci_fix")
  }

  if (
    status === "pending" &&
    !session.activeSessionId &&
    Date.now() - session.lastActivityAt > IDLE_LONG_THRESHOLD_MS
  ) {
    reasons.push("idle_long")
  }

  return reasons
}

export function computeQuickActions(
  session: TopicSession,
  status: ApiSession["status"],
): QuickAction[] {
  const actions: QuickAction[] = []

  if (
    status === "completed" &&
    session.branch &&
    !session.prUrl
  ) {
    actions.push({
      type: "make_pr",
      label: "Make a PR",
      message: "Please open a pull request for your changes.",
    })
  }

  if (status === "failed") {
    actions.push({
      type: "retry",
      label: "Retry",
      message: "Please retry the task from where you left off.",
    })
  }

  if (session.interruptedAt && !session.activeSessionId) {
    actions.push({
      type: "resume",
      label: "Resume",
      message: "Please resume the interrupted task.",
    })
  }

  return actions
}

export function topicSessionToApi(
  session: TopicSession,
  chatId: string | undefined,
  activeSessionId?: string,
  sessionState?: SessionState | SessionDoneState,
): ApiSession {
  const status = sessionState === "completed"
    ? "completed"
    : sessionState === "errored" || sessionState === "quota_exhausted"
      ? "failed"
      : session.activeSessionId || activeSessionId
        ? "running"
        : "pending"

  const attentionReasons = computeAttentionReasons(session, status)
  const quickActions = computeQuickActions(session, status)

  return {
    id: session.slug,
    slug: session.slug,
    status,
    command: session.conversation[0]?.text ?? "",
    repo: session.repoUrl,
    branch: session.branch,
    prUrl: session.prUrl,
    threadId: session.threadId,
    chatId: chatId ? parseInt(chatId, 10) : undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date(session.lastActivityAt).toISOString(),
    parentId: session.parentThreadId?.toString(),
    childIds: session.childThreadIds?.map(String) ?? [],
    needsAttention: attentionReasons.length > 0,
    attentionReasons,
    quickActions,
    mode: session.mode,
    conversation: session.conversation.map((m) => ({ role: m.role, text: m.text })),
    transcriptUrl: `/api/sessions/${encodeURIComponent(session.slug)}/transcript`,
  }
}

export function dagToApi(
  graph: DagGraph,
  topicSessions: Map<number, TopicSession>,
  sessions: Map<number, ActiveSession>,
  chatId: string | undefined,
): ApiDagGraph {
  const nodes: Record<string, ApiDagNode> = {}

  // Build dependency graph
  const dependents = new Map<string, string[]>()
  for (const node of graph.nodes) {
    dependents.set(node.id, [])
  }
  for (const node of graph.nodes) {
    for (const dep of node.dependsOn) {
      dependents.get(dep)?.push(node.id)
    }
  }

  for (const node of graph.nodes) {
    const topicSession = node.threadId ? topicSessions.get(node.threadId) : undefined
    const activeSession = node.threadId ? sessions.get(node.threadId) : undefined

    let apiSession: ApiSession | undefined
    if (topicSession) {
      apiSession = topicSessionToApi(topicSession, chatId, activeSession?.meta.sessionId)
    }

    nodes[node.id] = {
      id: node.id,
      slug: topicSession?.slug ?? node.title,
      status: node.status === "done"
        ? "completed"
        : node.status === "ready"
          ? "pending"
          : node.status as ApiDagNode["status"],
      dependencies: node.dependsOn,
      dependents: dependents.get(node.id) ?? [],
      session: apiSession,
    }
  }

  const dagStatus = graph.nodes.every((n) => n.status === "done")
    ? "completed"
    : graph.nodes.some((n) => n.status === "failed")
      ? "failed"
      : graph.nodes.some((n) => n.status === "running")
        ? "running"
        : "pending"

  return {
    id: graph.id,
    rootTaskId: graph.parentThreadId.toString(),
    nodes,
    status: dagStatus,
    createdAt: new Date(graph.createdAt).toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

export interface ApiServerOptions {
  port: number
  uiDistPath: string
  /** Telegram chat id — only present when a TelegramConnector is registered. */
  chatId?: string
  /** Telegram bot token — only present when a TelegramConnector is registered. */
  botToken?: string
  broadcaster: StateBroadcaster
  apiToken?: string
  corsAllowedOrigins?: string[]
  repos?: Record<string, string>
  /** Web Push store + keys. When absent, push endpoints return 503. */
  pushSubscriptions?: PushSubscriptionStore
  vapidKeys?: VapidKeys
}

function resolveOrigin(req: http.IncomingMessage, allowed?: string[]): string | null {
  if (!allowed || allowed.length === 0) return "*"
  const origin = req.headers["origin"]
  if (origin && allowed.includes(origin)) return origin
  return null
}

function requireAuth(req: http.IncomingMessage, res: http.ServerResponse, token?: string): boolean {
  if (!token) return true
  if (req.method === "OPTIONS") return true
  const url = new URL(req.url ?? "", "http://x")
  if (url.pathname === "/validate") return true
  if (url.pathname === "/api/version" && req.method === "GET") return true
  if (url.pathname === "/api/health" && req.method === "GET") return true

  const authHeader = req.headers["authorization"]
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined
  const queryToken = url.searchParams.get("token") ?? undefined

  if (bearer === token || queryToken === token) return true

  res.writeHead(401, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ data: null, error: "unauthorized" }))
  return false
}

export function createApiServer(
  dispatcher: DispatcherApi,
  options: ApiServerOptions,
): http.Server {
  const { port, uiDistPath, chatId, botToken, broadcaster, apiToken, corsAllowedOrigins, repos, pushSubscriptions, vapidKeys } = options
  const sseClients = new Set<http.ServerResponse>()

  broadcaster.on("event", (event: SseEvent) => {
    const data = `data: ${JSON.stringify(event)}\n\n`
    for (const client of sseClients) {
      client.write(data)
    }
  })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`)

    const origin = resolveOrigin(req, corsAllowedOrigins)
    if (origin === "*") {
      res.setHeader("Access-Control-Allow-Origin", "*")
    } else if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin)
      res.setHeader("Vary", "Origin")
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Cache-Control, Last-Event-ID")
    res.setHeader("Access-Control-Max-Age", "600")

    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    if (url.pathname.startsWith("/api/")) {
      if (!requireAuth(req, res, apiToken)) return
      await handleApiRoute(req, res, url, dispatcher, chatId, sseClients, repos, pushSubscriptions, vapidKeys)
      return
    }

    if (url.pathname === "/validate") {
      if (!botToken || !chatId) {
        res.writeHead(503, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Telegram login is not configured on this minion" }))
        return
      }
      await handleValidation(req, res, chatId, botToken)
      return
    }

    await serveStatic(req, res, url, uiDistPath)
  })

  return server
}

async function handleApiRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  dispatcher: DispatcherApi,
  chatId: string | undefined,
  sseClients: Set<http.ServerResponse>,
  repos?: Record<string, string>,
  pushSubscriptions?: PushSubscriptionStore,
  vapidKeys?: VapidKeys,
): Promise<void> {
  const pathname = url.pathname

  try {
    // GET /api/sessions
    if (pathname === "/api/sessions" && req.method === "GET") {
      const sessions = dispatcher.getSessions()
      const topicSessions = dispatcher.getTopicSessions()
      const apiSessions: ApiSession[] = []

      for (const [threadId, session] of topicSessions) {
        const activeSession = sessions.get(threadId)
        const state = dispatcher.getSessionState(threadId)
        apiSessions.push(topicSessionToApi(session, chatId, activeSession?.meta.sessionId, state))
      }

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ data: apiSessions }))
      return
    }

    // GET /api/sessions/:id
    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (sessionMatch && req.method === "GET") {
      const slug = sessionMatch[1]
      const topicSessions = dispatcher.getTopicSessions()

      for (const [threadId, session] of topicSessions) {
        if (session.slug === slug) {
          const sessions = dispatcher.getSessions()
          const activeSession = sessions.get(threadId)
          const state = dispatcher.getSessionState(threadId)
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ data: topicSessionToApi(session, chatId, activeSession?.meta.sessionId, state) }))
          return
        }
      }

      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ data: null, error: "Session not found" }))
      return
    }

    // GET /api/sessions/:id/diff
    const diffMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/diff$/)
    if (diffMatch && req.method === "GET") {
      const slug = diffMatch[1]
      const session = [...dispatcher.getTopicSessions().values()].find((s) => s.slug === slug)
      if (!session || !session.cwd) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "Session not found" }))
        return
      }
      try {
        const diff = await computeWorkspaceDiff(session.cwd, session.branch)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: diff }))
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: err instanceof Error ? err.message : String(err) }))
      }
      return
    }

    // GET /api/sessions/:id/screenshots — list captured PNGs
    const screenshotsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/screenshots$/)
    if (screenshotsMatch && req.method === "GET") {
      const slug = screenshotsMatch[1]
      const session = [...dispatcher.getTopicSessions().values()].find((s) => s.slug === slug)
      if (!session || !session.cwd) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "Session not found" }))
        return
      }
      const screenshots = await listSessionScreenshots(session.cwd)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        data: {
          screenshots: screenshots.map((s) => ({
            ...s,
            url: `/api/sessions/${slug}/screenshots/${encodeURIComponent(s.filename)}`,
          })),
        },
      }))
      return
    }

    // GET /api/sessions/:id/screenshots/:filename — stream the PNG
    const screenshotFileMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/screenshots\/([^/]+)$/)
    if (screenshotFileMatch && req.method === "GET") {
      const [, slug, rawName] = screenshotFileMatch
      const filename = decodeURIComponent(rawName)
      const session = [...dispatcher.getTopicSessions().values()].find((s) => s.slug === slug)
      if (!session || !session.cwd) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "Session not found" }))
        return
      }
      const absPath = resolveScreenshotPath(session.cwd, filename)
      if (!absPath) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "Invalid screenshot filename" }))
        return
      }
      try {
        const data = await fs.promises.readFile(absPath)
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": data.length,
          "Cache-Control": "private, max-age=300",
        })
        res.end(data)
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "Screenshot not found" }))
      }
      return
    }

    // GET /api/sessions/:slug/transcript?after=<seq> — structured transcript snapshot
    const transcriptMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/transcript$/)
    if (transcriptMatch && req.method === "GET") {
      const slug = transcriptMatch[1]
      const session = [...dispatcher.getTopicSessions().values()].find((s) => s.slug === slug)
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "Session not found" }))
        return
      }
      if (!dispatcher.getTranscript) {
        res.writeHead(501, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "Transcript is not available on this minion" }))
        return
      }

      const afterParam = url.searchParams.get("after")
      let afterSeq = -1
      if (afterParam !== null) {
        const parsed = Number(afterParam)
        if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < -1) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ data: null, error: "after must be an integer >= -1" }))
          return
        }
        afterSeq = parsed
      }

      const snapshot = dispatcher.getTranscript(slug, afterSeq)
      if (!snapshot) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "Session not found" }))
        return
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      })
      res.end(JSON.stringify({ data: snapshot }))
      return
    }

    // GET /api/sessions/:id/pr — pull request preview card (gh pr view + checks)
    const prMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/pr$/)
    if (prMatch && req.method === "GET") {
      const slug = prMatch[1]
      const session = [...dispatcher.getTopicSessions().values()].find((s) => s.slug === slug)
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "Session not found" }))
        return
      }
      if (!session.prUrl) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "Session has no open PR" }))
        return
      }
      try {
        const preview = await fetchPrPreview(session.prUrl)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: preview }))
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: err instanceof Error ? err.message : String(err) }))
      }
      return
    }

    // GET /api/dags
    if (pathname === "/api/dags" && req.method === "GET") {
      const dags = dispatcher.getDags()
      const topicSessions = dispatcher.getTopicSessions()
      const sessions = dispatcher.getSessions()
      const apiDags: ApiDagGraph[] = []

      for (const graph of dags.values()) {
        apiDags.push(dagToApi(graph, topicSessions, sessions, chatId))
      }

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ data: apiDags }))
      return
    }

    // GET /api/dags/:id
    const dagMatch = pathname.match(/^\/api\/dags\/([^/]+)$/)
    if (dagMatch && req.method === "GET") {
      const dagId = dagMatch[1]
      const dag = dispatcher.getDags().get(dagId)

      if (dag) {
        const topicSessions = dispatcher.getTopicSessions()
        const sessions = dispatcher.getSessions()
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: dagToApi(dag, topicSessions, sessions, chatId) }))
        return
      }

      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ data: null, error: "DAG not found" }))
      return
    }

    // POST /api/commands
    if (pathname === "/api/commands" && req.method === "POST") {
      const body = await readBody(req)
      const command = JSON.parse(body) as MinionCommand

      // Find the thread ID from the session ID (slug)
      const topicSessions = dispatcher.getTopicSessions()
      let threadId: number | undefined

      for (const [tid, session] of topicSessions) {
        if (session.slug === command.sessionId || tid.toString() === command.sessionId) {
          threadId = tid
          break
        }
      }

      if (!threadId) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: false, error: "Session not found" }))
        return
      }

      try {
        switch (command.action) {
          case "reply":
            await dispatcher.sendReply(threadId, command.message)
            break
          case "stop":
            dispatcher.stopSession(threadId)
            break
          case "close":
            await dispatcher.closeSession(threadId)
            break
          case "plan_action": {
            const actionCommands: Record<PlanActionType, string> = {
              execute: "/execute",
              split: "/split",
              stack: "/stack",
              dag: "/dag",
            }
            const replyText = actionCommands[command.planAction]
            if (!replyText) {
              res.writeHead(400, { "Content-Type": "application/json" })
              res.end(JSON.stringify({ success: false, error: `Invalid plan action: ${command.planAction}` }))
              return
            }
            await dispatcher.sendReply(threadId, replyText)
            break
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: true }))
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: false, error: String(err) }))
      }
      return
    }

    // GET /api/events (SSE)
    if (pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      })
      res.flushHeaders()

      sseClients.add(res)

      res.write(": connected\n\n")

      req.on("close", () => {
        sseClients.delete(res)
      })
      return
    }

    // GET /api/push/vapid-public-key
    if (pathname === "/api/push/vapid-public-key" && req.method === "GET") {
      if (!vapidKeys) {
        res.writeHead(503, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "Web Push is not configured on this minion" }))
        return
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ data: { publicKey: vapidKeys.publicKey } }))
      return
    }

    // POST /api/push-subscribe
    if (pathname === "/api/push-subscribe" && req.method === "POST") {
      if (!pushSubscriptions) {
        res.writeHead(503, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "Web Push is not configured on this minion" }))
        return
      }
      const body = await readBody(req)
      let parsed: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
      try {
        parsed = JSON.parse(body) as typeof parsed
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "invalid JSON body" }))
        return
      }
      const endpoint = typeof parsed.endpoint === "string" ? parsed.endpoint : ""
      const p256dh = typeof parsed.keys?.p256dh === "string" ? parsed.keys.p256dh : ""
      const auth = typeof parsed.keys?.auth === "string" ? parsed.keys.auth : ""
      if (!endpoint || !p256dh || !auth) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "endpoint + keys.p256dh + keys.auth are required" }))
        return
      }
      await pushSubscriptions.add({ endpoint, keys: { p256dh, auth } })
      res.writeHead(201, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ data: { subscribed: true } }))
      return
    }

    // DELETE /api/push-subscribe
    if (pathname === "/api/push-subscribe" && req.method === "DELETE") {
      if (!pushSubscriptions) {
        res.writeHead(503, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "Web Push is not configured on this minion" }))
        return
      }
      const body = await readBody(req)
      let parsed: { endpoint?: unknown }
      try {
        parsed = JSON.parse(body) as typeof parsed
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "invalid JSON body" }))
        return
      }
      const endpoint = typeof parsed.endpoint === "string" ? parsed.endpoint : ""
      if (!endpoint) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "endpoint is required" }))
        return
      }
      const removed = await pushSubscriptions.remove(endpoint)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ data: { removed } }))
      return
    }

    // POST /api/sessions/variants — spawn N parallel variants of one prompt.
    if (pathname === "/api/sessions/variants" && req.method === "POST") {
      const body = await readBody(req)
      let parsed: Partial<CreateSessionRequest & { count?: unknown }>
      try {
        parsed = JSON.parse(body) as Partial<CreateSessionRequest & { count?: unknown }>
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "invalid JSON body" }))
        return
      }

      const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : ""
      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "prompt is required" }))
        return
      }

      const count = typeof parsed.count === "number" ? parsed.count : 0
      if (!Number.isInteger(count) || count < 2 || count > 10) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "count must be an integer between 2 and 10" }))
        return
      }

      const allowedModes: CreateSessionMode[] = ["task", "plan", "think", "review", "ship-think"]
      const mode = parsed.mode
      if (mode !== undefined && !allowedModes.includes(mode)) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: `mode must be one of ${allowedModes.join(", ")}` }))
        return
      }

      try {
        const results = await dispatcher.createSessionVariants(
          {
            repo: typeof parsed.repo === "string" ? parsed.repo : undefined,
            prompt,
            mode,
            profileId: typeof parsed.profileId === "string" ? parsed.profileId : undefined,
          },
          count,
        )
        const sessions = results.map((r) =>
          "slug" in r
            ? { sessionId: r.slug, slug: r.slug, threadId: r.threadId }
            : { error: r.error },
        )
        res.writeHead(201, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: { sessions } }))
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: err instanceof Error ? err.message : String(err) }))
      }
      return
    }

    // POST /api/sessions — create a session without parsing a /task string.
    if (pathname === "/api/sessions" && req.method === "POST") {
      const body = await readBody(req)
      let parsed: Partial<CreateSessionRequest>
      try {
        parsed = JSON.parse(body) as Partial<CreateSessionRequest>
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "invalid JSON body" }))
        return
      }

      const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : ""
      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "prompt is required" }))
        return
      }

      const allowedModes: CreateSessionMode[] = ["task", "plan", "think", "review", "ship-think"]
      const mode = parsed.mode
      if (mode !== undefined && !allowedModes.includes(mode)) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: `mode must be one of ${allowedModes.join(", ")}` }))
        return
      }

      try {
        const { slug, threadId } = await dispatcher.createSession({
          repo: typeof parsed.repo === "string" ? parsed.repo : undefined,
          prompt,
          mode,
          profileId: typeof parsed.profileId === "string" ? parsed.profileId : undefined,
        })
        res.writeHead(201, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: { sessionId: slug, slug, threadId } }))
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: err instanceof Error ? err.message : String(err) }))
      }
      return
    }

    // POST /api/messages
    if (pathname === "/api/messages" && req.method === "POST") {
      const body = await readBody(req)
      const parsed = JSON.parse(body) as { text?: unknown; sessionId?: unknown }
      const text = typeof parsed.text === "string" ? parsed.text.trim() : ""
      if (!text) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ data: null, error: "text required" }))
        return
      }
      const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : undefined
      await dispatcher.handleIncomingText(text, sessionId)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ data: { ok: true, sessionId: sessionId ?? null } }))
      return
    }

    // GET /api/health — unauthenticated liveness probe for orchestration tools.
    if (pathname === "/api/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ data: { status: "ok" } }))
      return
    }

    // GET /api/version
    if (pathname === "/api/version" && req.method === "GET") {
      const repoList = repos
        ? Object.entries(repos).map(([alias, url]) => ({ alias, url }))
        : []
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        data: {
          apiVersion: "1",
          libraryVersion: pkg.version,
          features: [
            "messages",
            "auth",
            "cors-allowlist",
            "repos",
            "sessions-create",
            "diff-viewer",
            "screenshots-http",
            "pr-preview",
            "parallel-variants",
            ...(vapidKeys ? ["web-push"] : []),
            ...(dispatcher.getTranscript ? ["transcript"] : []),
          ],
          repos: repoList,
        },
      }))
      return
    }

    // 404 for unknown API routes
    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ data: null, error: "Not found" }))
  } catch (err) {
    log.error({ err, pathname }, "error handling request")
    res.writeHead(500, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ data: null, error: "Internal server error" }))
  }
}

async function handleValidation(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  expectedChatId: string,
  botToken: string,
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "Method not allowed" }))
    return
  }

  try {
    const body = await readBody(req)
    const { initData } = JSON.parse(body) as { initData?: string }

    if (!initData) {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ valid: false, error: "Missing initData" }))
      return
    }

    // Validate HMAC signature
    if (!validateTelegramInitData(initData, botToken)) {
      res.writeHead(403, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ valid: false, error: "Invalid signature" }))
      return
    }

    // Parse Telegram init data
    const params = new URLSearchParams(initData)
    const chatId = params.get("chat_id") ?? params.get("chat")?.split(":")[0]

    if (chatId !== expectedChatId) {
      res.writeHead(403, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ valid: false, error: "Unauthorized chat" }))
      return
    }

    // Check auth_date is recent (within 24 hours)
    const authDate = params.get("auth_date")
    if (authDate) {
      const authTimestamp = parseInt(authDate, 10) * 1000
      const now = Date.now()
      const maxAge = 24 * 60 * 60 * 1000 // 24 hours

      if (now - authTimestamp > maxAge) {
        res.writeHead(403, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ valid: false, error: "Init data expired" }))
        return
      }
    }

    const user = params.get("user")
    const userData = user ? JSON.parse(user) : null

    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({
      valid: true,
      user: userData ? {
        id: userData.id,
        username: userData.username,
        firstName: userData.first_name,
      } : null,
    }))
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ valid: false, error: String(err) }))
  }
}

/**
 * Validates Telegram WebApp init data using HMAC-SHA256.
 * @see https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
 */
export function validateTelegramInitData(initData: string, botToken: string): boolean {
  const params = new URLSearchParams(initData)
  const hash = params.get("hash")

  if (!hash) {
    return false
  }

  // SHA256 produces 32 bytes = 64 hex characters
  const expectedHashLength = 64
  if (hash.length !== expectedHashLength) {
    return false
  }

  // Remove hash from params for signature calculation
  params.delete("hash")

  // Sort keys alphabetically and create data-check string
  const keys = Array.from(params.keys()).sort()
  const dataCheckString = keys
    .map((key) => `${key}=${params.get(key)}`)
    .join("\n")

  // Create secret key: HMAC-SHA256(botToken, "WebAppData")
  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest()

  // Calculate signature: HMAC-SHA256(secretKey, dataCheckString)
  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex")

  // Use timing-safe comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(calculatedHash, "hex"),
      Buffer.from(hash, "hex"),
    )
  } catch {
    // Buffer comparison failed (e.g., invalid hex encoding)
    return false
  }
}

async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  uiDistPath: string,
): Promise<void> {
  let filePath = url.pathname

  // Serve index.html for root and SPA routes
  if (filePath === "/" || !filePath.includes(".")) {
    filePath = "/index.html"
  }

  const fullPath = path.join(uiDistPath, filePath)

  // Security: prevent directory traversal
  const normalized = path.normalize(fullPath)
  if (!normalized.startsWith(uiDistPath)) {
    res.writeHead(403)
    res.end("Forbidden")
    return
  }

  try {
    const stat = await fs.promises.stat(normalized)

    if (stat.isDirectory()) {
      // Serve index.html for directories
      const indexPath = path.join(normalized, "index.html")
      try {
        await fs.promises.stat(indexPath)
        await serveFile(indexPath, res)
      } catch {
        res.writeHead(404)
        res.end("Not found")
      }
      return
    }

    await serveFile(normalized, res)
  } catch {
    // For SPA, serve index.html for any not-found route
    if (!url.pathname.includes(".")) {
      try {
        await serveFile(path.join(uiDistPath, "index.html"), res)
        return
      } catch {
        // Fall through to 404
      }
    }

    res.writeHead(404)
    res.end("Not found")
  }
}

async function serveFile(filePath: string, res: http.ServerResponse): Promise<void> {
  const content = await fs.promises.readFile(filePath)
  const mimeType = getMimeType(filePath)

  res.writeHead(200, {
    "Content-Type": mimeType,
    "Cache-Control": mimeType === "text/html" ? "no-cache" : "public, max-age=31536000",
  })
  res.end(content)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk as Buffer))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
    req.on("error", reject)
  })
}
