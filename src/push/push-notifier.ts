import webpush from "web-push"
import type { EngineEventBus } from "../engine/events.js"
import type { PushSubscriptionStore } from "./push-subscriptions.js"
import type { VapidKeys } from "./vapid-keys.js"
import { createLogger } from "../logger.js"

const log = createLogger({ component: "push-notifier" })

export interface PushPayload {
  title: string
  body: string
  tag?: string
  url?: string
}

/**
 * PushNotifier — translates engine events into Web Push notifications.
 *
 * On `session_needs_attention`, fans the payload out to every registered
 * subscription. Subscriptions returning 404/410 are pruned automatically;
 * other errors are logged and left in place (could be transient).
 */
export class PushNotifier {
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly bus: EngineEventBus,
    private readonly subscriptions: PushSubscriptionStore,
    private readonly vapid: VapidKeys,
  ) {
    webpush.setVapidDetails(this.vapid.subject, this.vapid.publicKey, this.vapid.privateKey)
  }

  attach(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.bus.on("session_needs_attention", async (event) => {
      const payload: PushPayload = {
        title: "Minion needs attention",
        body: `${event.sessionId}: ${event.reason}`,
        tag: `session-${event.sessionId}`,
        url: `/sessions/${event.sessionId}`,
      }
      await this.send(payload)
    })
  }

  detach(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  async send(payload: PushPayload): Promise<void> {
    const subs = this.subscriptions.list()
    if (subs.length === 0) return
    const body = JSON.stringify(payload)

    await Promise.all(subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          body,
        )
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode
        if (statusCode === 404 || statusCode === 410) {
          log.info({ endpoint: sub.endpoint }, "pruning gone push subscription")
          await this.subscriptions.remove(sub.endpoint)
        } else {
          log.warn({ err, endpoint: sub.endpoint }, "failed to send push")
        }
      }
    }))
  }
}
