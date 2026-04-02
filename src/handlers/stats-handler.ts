import type { CompletionHandler, SessionCompletionContext } from "./handler-types.js"
import type { StatsTracker } from "../stats.js"

export class StatsHandler implements CompletionHandler {
  readonly name = "StatsHandler"

  constructor(private readonly stats: StatsTracker) {}

  async handle(ctx: SessionCompletionContext): Promise<void> {
    const { topicSession, state, durationMs, meta } = ctx
    await this.stats.record({
      slug: topicSession.slug,
      repo: topicSession.repo,
      mode: topicSession.mode,
      state: state === "quota_exhausted" ? "errored" : state,
      durationMs,
      totalTokens: meta.totalTokens ?? 0,
      timestamp: Date.now(),
    })
  }
}
