import crypto from "node:crypto"
import type { DispatcherContext } from "./dispatcher-context.js"
import type { TopicSession, SessionMeta } from "./types.js"
import type { DagGraph } from "./dag.js"
import { SessionHandle, type SessionConfig } from "./session.js"
import { buildCompletenessReviewPrompt, parseCompletenessResult } from "./verification.js"
import { extractDagItems } from "./dag-extract.js"
import { esc, formatShipPhaseAdvance, formatShipComplete } from "./format.js"
import { loggers } from "./logger.js"

const log = loggers.ship

/**
 * ShipPipeline — extracted from Dispatcher.
 *
 * Owns the multi-phase ship pipeline: think → plan → dag → verify → done.
 * Each phase completes and automatically advances to the next.
 */
export class ShipPipeline {
  private readonly ctx: DispatcherContext

  constructor(ctx: DispatcherContext) {
    this.ctx = ctx
  }

  async handleShipAdvance(topicSession: TopicSession): Promise<void> {
    const advance = topicSession.autoAdvance
    if (!advance) return

    switch (advance.phase) {
      case "think":
        await this.shipAdvanceToPlanning(topicSession)
        break
      case "plan":
        await this.shipAdvanceToDag(topicSession)
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

    const MAX_CHARS = 4000
    const researchFindings = topicSession.conversation
      .filter((m) => m.role === "assistant")
      .map((m) => m.text.length > MAX_CHARS ? m.text.slice(-MAX_CHARS) : m.text)
      .join("\n\n")

    const planTask = [
      "## Feature request",
      "",
      topicSession.autoAdvance!.featureDescription,
      "",
      "## Research findings",
      "",
      researchFindings || "(no research output)",
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

  async shipAdvanceToDag(topicSession: TopicSession): Promise<void> {
    await this.ctx.telegram.sendMessage(
      formatShipPhaseAdvance(topicSession.slug, "plan", "dag"),
      topicSession.threadId,
    )

    topicSession.autoAdvance!.phase = "dag"

    const GRACE_PERIOD_MS = 2000
    await new Promise((resolve) => setTimeout(resolve, GRACE_PERIOD_MS))

    const profile = topicSession.profileId ? this.ctx.profileStore.get(topicSession.profileId) : undefined
    const result = await extractDagItems(topicSession.conversation, undefined, profile)

    if (result.error === "system") {
      topicSession.autoAdvance!.phase = "done"
      await this.ctx.telegram.sendMessage(
        `❌ Ship pipeline halted: DAG extraction failed — <code>${result.errorMessage ?? "Unknown error"}</code>`,
        topicSession.threadId,
      )
      await this.ctx.updateTopicTitle(topicSession, "❌")
      return
    }

    if (result.items.length === 0) {
      topicSession.autoAdvance!.phase = "done"
      await this.ctx.telegram.sendMessage(
        `❌ Ship pipeline halted: could not extract work items from the plan.`,
        topicSession.threadId,
      )
      await this.ctx.updateTopicTitle(topicSession, "❌")
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

    let pending = completedNodes.length
    let passed = 0
    let failed = 0

    const onVerifyDone = async () => {
      if (pending > 0) return
      topicSession.verificationState = {
        dagId: graph.id,
        maxRounds: 1,
        rounds: [{
          round: 1,
          checks: completedNodes.map((n) => ({
            kind: "completeness-review" as const,
            status: (passed === completedNodes.length ? "passed" : "failed") as "passed" | "failed",
            nodeId: n.id,
            finishedAt: Date.now(),
          })),
          startedAt: Date.now(),
        }],
        status: failed === 0 ? "passed" : "failed",
      }
      await this.shipFinalize(topicSession)
    }

    for (const node of completedNodes) {
      const childSession = this.findChildSession(topicSession, node.threadId)
      if (!childSession) {
        pending--
        failed++
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
      }

      const handle = new SessionHandle(
        meta,
        (event) => {
          this.ctx.observer.onEvent(meta, event).catch((err) => {
            loggers.observer.error({ err, sessionId }, "verify onEvent error")
          })
        },
        (m, state) => {
          if (childSession.activeSessionId !== m.sessionId) return
          this.ctx.sessions.delete(childSession.threadId)
          childSession.activeSessionId = undefined

          const output = childSession.conversation
            .filter((msg) => msg.role === "assistant")
            .map((msg) => msg.text)
            .join("\n")
          const result = parseCompletenessResult(output)

          if (result.passed) {
            passed++
          } else {
            failed++
          }
          pending--

          const durationMs = Date.now() - m.startedAt
          this.ctx.observer.onSessionComplete(m, state, durationMs).catch(() => {})

          this.ctx.telegram.sendMessage(
            `${result.passed ? "✅" : "❌"} Verification ${result.passed ? "passed" : "failed"}: <b>${esc(node.title)}</b>`,
            topicSession.threadId,
          ).catch(() => {})

          onVerifyDone().catch((err) => {
            log.error({ err }, "shipFinalize error after verification")
          })
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
      await this.ctx.observer.onSessionStart(meta, verifyTask, onTextCapture, onDeadThread)
      handle.start(verifyTask)
    }
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
