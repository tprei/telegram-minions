import http from "node:http"
import type { MinionConfig } from "./config-types.js"
import { StatsTracker } from "./stats.js"
import type { Dispatcher } from "./dispatcher.js"
import { dagProgress } from "./dag.js"
import { TelegramClient } from "./telegram.js"
import { parseBody } from "./http-utils.js"

export interface SessionApiResponse {
  threadId: number
  slug: string
  repo: string
  mode: string
  status: "active" | "idle"
  task: string
  startedAt: number
  lastActivityAt: number
  dagId?: string
  dagNodeId?: string
  parentThreadId?: number
  childThreadIds?: number[]
}

export interface DagNodeApiResponse {
  id: string
  title: string
  description: string
  dependsOn: string[]
  status: string
  threadId?: number
  branch?: string
  prUrl?: string
  error?: string
}

export interface DagApiResponse {
  id: string
  nodes: DagNodeApiResponse[]
  parentThreadId: number
  repo: string
  repoUrl?: string
  createdAt: number
  progress: {
    total: number
    done: number
    running: number
    ready: number
    pending: number
    failed: number
    skipped: number
  }
}

export interface StatsApiResponse {
  totalSessions: number
  completedSessions: number
  erroredSessions: number
  activeSessions: number
  idleSessions: number
  totalTokens: number
}

export interface CommandResponse {
  success: boolean
  message?: string
}

export type ApiHttpMethod = "GET" | "POST"

export interface ApiRequest {
  method: ApiHttpMethod
  path: string
  query?: Record<string, string>
  body?: unknown
}

export type ApiHandler = (req: ApiRequest) => Promise<unknown>

export class ApiServer {
  private readonly config: MinionConfig
  private readonly telegram: TelegramClient
  private readonly dispatcher: Dispatcher
  private readonly stats: StatsTracker
  private server?: http.Server
  private readonly token?: string

  constructor(
    config: MinionConfig,
    telegram: TelegramClient,
    dispatcher: Dispatcher
  ) {
    this.config = config
    this.telegram = telegram
    this.dispatcher = dispatcher
    this.stats = new StatsTracker(config.workspace.root)
    this.token = config.api?.apiToken ?? process.env["API_TOKEN"]
  }

  start(): void {
    const port = this.config.api?.port ?? 3000
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        process.stderr.write(`api-server: error handling request: ${err}\n`)
        res.writeHead(500)
        res.end(JSON.stringify({ error: "Internal server error" }))
      })
    })
    this.server.listen(port, () => {
      process.stderr.write(`api-server: listening on port ${port}\n`)
    })
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      process.stderr.write(`api-server: closed\n`)
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    const path = url.pathname

    if (this.token && req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401)
      res.end(JSON.stringify({ error: "Unauthorized" }))
      return
    }

    res.setHeader("Content-Type", "application/json")
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")

    if (req.method === "OPTIONS") {
      res.writeHead(200)
      res.end()
      return
    }

    let body: unknown
    if (req.method === "POST") {
      try {
        body = await parseBody(req)
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
        return
      }
    }

    const method = req.method as ApiHttpMethod
    const apiReq: ApiRequest = { method, path, query: Object.fromEntries(url.searchParams), body }

    try {
      const result = await this.route(apiReq)
      res.writeHead(200)
      res.end(JSON.stringify(result))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.writeHead(400)
      res.end(JSON.stringify({ error: message }))
    }
  }

  private async route(req: ApiRequest): Promise<unknown> {
    const { method, path, body } = req

    if (method === "GET" && path === "/api/sessions") {
      return this.getSessions()
    }

    if (method === "GET" && path === "/api/dags") {
      return this.getDags()
    }

    if (method === "GET" && path.startsWith("/api/dags/")) {
      const id = path.slice("/api/dags/".length)
      return this.getDag(id)
    }

    if (method === "GET" && path === "/api/stats") {
      return this.getStats()
    }

    if (method === "POST" && path === "/api/commands") {
      if (!body) throw new Error("Missing request body")
      return this.handleCommand(body as { action: string; threadId?: number; text?: string })
    }

    throw new Error(`Unknown route: ${method} ${path}`)
  }

  private getSessions(): { sessions: SessionApiResponse[] } {
    const topicSessions = this.dispatcher.getTopicSessions()
    const sessions = Array.from(topicSessions.values()).map((session): SessionApiResponse => {
      const activeSession = this.dispatcher.getSessions().get(session.threadId)
      return {
        threadId: session.threadId,
        slug: session.slug,
        repo: session.repo,
        mode: session.mode,
        status: activeSession ? "active" : "idle",
        task: session.conversation[0]?.text ?? "",
        startedAt: session.conversation[0] ? 0 : Date.now(),
        lastActivityAt: session.lastActivityAt,
        dagId: session.dagId,
        dagNodeId: session.dagNodeId,
        parentThreadId: session.parentThreadId,
        childThreadIds: session.childThreadIds,
      }
    })
    return { sessions }
  }

  private getDags(): { dags: DagApiResponse[] } {
    const dags = this.dispatcher.getDags()
    const result = Array.from(dags.values()).map((graph): DagApiResponse => {
      const progress = dagProgress(graph)
      return {
        id: graph.id,
        nodes: graph.nodes.map((node): DagNodeApiResponse => ({
          id: node.id,
          title: node.title,
          description: node.description,
          dependsOn: node.dependsOn,
          status: node.status,
          threadId: node.threadId,
          branch: node.branch,
          prUrl: node.prUrl,
          error: node.error,
        })),
        parentThreadId: graph.parentThreadId,
        repo: graph.repo,
        repoUrl: graph.repoUrl,
        createdAt: graph.createdAt,
        progress: {
          total: progress.total,
          done: progress.done,
          running: progress.running,
          ready: progress.ready,
          pending: progress.pending,
          failed: progress.failed,
          skipped: progress.skipped,
        },
      }
    })
    return { dags: result }
  }

  private getDag(id: string): DagApiResponse {
    const dag = this.dispatcher.getDags().get(id)
    if (!dag) throw new Error(`DAG not found: ${id}`)
    const progress = dagProgress(dag)
    return {
      id: dag.id,
      nodes: dag.nodes.map((node): DagNodeApiResponse => ({
        id: node.id,
        title: node.title,
        description: node.description,
        dependsOn: node.dependsOn,
        status: node.status,
        threadId: node.threadId,
        branch: node.branch,
        prUrl: node.prUrl,
        error: node.error,
      })),
      parentThreadId: dag.parentThreadId,
      repo: dag.repo,
      repoUrl: dag.repoUrl,
      createdAt: dag.createdAt,
      progress: {
        total: progress.total,
        done: progress.done,
        running: progress.running,
        ready: progress.ready,
        pending: progress.pending,
        failed: progress.failed,
        skipped: progress.skipped,
      },
    }
  }

  private async getStats(): Promise<StatsApiResponse> {
    const stats = await this.stats.aggregate()
    const sessions = this.dispatcher.getSessions()
    const topicSessions = this.dispatcher.getTopicSessions()
    const totalTokens = Array.from(sessions.values()).reduce((sum, s) => sum + (s.meta.totalTokens ?? 0), 0)
    const activeSessions = Array.from(topicSessions.values()).filter((s) => s.activeSessionId).length
    const idleSessions = topicSessions.size - activeSessions
    return {
      totalSessions: stats.totalSessions,
      completedSessions: stats.completedSessions,
      erroredSessions: stats.erroredSessions,
      activeSessions,
      idleSessions,
      totalTokens,
    }
  }

  private async handleCommand(body: { action: string; threadId?: number; text?: string }): Promise<CommandResponse> {
    const { action, threadId, text } = body

    if (action === "reply") {
      if (typeof threadId !== "number") throw new Error("threadId must be a number")
      if (typeof text !== "string") throw new Error("text must be a string")
      await this.dispatcher.handleReplyCommand(threadId, text)
      return { success: true, message: `Reply sent to thread ${threadId}` }
    }

    if (action === "stop") {
      if (typeof threadId !== "number") throw new Error("threadId must be a number")
      await this.dispatcher.handleStopCommand(threadId)
      return { success: true, message: `Stop command sent to thread ${threadId}` }
    }

    if (action === "close") {
      if (typeof threadId !== "number") throw new Error("threadId must be a number")
      await this.dispatcher.handleCloseCommand(threadId)
      return { success: true, message: `Close command sent to thread ${threadId}` }
    }

    throw new Error(`Unknown action: ${action}`)
  }
}

export function createApiServer(
  config: MinionConfig,
  telegram: TelegramClient,
  dispatcher: Dispatcher
): ApiServer {
  return new ApiServer(config, telegram, dispatcher)
}
