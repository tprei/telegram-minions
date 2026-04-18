import type { Connector } from "./connector.js"
import type { MinionEngine } from "../engine/engine.js"
import { TelegramClient } from "../telegram/telegram.js"
import { TelegramPlatform } from "../telegram/telegram-platform.js"

export interface TelegramConnectorOptions {
  botToken: string
  chatId: string
  /** Minimum spacing between outbound sends — tuned for Telegram's ~30 msg/sec cap. */
  minSendIntervalMs?: number
}

/**
 * TelegramConnector — bundles the Telegram I/O surface for a MinionEngine.
 *
 * Owns the Telegram client and the `ChatPlatform` adapter. Future phases will
 * migrate Observer formatting and the `TelegramInputSource` poll loop into
 * here so the engine can boot without any Telegram credentials.
 *
 * For Phase 1, the connector holds these resources and exposes them so
 * `createMinion` can hand them to the engine; attach/detach are wired for
 * the event subscriptions that will land in Phase 2.
 */
export class TelegramConnector implements Connector {
  readonly name = "telegram"
  readonly client: TelegramClient
  readonly platform: TelegramPlatform
  private subscriptions: Array<() => void> = []

  constructor(opts: TelegramConnectorOptions) {
    this.client = new TelegramClient(opts.botToken, opts.chatId, opts.minSendIntervalMs)
    this.platform = new TelegramPlatform(this.client, opts.chatId)
  }

  attach(_engine: MinionEngine): void {
    // Phase 1: engine still owns Observer + ChatPlatform wiring directly.
    // Phase 2 will move subscribe-side work here (e.g. posting formatted
    // assistant_text/activity to Telegram in response to engine events).
    void _engine
  }

  detach(): void {
    for (const unsub of this.subscriptions) unsub()
    this.subscriptions = []
  }
}
