/**
 * DispatcherContext interface — shared state and methods for handler modules.
 *
 * Handlers receive this interface instead of a reference to the full Dispatcher class.
 * The Dispatcher class implements this interface and passes itself to handlers.
 */

import type { TelegramClient } from "./telegram.js"
import type { Observer } from "./observer.js"
import type { TopicSession, SessionMode, TopicMessage, AutoAdvance, TelegramPhotoSize } from "./types.js"
import type { MinionConfig, McpConfig } from "./config-types.js"
import type { StateBroadcaster } from "./api-server.js"
import type { ProfileStore } from "./profile-store.js"
import type { StatsTracker } from "./stats.js"
import type { DagGraph, DagNode, DagInput } from "./dag.js"
import type { QualityReport } from "./quality-gates.js"
import type { SplitItem } from "./split.js"

/**
 * An active running session with its process handle and metadata.
 * Re-exported from session-manager for handler use.
 */
export type { ActiveSession, PendingTask } from "./session-manager.js"

/**
 * Entry in the pending babysit queue: a child session awaiting CI checks.
 */
export interface PendingBabysitEntry {
  childSession: TopicSession
  prUrl: string
  qualityReport?: QualityReport
}

/**
 * DispatcherContext provides handlers with access to shared dispatcher state and operations.
 *
 * Handlers should depend only on this interface, not on the Dispatcher class directly.
 * This enables testability (mock the interface) and enforces a clear boundary between
 * the routing layer and the handler logic.
 */
export interface DispatcherContext {
  // ── Configuration ──────────────────────────────────────────────────
  readonly config: MinionConfig
  readonly telegram: TelegramClient
  readonly observer: Observer
  readonly stats: StatsTracker
  readonly profileStore: ProfileStore
  readonly broadcaster: StateBroadcaster | undefined

  // ── Shared state maps ──────────────────────────────────────────────

  /** Active running sessions keyed by thread ID. */
  readonly sessions: Map<number, import("./session-manager.js").ActiveSession>

  /** All topic sessions (active and idle) keyed by thread ID. */
  readonly topicSessions: Map<number, TopicSession>

  /** DAG graphs keyed by DAG ID. */
  readonly dags: Map<string, DagGraph>

  /** Pending babysit PRs keyed by parent thread ID. */
  readonly pendingBabysitPRs: Map<number, PendingBabysitEntry[]>

  /** Pending repo selection tasks keyed by message ID. */
  readonly pendingTasks: Map<number, import("./session-manager.js").PendingTask>

  /** Pending profile selection tasks keyed by message ID. */
  readonly pendingProfiles: Map<number, import("./session-manager.js").PendingTask>

  // ── Conversation management ────────────────────────────────────────

  /** Append a message to the session conversation, truncating if needed. */
  pushToConversation(session: TopicSession, message: TopicMessage): void

  // ── Broadcasting ───────────────────────────────────────────────────

  broadcastSession(session: TopicSession, eventType: "session_created" | "session_updated", sessionState?: "completed" | "errored"): void
  broadcastSessionDeleted(slug: string): void
  broadcastDag(graph: DagGraph, eventType: "dag_created" | "dag_updated"): void
  broadcastDagDeleted(dagId: string): void

  // ── Persistence ────────────────────────────────────────────────────

  persistTopicSessions(markInterrupted?: boolean): Promise<void>

  // ── Pinned messages ────────────────────────────────────────────────

  updatePinnedSummary(): void
  pinThreadMessage(session: TopicSession, html: string): Promise<void>
  updatePinnedSplitStatus(parent: TopicSession): Promise<void>
  updatePinnedDagStatus(parent: TopicSession, graph: DagGraph): Promise<void>

  // ── Topic title management ─────────────────────────────────────────

  updateTopicTitle(topicSession: TopicSession, stateEmoji: string): Promise<void>

  // ── Session spawning ───────────────────────────────────────────────

  /**
   * Spawn an agent session in a topic.
   * This is the core method that creates a SessionHandle, wires up the observer,
   * and starts the agent process.
   */
  spawnTopicAgent(
    topicSession: TopicSession,
    task: string,
    mcpOverrides?: Partial<McpConfig>,
    systemPromptOverride?: string,
  ): Promise<void>

  /**
   * Spawn a CI fix agent session.
   * Calls onComplete when the fix session finishes.
   */
  spawnCIFixAgent(
    topicSession: TopicSession,
    task: string,
    onComplete: () => void,
  ): Promise<void>

  /**
   * Start a new topic session (creates forum topic, prepares workspace, spawns agent).
   */
  startTopicSession(
    repoUrl: string | undefined,
    task: string,
    mode: SessionMode,
    photos?: TelegramPhotoSize[],
    profileId?: string,
    autoAdvance?: AutoAdvance,
  ): Promise<void>

  /**
   * Start a topic session with a specific profile (convenience wrapper).
   */
  startTopicSessionWithProfile(
    repoUrl: string | undefined,
    task: string,
    mode: SessionMode,
    profileId?: string,
  ): Promise<void>

  // ── PR extraction ──────────────────────────────────────────────────

  extractPRFromConversation(topicSession: TopicSession): string | null

  /** Post a conversation digest as a PR comment. */
  postSessionDigest(topicSession: TopicSession, prUrl: string): void

  // ── Workspace management ───────────────────────────────────────────

  prepareWorkspace(slug: string, repoUrl?: string, startBranch?: string): Promise<string | null>
  removeWorkspace(topicSession: TopicSession): Promise<void>
  cleanBuildArtifacts(cwd: string): void
  prepareFanInBranch(slug: string, repoUrl: string, upstreamBranches: string[]): Promise<string | null>
  mergeUpstreamBranches(workDir: string, additionalBranches: string[]): boolean
  downloadPhotos(photos: TelegramPhotoSize[] | undefined, cwd: string): Promise<string[]>

  // ── Child session management ───────────────────────────────────────

  closeChildSessions(parent: TopicSession): Promise<void>
  closeSingleChild(child: TopicSession): Promise<void>

  // ── Feedback and execution ─────────────────────────────────────────

  handleTopicFeedback(topicSession: TopicSession, feedback: string, photos?: TelegramPhotoSize[]): Promise<void>
  handleExecuteCommand(topicSession: TopicSession, directive?: string): Promise<void>

  // ── CI babysitting ─────────────────────────────────────────────────

  babysitPR(topicSession: TopicSession, prUrl: string, initialQualityReport?: QualityReport): Promise<void>
  babysitDagChildCI(childSession: TopicSession, prUrl: string): Promise<boolean>
  runDeferredBabysit(parentThreadId: number): Promise<void>

  // ── DAG operations ─────────────────────────────────────────────────

  startDag(topicSession: TopicSession, items: DagInput[], isStack: boolean): Promise<void>
  scheduleDagNodes(topicSession: TopicSession, graph: DagGraph, isStack: boolean): Promise<void>
  spawnDagChild(parent: TopicSession, graph: DagGraph, node: DagNode, isStack: boolean): Promise<number | null>
  onDagChildComplete(childSession: TopicSession, state: string): Promise<void>
  updateDagPRDescriptions(graph: DagGraph, cwd: string): Promise<void>

  // ── Split operations ───────────────────────────────────────────────

  spawnSplitChild(parent: TopicSession, item: SplitItem, allItems: SplitItem[]): Promise<number | null>
  notifyParentOfChildComplete(childSession: TopicSession, state: string): Promise<void>

  // ── Ship pipeline ──────────────────────────────────────────────────

  handleShipAdvance(topicSession: TopicSession): Promise<void>
  shipAdvanceToVerification(topicSession: TopicSession, graph: DagGraph): Promise<void>

  // ── Utility helpers ────────────────────────────────────────────────

  findChildCwd(parent: TopicSession, graph: DagGraph): string | undefined
  findChildSession(parent: TopicSession, threadId?: number): TopicSession | undefined
}
