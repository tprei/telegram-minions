import type { MinionEngine } from "../engine/engine.js"

/**
 * Connector — the pluggable I/O surface for a MinionEngine.
 *
 * A connector attaches to the engine to:
 *   - observe engine events (session lifecycle, assistant output, DAG state)
 *     and translate them into its channel's semantics (Telegram messages,
 *     SSE frames, Slack posts, TTY output, …)
 *   - inject user input back into the engine (replies, commands, new tasks)
 *
 * Implementations are added via `engine.use(connector)` or composed through
 * `createMinion(config)`. Multiple connectors can coexist: the engine is the
 * shared source of truth, connectors are independent fan-outs.
 */
export interface Connector {
  /** Stable identifier for the connector. Used for diagnostics and for keeping
   *  per-connector state on sessions (see `TopicSession.connectorState`
   *  introduced in Phase 3). */
  readonly name: string

  /** Called once when the connector is registered with the engine.
   *  Subscribe to engine events, open channel connections, and stash an
   *  engine reference if you need to call back (e.g. `engine.sendInput`). */
  attach(engine: MinionEngine): void | Promise<void>

  /** Called when the engine shuts down or the connector is unregistered.
   *  Release all event subscriptions and close channel resources. */
  detach(): void | Promise<void>
}
