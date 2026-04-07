import crypto from "node:crypto"
import type { DispatcherContext } from "./dispatcher-context.js"
import type { TopicSession, SessionMeta } from "../domain/session-types.js"
import type { DagGraph } from "../dag/dag.js"
import { SessionHandle, type SessionConfig } from "../session/session.js"
import { buildCompletenessReviewPrompt, parseCompletenessResult } from "../ci/verification.js"
import { extractDagItems } from "../dag/dag-extract.js"
import { buildConversationText } from "../claude-extract.js"
import { JudgeOrchestrator } from "../judge/judge-orchestrator.js"
import { esc, formatShipPhaseAdvance, formatShipComplete } from "../telegram/format.js"
import { loggers } from "../logger.js"

const log = loggers.ship

/**
 * ShipPipeline — extracted from Dispatcher.
 *
 * Owns the multi-phase ship pipeline: think → plan → dag → verify → done.
 * Each phase completes and automatically advances to the next.
 */
export class ShipPipeline {
  private readonly ctx: DispatcherContext
  private readonly judgeOrchestrator: JudgeOrchestrator

  constructor(ctx: DispatcherContext) {
    this.ctx = ctx
    this.judgeOrchestrator = new JudgeOrchestrator(ctx)
  }

  async handleShipAdvance(topicSession: TopicSession): Promise<void> {
    const advance = topicSession.autoAdvance
    if (!advance) return

    switch (advance.phase) {
      case "think":
        await this.shipAdvanceToPlanning(topicSession)
        break
      case "plan":
        await this.shipTryJudge(topicSession)
        break
      case "judge":
        break
      case "dag":
        // DAG completion is handled in onDagChildComplete
        break
      case "verify":
        await this.shipFinalize(topicSession)
        break
      case "done":
        break
    }
  }

  private async shipAdvanceToPlanning(topicSession: TopicSession): Promise<void> {
    await this.ctx.telegram.sendMessage(
      formatShipPhaseAdvance(topicSession.slug, "think", "plan"),
      topicSession.threadId,
    )

    const DAG_ASSISTANT_CHARS = 8000
    const researchText = buildConversationText(topicSession.conversation, undefined, DAG_ASSISTANT_CHARS)

    const planTask = [
      "## Feature request",
      "",
      topicSession.autoAdvance!.featureDescription,
      "",
      researchText,
      "",
      "---",
      "",
      "Based on the research above, produce a detailed DAG-ready implementation plan.",
    ].join("\n")

    topicSession.autoAdvance!.phase = "plan"
    topicSession.mode = "ship-plan"
    topicSession.pendingFeedback = []
    this.ctx.persistTopicSessions().catch(() => {})

    await this.ctx.spawnTopicAgent(topicSession, planTask)
  }

  private async shipTryJudge(topicSession: TopicSession): Promise<void> {
    topicSession.autoAdvance!.phase = "judge"

    await this.ctx.telegram.sendMessage(
      formatShipPhaseAdvance(topicSession.slug, "plan", "judge"),
      topicSession.threadId,
    )

    try {
      const ran = await this.judgeOrchestrator.tryJudgeArena(topicSession)
      if (!ran) {
        await this.ctx.telegram.sendMessage(
          `No competing design options detected — skipping judge arena.`,
          topicSession.threadId,
        )
      }
    } catch (err) {
      log.warn({ err, slug: topicSession.slug }, "judge arena failed, continuing to DAG")
      await this.ctx.telegram.sendMessage(
        `Judge arena encountered an error — skipping to DAG.`,
        topicSession.threadId,
      )
    }

    await this.shipAdvanceToDag(topicSession)
  }

  async shipAdvanceToDag(topicSession: TopicSession): Promise<void> {
    await this.ctx.telegram.sendMessage(
      formatShipPhaseAdvance(topicSession.slug, "judge", "dag"),
      topicSession.threadId,
    )

    topicSession.autoAdvance!.phase = "dag"

    const GRACE_PERIOD_MS = 2000
    await new Promise((resolve) => setTimeout(resolve, GRACE_PERIOD_MS))

    if (!topicSession.autoAdvance) {
      log.warn({ slug: topicSession.slug }, "autoAdvance cleared during DAG advance, aborting")
      return
    }

    const profile = topicSession.profileId ? this.ctx.profileStore.get(topicSession.profileId) : undefined
    const result = await extractDagItems(topicSession.conversation, undefined, profile)

    if (!topicSession.autoAdvance) {
      log.warn({ slug: topicSession.slug }, "autoAdvance cleared during DAG extraction, aborting")
      return
    }

    if (result.error === "system") {
      topicSession.autoAdvance!.phase = "plan"
      await this.ctx.telegram.sendMessage(
        `⚠️ DAG extraction failed — <code>${result.errorMessage ?? "Unknown error"}</code>\n\nYou can retry with <code>/dag</code>, or fall back to <code>/execute</code> or <code>/split</code>.`,
        topicSession.threadId,
      )
      await this.ctx.updateTopicTitle(topicSession, "⚠️")
      return
    }

    if (result.items.length === 0) {
      log.warn({ slug: topicSession.slug }, "DAG extraction yielded 0 items, retrying with enriched prompt")
      await this.ctx.telegram.sendMessage(
        `⚠️ No work items extracted — retrying with enriched prompt…`,
        topicSession.threadId,
      )

      const retryDirective = [
        "The previous extraction returned zero items. Re-read the conversation carefully.",
        "There IS a plan with actionable work items — extract each discrete task as a separate item.",
        "Look for numbered lists, bullet points, headings, or paragraphs describing distinct changes.",
        "Each item should be a meaningful unit of work that can produce its own PR.",
        "You MUST output at least one item. Only output [] if the conversation truly contains no plan.",
      ].join("\n")

      const retryResult = await extractDagItems(topicSession.conversation, retryDirective, profile)

      if (retryResult.items.length === 0) {
        log.warn({ slug: topicSession.slug }, "DAG extraction retry also yielded 0 items")
        topicSession.autoAdvance!.phase = "plan"
        await this.ctx.telegram.sendMessage(
          `⚠️ Still no work items after retry.\n\nYou can:\n• <code>/dag</code> — try again\n• <code>/execute</code> — run as a single task\n• <code>/split</code> — extract parallel items\n• <code>/close</code> — cancel`,
          topicSession.threadId,
        )
        return
      }

      await this.ctx.startDag(topicSession, retryResult.items, false)
      await this.ctx.persistTopicSessions()
      return
    }

    await this.ctx.startDag(topicSession, result.items, false)
    await this.ctx.persistTopicSessions()
  }

  async shipAdvanceToVerification(topicSession: TopicSession, graph: DagGraph): Promise<void> {
    await this.ctx.telegram.sendMessage(
      formatShipPhaseAdvance(topicSession.slug, "dag", "verify"),
      topicSession.threadId,
    )

    topicSession.autoAdvance!.phase = "verify"

    const completedNodes = graph.nodes.filter((n) => n.status === "done" && n.prUrl && n.branch)
    if (completedNodes.length === 0) {
      await this.shipFinalize(topicSession)
      return
    }

    let failed = 0
    const nodeResults = new Map<string, boolean>()
    const verifyStartedAt = Date.now()

    for (const node of completedNodes) {
      const childSession = this.findChildSession(topicSession, node.threadId)
      if (!childSession) {
        failed++
        nodeResults.set(node.id, false)
        continue
      }

      const verifyTask = buildCompletenessReviewPrompt(
        node.title,
        node.description,
        node.branch!,
        node.prUrl!,
      )

      childSession.mode = "ship-verify"

      const sessionId = crypto.randomUUID()
      childSession.activeSessionId = sessionId

      const meta: SessionMeta = {
        sessionId,
        threadId: childSession.threadId,
        topicName: childSession.slug,
        repo: childSession.repo,
        cwd: childSession.cwd,
        startedAt: Date.now(),
        mode: "ship-verify",
      }

      const onTextCapture = (_sid: string, text: string) => {
        this.ctx.pushToConversation(childSession, { role: "assistant", text })
      }

      const childProfile = childSession.profileId ? this.ctx.profileStore.get(childSession.profileId) : undefined
      const sessionConfig: SessionConfig = {
        goose: this.ctx.config.goose,
        claude: this.ctx.config.claude,
        mcp: this.ctx.config.mcp,
        profile: childProfile,
        sessionEnvPassthrough: this.ctx.config.sessionEnvPassthrough,
        agentDefs: this.ctx.config.agentDefs,
      }

      await new Promise<void>((resolve) => {
        const handle = new SessionHandle(
          meta,
          (event) => {
            this.ctx.observer.onEvent(meta, event).catch((err) => {
              loggers.observer.error({ err, sessionId }, "verify onEvent error")
            })
          },
          async (m, state) => {
            if (childSession.activeSessionId !== m.sessionId) { failed++; nodeResults.set(node.id, false); resolve(); return }
            this.ctx.sessions.delete(childSession.threadId)
            childSession.activeSessionId = undefined

            const durationMs = Date.now() - m.startedAt
            await this.ctx.observer.onSessionComplete(m, state, durationMs).catch(() => {})

            const output = childSession.conversation
              .filter((msg) => msg.role === "assistant")
              .map((msg) => msg.text)
              .join("\n")
            const result = parseCompletenessResult(output)

            if (result.passed) {
              nodeResults.set(node.id, true)
            } else {
              failed++
              nodeResults.set(node.id, false)
            }

            this.ctx.telegram.sendMessage(
              `${result.passed ? "✅" : "❌"} Verification ${result.passed ? "passed" : "failed"}: <b>${esc(node.title)}</b>`,
              topicSession.threadId,
            ).catch(() => {})

            resolve()
          },
          this.ctx.config.workspace.sessionTimeoutMs,
          this.ctx.config.workspace.sessionInactivityTimeoutMs,
          sessionConfig,
        )

        this.ctx.sessions.set(childSession.threadId, { handle, meta, task: verifyTask })
        const onDeadThread = () => {
          this.ctx.topicSessions.delete(meta.threadId)
          this.ctx.persistTopicSessions().catch(() => {})
        }
        this.ctx.observer.onSessionStart(meta, verifyTask, onTextCapture, onDeadThread)
          .then(() => handle.start(verifyTask))
          .catch((err) => {
            log.error({ err }, "verify session start failed")
            this.ctx.sessions.delete(childSession.threadId)
            childSession.activeSessionId = undefined
            failed++
            nodeResults.set(node.id, false)
            resolve()
          })
      })
    }

    topicSession.verificationState = {
      dagId: graph.id,
      maxRounds: 1,
      rounds: [{
        round: 1,
        checks: completedNodes.map((n) => ({
          kind: "completeness-review" as const,
          status: (nodeResults.get(n.id) ? "passed" : "failed") as "passed" | "failed",
          nodeId: n.id,
          finishedAt: Date.now(),
        })),
        startedAt: verifyStartedAt,
      }],
      status: failed === 0 ? "passed" : "failed",
    }
    await this.shipFinalize(topicSession)
  }

  private findChildSession(parent: TopicSession, threadId?: number): TopicSession | undefined {
    if (!threadId) return undefined
    return this.ctx.topicSessions.get(threadId)
  }

  async shipFinalize(topicSession: TopicSession): Promise<void> {
    topicSession.autoAdvance!.phase = "done"

    const vs = topicSession.verificationState
    const passed = vs ? vs.rounds.flatMap((r) => r.checks).filter((c) => c.status === "passed").length : 0
    const failed = vs ? vs.rounds.flatMap((r) => r.checks).filter((c) => c.status === "failed").length : 0
    const total = passed + failed

    await this.ctx.telegram.sendMessage(
      formatShipComplete(topicSession.slug, passed, failed, total),
      topicSession.threadId,
    )

    if (topicSession.autoAdvance!.autoLand && failed === 0 && topicSession.dagId) {
      await this.ctx.handleLandCommand(topicSession)
    } else if (failed === 0 && topicSession.dagId) {
      await this.ctx.telegram.sendMessage(
        `Use <code>/land</code> to merge PRs, or <code>/close</code> to clean up.`,
        topicSession.threadId,
      )
    }

    await this.ctx.updateTopicTitle(topicSession, failed === 0 ? "✅" : "⚠️")
    await this.ctx.persistTopicSessions()
  }
}
