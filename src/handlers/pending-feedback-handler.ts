import type { TopicSession } from "../types.js"
import type { CompletionHandler, SessionCompletionContext } from "./handler-types.js"
import { createLogger } from "../logger.js"

const log = createLogger({ component: "pending-feedback-handler" })

export interface FeedbackProcessor {
  handleTopicFeedback(topicSession: TopicSession, feedback: string): Promise<void>
}

export class PendingFeedbackHandler implements CompletionHandler {
  readonly name = "PendingFeedbackHandler"

  constructor(private readonly feedbackProcessor: FeedbackProcessor) {}

  async handle(ctx: SessionCompletionContext): Promise<void> {
    const { topicSession } = ctx

    if (topicSession.pendingFeedback.length === 0) return

    const feedback = topicSession.pendingFeedback.join("\n\n")
    topicSession.pendingFeedback = []

    try {
      await this.feedbackProcessor.handleTopicFeedback(topicSession, feedback)
    } catch (err) {
      log.error({ err }, "queued feedback error")
    }
  }
}
