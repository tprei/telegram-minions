/**
 * DispatcherContext — the callback contract that extracted modules use
 * to communicate back to the Dispatcher without circular dependencies.
 *
 * Each extracted module (CIBabysitter, LandingManager, DagOrchestrator,
 * SplitOrchestrator, ShipPipeline) receives this interface at construction
 * time. It provides access to shared state and operations that remain
 * owned by the Dispatcher core.
 */

import type { TelegramClient } from "../telegram/telegram.js"
import type { Observer } from "../telegram/observer.js"
import type {
  TopicSession, TopicMessage,
  TelegramPhotoSize,
} from "../types.js"
import type { MinionConfig, McpConfig } from "../config/config-types.js"
import type { DagGraph, DagNode, DagInput } from "../dag/dag.js"
import type { QualityReport } from "../ci/quality-gates.js"
import type { ActiveSession, MergeResult } from "../session/session-manager.js"
import type { StatsTracker } from "../stats.js"
import type { ProfileStore } from "../profile-store.js"
import type { StateBroadcaster } from "../api-server.js"

export interface DispatcherContext {
  // ── Configuration ──────────────────────────────────────────────────
  readonly config: MinionConfig
  readonly telegram: TelegramClient
  readonly observer: Observer
  readonly stats: StatsTracker
  readonly profileStore: ProfileStore
  readonly broadcaster?: StateBroadcaster

  // ── Shared mutable state ───────────────────────────────────────────
  /** Active running sessions keyed by threadId. */
  readonly sessions: Map<number, ActiveSession>
  /** All topic sessions (active + idle) keyed by threadId. */
  readonly topicSessions: Map<number, TopicSession>
  /** DAG graphs keyed by dagId. */
  readonly dags: Map<string, DagGraph>

  // ── Session lifecycle ──────────────────────────────────────────────

  /** Spawn a new agent session in an existing topic. */
  spawnTopicAgent(
    topicSession: TopicSession,
    task: string,
    mcpOverrides?: Partial<McpConfig>,
    systemPromptOverride?: string,
  ): Promise<void>

  /** Spawn a CI-fix agent session with a completion callback. */
  spawnCIFixAgent(
    topicSession: TopicSession,
    task: string,
    onComplete: () => void,
  ): Promise<void>

  // ── Workspace management ───────────────────────────────────────────

  /** Prepare a workspace directory for a session (clone repo, checkout branch). */
  prepareWorkspace(slug: string, repoUrl?: string, startBranch?: string): Promise<string | null>

  /** Remove a session's workspace directory. */
  removeWorkspace(topicSession: TopicSession): Promise<void>

  /** Clean build artifacts from a workspace. */
  cleanBuildArtifacts(cwd: string): void

  /** Prepare a fan-in branch by merging multiple upstream branches. */
  prepareFanInBranch(slug: string, repoUrl: string, upstreamBranches: string[]): Promise<string | null>

  /** Merge additional upstream branches into a worktree. */
  mergeUpstreamBranches(workDir: string, additionalBranches: string[]): MergeResult

  /** Download photos from Telegram. */
  downloadPhotos(photos: TelegramPhotoSize[] | undefined, cwd: string): Promise<string[]>

  // ── Conversation management ────────────────────────────────────────

  /** Push a message to a topic session's conversation with auto-truncation. */
  pushToConversation(session: TopicSession, message: TopicMessage): void

  /** Extract a PR URL from a session's conversation history. */
  extractPRFromConversation(topicSession: TopicSession): string | null

  // ── State persistence ──────────────────────────────────────────────

  /** Persist topic sessions to disk. */
  persistTopicSessions(markInterrupted?: boolean): Promise<void>

  // ── UI updates ─────────────────────────────────────────────────────

  /** Update the global pinned summary message. */
  updatePinnedSummary(): void

  /** Update a session's topic title with a state emoji. */
  updateTopicTitle(topicSession: TopicSession, stateEmoji: string): Promise<void>

  /** Pin or update a pinned message in a thread. */
  pinThreadMessage(session: TopicSession, html: string): Promise<void>

  /** Update the pinned split status in a parent thread. */
  updatePinnedSplitStatus(parent: TopicSession): Promise<void>

  /** Update the pinned DAG status in a parent thread. */
  updatePinnedDagStatus(parent: TopicSession, graph: DagGraph): Promise<void>

  // ── Broadcasting ───────────────────────────────────────────────────

  /** Broadcast session state changes to the API server. */
  broadcastSession(session: TopicSession, eventType: "session_created" | "session_updated", sessionState?: "completed" | "errored"): void

  /** Broadcast session deletion to the API server. */
  broadcastSessionDeleted(slug: string): void

  /** Broadcast DAG state changes to the API server. */
  broadcastDag(graph: DagGraph, eventType: "dag_created" | "dag_updated"): void

  /** Broadcast DAG deletion to the API server. */
  broadcastDagDeleted(dagId: string): void

  // ── Child session management ───────────────────────────────────────

  /** Close all children of a parent session. */
  closeChildSessions(parent: TopicSession): Promise<void>

  /** Close a single child session. */
  closeSingleChild(child: TopicSession): Promise<void>

  // ── Cross-module callbacks ─────────────────────────────────────────
  // These allow modules to call into each other through the context,
  // breaking circular dependencies.

  /** Start a DAG from extracted items (used by ShipPipeline → DagOrchestrator). */
  startDag(topicSession: TopicSession, items: DagInput[], isStack: boolean): Promise<void>

  /** Advance to the ship verification phase (used by DagOrchestrator → ShipPipeline). */
  shipAdvanceToVerification(topicSession: TopicSession, graph: DagGraph): Promise<void>

  /** Handle the /land command (used by ShipPipeline → LandingManager). */
  handleLandCommand(topicSession: TopicSession): Promise<void>

  /** Advance to the next ship phase (used by session completion handler → ShipPipeline). */
  handleShipAdvance(topicSession: TopicSession): Promise<void>

  /** Handle the /execute command (used by SplitOrchestrator). */
  handleExecuteCommand(topicSession: TopicSession, directive?: string): Promise<void>

  /** Notify parent when a child session completes (used by session completion handler). */
  notifyParentOfChildComplete(childSession: TopicSession, state: string): Promise<void>

  /** Post a session digest comment to a PR. */
  postSessionDigest(topicSession: TopicSession, prUrl: string): void

  /** Run deferred CI babysitting for a parent's children. */
  runDeferredBabysit(parentThreadId: number): Promise<void>

  /** Babysit a PR's CI checks (used by CIBabysitter). */
  babysitPR(topicSession: TopicSession, prUrl: string, initialQualityReport?: QualityReport): Promise<void>

  /** Babysit CI for a DAG child inline (used by DagOrchestrator). */
  babysitDagChildCI(childSession: TopicSession, prUrl: string): Promise<boolean>

  /** Update DAG section in all child PR descriptions. */
  updateDagPRDescriptions(graph: DagGraph, cwd: string): Promise<void>

  /** Schedule ready DAG nodes for execution. */
  scheduleDagNodes(topicSession: TopicSession, graph: DagGraph, isStack: boolean): Promise<void>

  /** Spawn a split child session. Returns the child threadId or null. */
  spawnSplitChild(
    parent: TopicSession,
    item: { title: string; description: string },
    allItems: { title: string; description: string }[],
  ): Promise<number | null>

  /** Spawn a DAG child session. Returns the child threadId or null. */
  spawnDagChild(
    parent: TopicSession,
    graph: DagGraph,
    node: DagNode,
    isStack: boolean,
  ): Promise<number | null>
}
