import type { TopicSession } from "../types.js"
import type { CompletionHandler, SessionCompletionContext } from "./handler-types.js"
import type { QualityReport } from "../ci/quality-gates.js"
import { captureException } from "../sentry.js"
import { createLogger } from "../logger.js"

const log = createLogger({ component: "ci-babysit-handler" })

export interface CIBabysitter {
  queueDeferredBabysit(parentThreadId: number, opts: { childSession: TopicSession; prUrl: string; qualityReport?: QualityReport }): void
  babysitPR(topicSession: TopicSession, prUrl: string, qualityReport?: QualityReport): Promise<void>
}

export interface CIBabysitConfig {
  babysitEnabled: boolean
}

export class CIBabysitHandler implements CompletionHandler {
  readonly name = "CIBabysitHandler"

  constructor(
    private readonly ciConfig: CIBabysitConfig,
    private readonly ciBabysitter: CIBabysitter,
  ) {}

  async handle(ctx: SessionCompletionContext): Promise<void> {
    if (ctx.state !== "completed") return
    if (ctx.topicSession.mode !== "task") return
    if (!ctx.prUrl) return
    if (!this.ciConfig.babysitEnabled) return

    const { topicSession, prUrl, qualityReport } = ctx

    if (topicSession.dagId) {
      // DAG children: CI is handled inline in onDagChildComplete
      return
    }

    if (topicSession.parentThreadId) {
      this.ciBabysitter.queueDeferredBabysit(topicSession.parentThreadId, {
        childSession: topicSession,
        prUrl,
        qualityReport,
      })
    } else {
      this.ciBabysitter.babysitPR(topicSession, prUrl, qualityReport).catch((err) => {
        log.error({ err, prUrl }, "babysitPR error")
        captureException(err, { operation: "babysitPR", prUrl })
      })
    }
  }
}
