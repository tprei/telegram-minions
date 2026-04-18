import http from "node:http"
import type { Connector } from "./connector.js"
import type { MinionEngine } from "../engine/engine.js"
import {
  createApiServer,
  StateBroadcaster,
  topicSessionToApi,
  dagToApi,
  type DispatcherApi,
} from "../api-server.js"

export interface HttpConnectorOptions {
  port: number
  uiDistPath: string
  /** Telegram chat id — embedded into t.me links in ApiSession payloads
   *  when a TelegramConnector is also registered. Leave undefined for
   *  PWA-only deployments. */
  chatId?: string
  /** Telegram bot token — enables the /validate endpoint used by the
   *  Telegram WebApp login flow. Leave undefined for PWA-only deployments. */
  botToken?: string
  apiToken?: string
  corsAllowedOrigins?: string[]
  repos?: Record<string, string>
}

/**
 * HttpConnector — serves the REST/SSE API and PWA assets.
 *
 * On attach, subscribes to MinionEngine event bus and translates engine
 * events into `SseEvent`s that the PWA consumes. Replaces the earlier
 * pattern where MinionEngine pushed SSE frames directly through a
 * StateBroadcaster handed in at construction time.
 *
 * The connector owns the broadcaster + http.Server. `start()` binds the
 * port (done separately from attach() so orchestration can control when
 * the port opens relative to engine warm-up).
 */
export class HttpConnector implements Connector {
  readonly name = "http"
  readonly broadcaster: StateBroadcaster
  private server: http.Server | null = null
  private subscriptions: Array<() => void> = []

  constructor(private readonly opts: HttpConnectorOptions) {
    this.broadcaster = new StateBroadcaster()
  }

  attach(engine: MinionEngine): void {
    const chatId = this.opts.chatId
    const topicSessions = engine.getTopicSessions()
    const activeSessions = engine.getSessions()

    this.subscriptions.push(
      engine.events.on("session_created", (e) => {
        const api = topicSessionToApi(e.session, chatId, e.session.activeSessionId)
        this.broadcaster.broadcast({ type: "session_created", session: api })
      }),
      engine.events.on("session_updated", (e) => {
        const api = topicSessionToApi(e.session, chatId, e.session.activeSessionId, e.sessionState)
        this.broadcaster.broadcast({ type: "session_updated", session: api })
      }),
      engine.events.on("session_deleted", (e) => {
        this.broadcaster.broadcast({ type: "session_deleted", sessionId: e.sessionId })
      }),
      engine.events.on("dag_created", (e) => {
        const api = dagToApi(e.dag, topicSessions, activeSessions, chatId)
        this.broadcaster.broadcast({ type: "dag_created", dag: api })
      }),
      engine.events.on("dag_updated", (e) => {
        const api = dagToApi(e.dag, topicSessions, activeSessions, chatId)
        this.broadcaster.broadcast({ type: "dag_updated", dag: api })
      }),
      engine.events.on("dag_deleted", (e) => {
        this.broadcaster.broadcast({ type: "dag_deleted", dagId: e.dagId })
      }),
    )

    const dispatcherApi: DispatcherApi = {
      getSessions: () => engine.getSessions(),
      getTopicSessions: () => engine.getTopicSessions(),
      getDags: () => engine.getDags(),
      getSessionState: (threadId) => engine.getSessionState(threadId),
      sendReply: (threadId, message) => engine.apiSendReply(threadId, message),
      stopSession: (threadId) => engine.apiStopSession(threadId),
      closeSession: (threadId) => engine.apiCloseSession(threadId),
      handleIncomingText: (text, sessionSlug) => engine.handleIncomingText(text, sessionSlug),
    }

    this.server = createApiServer(dispatcherApi, {
      port: this.opts.port,
      uiDistPath: this.opts.uiDistPath,
      chatId: this.opts.chatId,
      botToken: this.opts.botToken,
      broadcaster: this.broadcaster,
      apiToken: this.opts.apiToken,
      corsAllowedOrigins: this.opts.corsAllowedOrigins,
      repos: this.opts.repos,
    })
  }

  /** Bind the HTTP server to its port. Must be called after attach(). */
  async start(): Promise<void> {
    if (!this.server) throw new Error("HttpConnector.start() called before attach()")
    const server = this.server
    const port = this.opts.port
    await new Promise<void>((resolve) => {
      server.listen(port, () => resolve())
    })
  }

  detach(): void {
    for (const unsub of this.subscriptions) unsub()
    this.subscriptions = []
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  getServer(): http.Server | null {
    return this.server
  }
}
