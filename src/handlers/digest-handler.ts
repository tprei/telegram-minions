import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { TopicSession } from "../domain/session-types.js"
import type { CompletionHandler, SessionCompletionContext } from "./handler-types.js"
import { buildConversationDigest, buildChildSessionDigest } from "../conversation-digest.js"
import { formatPinnedStatus } from "../telegram/format.js"
import { extractPRUrl } from "../ci/ci-babysit.js"
import { createLogger } from "../logger.js"

const log = createLogger({ component: "digest-handler" })

export interface TopicSessionStore {
  get(threadId: string): TopicSession | undefined
}

export interface ProfileStore {
  get(profileId: string): import("../config/config-types.js").ProviderProfile | undefined
}

export interface PinnedMessages {
  pinThreadMessage(session: TopicSession, html: string): Promise<void>
}

export class DigestHandler implements CompletionHandler {
  readonly name = "DigestHandler"

  constructor(
    private readonly topicSessions: TopicSessionStore,
    private readonly profileStore: ProfileStore,
    private readonly pinnedMessages: PinnedMessages,
  ) {}

  async handle(ctx: SessionCompletionContext): Promise<void> {
    if (ctx.state !== "completed") return
    if (ctx.topicSession.mode !== "task") return

    const { topicSession } = ctx

    const prUrl = this.extractPRFromConversation(topicSession)
    ctx.prUrl = prUrl

    if (prUrl) {
      topicSession.prUrl = prUrl
      await this.postSessionDigest(topicSession, prUrl)
      await this.pinnedMessages.pinThreadMessage(
        topicSession,
        formatPinnedStatus(topicSession.slug, topicSession.repo, "completed", prUrl),
      )
    } else {
      await this.pinnedMessages.pinThreadMessage(
        topicSession,
        formatPinnedStatus(topicSession.slug, topicSession.repo, "completed"),
      )
    }
  }

  private extractPRFromConversation(topicSession: TopicSession): string | null {
    for (let i = topicSession.conversation.length - 1; i >= 0; i--) {
      const msg = topicSession.conversation[i]
      if (msg.role === "assistant") {
        const url = extractPRUrl(msg.text)
        if (url) return url
      }
    }
    return null
  }

  private async postSessionDigest(topicSession: TopicSession, prUrl: string): Promise<void> {
    const summaryPath = path.join(topicSession.cwd, ".session-summary.md")
    if (fs.existsSync(summaryPath)) return

    let digest: string | null
    if (topicSession.parentThreadId) {
      const parentSession = this.topicSessions.get(topicSession.parentThreadId)
      const profile = topicSession.profileId
        ? this.profileStore.get(topicSession.profileId)
        : undefined
      digest = await buildChildSessionDigest({
        childConversation: topicSession.conversation,
        parentConversation: parentSession?.conversation,
        profile,
      })
    } else {
      digest = buildConversationDigest(topicSession.conversation)
    }
    if (!digest) return

    try {
      await new Promise<void>((resolve, reject) => {
        const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1]
        if (!prNumber) { reject(new Error("cannot parse PR number")); return }
        const repoMatch = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)
        const args = ["pr", "comment", prNumber, "--body-file", "-"]
        if (repoMatch) args.push("--repo", repoMatch[1])
        const proc = spawn("gh", args, { cwd: topicSession.cwd, stdio: ["pipe", "pipe", "pipe"] })
        proc.stdin.end(digest)
        proc.on("close", (code) => { if (code === 0) resolve(); else reject(new Error(`gh pr comment exited ${code}`)) })
        proc.on("error", reject)
      })
    } catch (err) {
      log.error({ err }, "failed to post session digest")
    }
  }
}
