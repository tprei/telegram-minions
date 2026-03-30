import fs from "node:fs"
import path from "node:path"
import { loggers } from "./logger.js"
import { formatProfileList, formatConfigHelp } from "./format.js"
import { escapeHtml, extractRepoName } from "./command-parser.js"
import { dirSizeBytes } from "./session-manager.js"
import type { DispatcherContext } from "./dispatcher-context.js"
import type { TopicSession } from "./types.js"

const log = loggers.dispatcher

export class ConfigManager {
  constructor(private readonly ctx: DispatcherContext) {}

  async handleConfigCommand(args: string): Promise<void> {
    if (!args) {
      const profiles = this.ctx.profileStore.list()
      const defaultId = this.ctx.profileStore.getDefaultId()
      await this.ctx.telegram.sendMessage(formatProfileList(profiles, defaultId))
      return
    }

    const parts = args.split(/\s+/)
    const subcommand = parts[0]

    if (subcommand === "add" && parts.length >= 3) {
      const id = parts[1]
      const name = parts.slice(2).join(" ")
      const added = this.ctx.profileStore.add({ id, name })
      if (added) {
        await this.ctx.telegram.sendMessage(`✅ Added profile <code>${escapeHtml(id)}</code>`)
      } else {
        await this.ctx.telegram.sendMessage(`❌ Profile <code>${escapeHtml(id)}</code> already exists`)
      }
      return
    }

    if (subcommand === "set" && parts.length >= 4) {
      const id = parts[1]
      const field = parts[2]
      const value = parts.slice(3).join(" ")
      const validFields = ["name", "baseUrl", "authToken", "opusModel", "sonnetModel", "haikuModel"]
      if (!validFields.includes(field)) {
        await this.ctx.telegram.sendMessage(`❌ Invalid field. Valid: ${validFields.join(", ")}`)
        return
      }
      const updated = this.ctx.profileStore.update(id, { [field]: value })
      if (updated) {
        await this.ctx.telegram.sendMessage(`✅ Updated <code>${escapeHtml(id)}.${escapeHtml(field)}</code>`)
      } else {
        await this.ctx.telegram.sendMessage(`❌ Profile <code>${escapeHtml(id)}</code> not found`)
      }
      return
    }

    if (subcommand === "remove" && parts.length >= 2) {
      const id = parts[1]
      const removed = this.ctx.profileStore.remove(id)
      if (removed) {
        await this.ctx.telegram.sendMessage(`✅ Removed profile <code>${escapeHtml(id)}</code>`)
      } else {
        await this.ctx.telegram.sendMessage(`❌ Cannot remove <code>${escapeHtml(id)}</code> (not found or is default)`)
      }
      return
    }

    if (subcommand === "default") {
      if (parts.length === 1) {
        this.ctx.profileStore.clearDefault()
        await this.ctx.telegram.sendMessage(`✅ Cleared default profile`)
        return
      }
      const id = parts[1]
      if (id === "clear") {
        this.ctx.profileStore.clearDefault()
        await this.ctx.telegram.sendMessage(`✅ Cleared default profile`)
        return
      }
      const set = this.ctx.profileStore.setDefaultId(id)
      if (set) {
        const profile = this.ctx.profileStore.get(id)
        await this.ctx.telegram.sendMessage(`✅ Default profile set to <code>${escapeHtml(id)}</code> (${escapeHtml(profile?.name ?? id)})`)
      } else {
        await this.ctx.telegram.sendMessage(`❌ Profile <code>${escapeHtml(id)}</code> not found`)
      }
      return
    }

    await this.ctx.telegram.sendMessage(formatConfigHelp())
  }

  async handleCleanCommand(): Promise<void> {
    const root = this.ctx.config.workspace.root
    let freedBytes = 0
    let removedSessions = 0
    let removedOrphans = 0
    let removedRepos = 0

    const now = Date.now()
    const staleTtlMs = this.ctx.config.workspace.staleTtlMs
    const idle: [number, TopicSession][] = []
    for (const [threadId, session] of this.ctx.topicSessions) {
      const isIdle = !session.activeSessionId
      const isStaleInterrupted =
        session.interruptedAt && now - session.interruptedAt >= staleTtlMs
      if (isIdle || isStaleInterrupted) {
        idle.push([threadId, session])
      }
    }

    for (const [threadId, session] of idle) {
      if (session.cwd && fs.existsSync(session.cwd)) {
        freedBytes += dirSizeBytes(session.cwd)
      }
      await this.ctx.telegram.deleteForumTopic(threadId)
      await this.ctx.removeWorkspace(session)
      this.ctx.topicSessions.delete(threadId)
      removedSessions++
    }

    const activeCwds = new Set<string>()
    for (const session of this.ctx.topicSessions.values()) {
      if (session.cwd) activeCwds.add(session.cwd)
    }

    const parentHome = process.env["HOME"] ?? ""
    const entries = fs.readdirSync(root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith(".")) continue
      const entryPath = path.join(root, entry.name)
      if (entryPath === parentHome) continue
      if (activeCwds.has(entryPath)) continue
      if (this.ctx.sessions.has(Number(entry.name))) continue

      freedBytes += dirSizeBytes(entryPath)
      try {
        fs.rmSync(entryPath, { recursive: true, force: true })
        removedOrphans++
        log.info({ path: entryPath }, "removed orphan workspace")
      } catch (err) {
        log.warn({ err, path: entryPath }, "failed to remove orphan")
      }
    }

    const activeRepos = new Set<string>()
    for (const session of this.ctx.topicSessions.values()) {
      if (session.repoUrl) {
        activeRepos.add(extractRepoName(session.repoUrl))
      }
    }

    const reposDir = path.join(root, ".repos")
    if (fs.existsSync(reposDir)) {
      const repos = fs.readdirSync(reposDir, { withFileTypes: true })
      for (const repo of repos) {
        if (!repo.isDirectory()) continue
        const repoName = repo.name.replace(/\.git$/, "")
        if (activeRepos.has(repoName)) continue
        const repoPath = path.join(reposDir, repo.name)
        freedBytes += dirSizeBytes(repoPath)
        try {
          fs.rmSync(repoPath, { recursive: true, force: true })
          removedRepos++
          log.info({ path: repoPath }, "removed bare repo")
        } catch (err) {
          log.warn({ err, path: repoPath }, "failed to remove bare repo")
        }
      }
    }

    await this.ctx.persistTopicSessions()
    this.ctx.updatePinnedSummary()

    const totalItems = removedSessions + removedOrphans + removedRepos
    if (totalItems === 0) {
      await this.ctx.telegram.sendMessage("🧹 Nothing to clean up — disk is tidy.")
      return
    }

    const msgParts: string[] = []
    if (removedSessions > 0) msgParts.push(`${removedSessions} idle session(s)`)
    if (removedOrphans > 0) msgParts.push(`${removedOrphans} orphaned workspace(s)`)
    if (removedRepos > 0) msgParts.push(`${removedRepos} cached repo(s)`)

    const freedMB = (freedBytes / (1024 * 1024)).toFixed(1)
    await this.ctx.telegram.sendMessage(`🧹 Cleaned ${msgParts.join(", ")} — freed ~${freedMB} MB.`)
  }
}
