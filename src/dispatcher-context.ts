/**
 * DispatcherContext — narrow contract that extracted modules use to interact
 * with the Dispatcher without depending on the full class.
 *
 * Each extracted module (CI babysitter, split orchestrator, DAG orchestrator,
 * command router) receives a DispatcherContext instead of a back-reference to
 * the Dispatcher, keeping coupling explicit and testable.
 */

import type { TelegramClient } from "./telegram.js"
import type { Observer } from "./observer.js"
import type { TopicSession, TopicMessage, TelegramPhotoSize } from "./types.js"
import type { MinionConfig, McpConfig } from "./config-types.js"
import type { DagGraph } from "./dag.js"
import type { ProfileStore } from "./profile-store.js"
import type { StatsTracker } from "./stats.js"
import type { ActiveSession } from "./session-manager.js"

export type { ActiveSession }

/**
 * The narrow contract that extracted modules use to interact with the Dispatcher.
 *
 * This replaces direct back-references to the Dispatcher class, making
 * dependencies explicit and enabling isolated testing of each module.
 */
export interface DispatcherContext {
  // ── Read-only configuration ───────────────────────────────────────
  readonly config: MinionConfig
  readonly telegram: TelegramClient
  readonly observer: Observer
  readonly profileStore: ProfileStore
  readonly stats: StatsTracker

  // ── Shared mutable state ──────────────────────────────────────────
  /** Active running sessions keyed by threadId. */
  readonly sessions: Map<number, ActiveSession>
  /** All topic sessions (active + idle) keyed by threadId. */
  readonly topicSessions: Map<number, TopicSession>
  /** DAG graphs keyed by dagId. */
  readonly dags: Map<string, DagGraph>

  // ── Session lifecycle ─────────────────────────────────────────────
  /** Spawn an agent for a topic session. */
  spawnTopicAgent(
    topicSession: TopicSession,
    task: string,
    mcpOverrides?: Partial<McpConfig>,
    systemPromptOverride?: string,
  ): Promise<void>

  /** Spawn a CI-fix agent and call onComplete when it finishes. */
  spawnCIFixAgent(
    topicSession: TopicSession,
    task: string,
    onComplete: () => void,
  ): Promise<void>

  /** Close all child sessions (tracked + orphaned) of a parent. */
  closeChildSessions(parent: TopicSession): Promise<void>

  /** Close a single child session. */
  closeSingleChild(child: TopicSession): Promise<void>

  // ── Conversation ──────────────────────────────────────────────────
  /** Append a message to a topic session's conversation (with truncation). */
  pushToConversation(session: TopicSession, message: TopicMessage): void

  /** Search conversation for a PR URL (last assistant message). */
  extractPRFromConversation(topicSession: TopicSession): string | null

  // ── Persistence ───────────────────────────────────────────────────
  /** Persist all topic sessions to disk. */
  persistTopicSessions(): Promise<void>

  // ── Workspace management ──────────────────────────────────────────
  /** Prepare a workspace directory for a session. */
  prepareWorkspace(slug: string, repoUrl?: string, startBranch?: string): Promise<string | null>

  /** Remove a session's workspace from disk. */
  removeWorkspace(topicSession: TopicSession): Promise<void>

  /** Remove build artifacts from a workspace. */
  cleanBuildArtifacts(cwd: string): void

  /** Prepare a fan-in branch by merging upstream branches. */
  prepareFanInBranch(slug: string, repoUrl: string, upstreamBranches: string[]): Promise<string | null>

  /** Merge additional upstream branches into a worktree. */
  mergeUpstreamBranches(workDir: string, additionalBranches: string[]): boolean

  /** Download Telegram photos and return local file paths. */
  downloadPhotos(photos: TelegramPhotoSize[] | undefined, cwd: string): Promise<string[]>

  // ── Broadcasting ──────────────────────────────────────────────────
  /** Broadcast a session state change to the API server. */
  broadcastSession(
    session: TopicSession,
    eventType: "session_created" | "session_updated",
    sessionState?: "completed" | "errored",
  ): void

  /** Broadcast a session deletion to the API server. */
  broadcastSessionDeleted(slug: string): void

  /** Broadcast a DAG state change to the API server. */
  broadcastDag(graph: DagGraph, eventType: "dag_created" | "dag_updated"): void

  /** Broadcast a DAG deletion to the API server. */
  broadcastDagDeleted(dagId: string): void

  // ── UI helpers ────────────────────────────────────────────────────
  /** Update the emoji prefix on a forum topic title. */
  updateTopicTitle(topicSession: TopicSession, stateEmoji: string): Promise<void>

  /** Pin or update a pinned message in a thread. */
  pinThreadMessage(session: TopicSession, html: string): Promise<void>

  /** Refresh the global pinned summary message. */
  updatePinnedSummary(): void

  /** Update the pinned split-status message in a parent thread. */
  updatePinnedSplitStatus(parent: TopicSession): Promise<void>

  /** Update the pinned DAG-status message in a parent thread. */
  updatePinnedDagStatus(parent: TopicSession, graph: DagGraph): Promise<void>

  // ── Command delegation ────────────────────────────────────────────
  /** Switch a plan/think session to execution mode. */
  handleExecuteCommand(topicSession: TopicSession, directive?: string): Promise<void>

  /** Post a session digest comment on a PR. */
  postSessionDigest(topicSession: TopicSession, prUrl: string): void
}
