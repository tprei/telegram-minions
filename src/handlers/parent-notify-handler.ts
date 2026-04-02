import type { TopicSession } from "../types.js"
import type { CompletionHandler, SessionCompletionContext } from "./handler-types.js"
import { createLogger } from "../logger.js"

const log = createLogger({ component: "parent-notify-handler" })

export interface ParentNotifier {
  notifyParentOfChildComplete(childSession: TopicSession, state: string): Promise<void>
}

export class ParentNotifyHandler implements CompletionHandler {
  readonly name = "ParentNotifyHandler"

  constructor(private readonly notifier: ParentNotifier) {}

  async handle(ctx: SessionCompletionContext): Promise<void> {
    try {
      await this.notifier.notifyParentOfChildComplete(ctx.topicSession, ctx.state)
    } catch (err) {
      log.warn({ err, slug: ctx.topicSession.slug }, "parent notify error")
    }
  }
}
