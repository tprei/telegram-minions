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
import type { ChatPlatform } from "../provider/chat-platform.js"
import type { Observer } from "../telegram/observer.js"
import type { TopicSession, TopicMessage, SessionDoneState, WorkspaceRef } from "../domain/session-types.js"
import type { TelegramPhotoSize } from "../domain/telegram-types.js"
import type { MinionConfig, McpConfig } from "../config/config-types.js"
import type { DagGraph, DagNode, DagInput } from "../dag/dag.js"
import type { QualityReport } from "../ci/quality-gates.js"
import type { ActiveSession, MergeResult, PendingTask } from "../session/session-manager.js"
import type { StatsTracker } from "../stats.js"
import type { ProfileStore } from "../profile-store.js"
import type { StateBroadcaster } from "../api-server.js"

export interface DispatcherContext {
  // ── Configuration ──────────────────────────────────────────────────
  readonly config: MinionConfig
  /** Platform-agnostic chat interface. Prefer this over telegram for new code. */
  readonly platform: ChatPlatform
  /** @deprecated Backward-compat shim — use platform instead. */
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
  /** Pending task selections waiting for repo/profile keyboard callbacks. */
  readonly pendingTasks: Map<number, PendingTask>

  /** Set a pending task entry with automatic TTL expiry. */
  setPendingTask(msgId: number, entry: PendingTask): void

  /** Clear a pending task entry and its TTL timer. Returns the entry if found. */
  clearPendingTask(msgId: number): PendingTask | undefined

  // ── Abort management ───────────────────────────────────────────────
  /** Map of threadId → AbortController for cancellable long-running operations. */
  readonly abortControllers: Map<number, AbortController>

  // ── Token management ───────────────────────────────────────────────

  /** Refresh the GitHub token in process.env before git/gh operations. */
  refreshGitToken(): Promise<void>

  // ── Session lifecycle ──────────────────────────────────────────────

  /** Spawn a new agent session in an existing topic. Returns false if rejected (e.g. max sessions). */
  spawnTopicAgent(
    topicSession: TopicSession,
    task: string,
    mcpOverrides?: Partial<McpConfig>,
    systemPromptOverride?: string,
  ): Promise<boolean>

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
  removeWorkspace(topicSession: WorkspaceRef): Promise<void>

  /** Clean build artifacts from a workspace. */
  cleanBuildArtifacts(cwd: string): void

  /** Re-install dependencies if missing (e.g. after cleanBuildArtifacts). */
  rebootstrapDependencies(cwd: string): void

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

  /** Persist DAG graphs to disk. */
  persistDags(): Promise<void>

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
  broadcastSession(session: TopicSession, eventType: "session_created" | "session_updated", sessionState?: SessionDoneState): void

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

  /** Start a session with profile selection UI. */
  startWithProfileSelection(
    repoUrl: string | undefined,
    task: string,
    mode: "task" | "plan" | "think" | "review" | "ship-think",
    replyThreadId?: number,
    photos?: TelegramPhotoSize[],
    autoAdvance?: import("../domain/workflow-types.js").AutoAdvance,
  ): Promise<void>

  /** Start a DAG from extracted items (used by ShipPipeline → DagOrchestrator). */
  startDag(topicSession: TopicSession, items: DagInput[], isStack: boolean): Promise<void>

  /** Advance to the ship verification phase (used by DagOrchestrator → ShipPipeline). */
  shipAdvanceToVerification(topicSession: TopicSession, graph: DagGraph): Promise<void>

  /** Handle the /land command (used by ShipPipeline → LandingManager). */
  handleLandCommand(topicSession: TopicSession): Promise<void>

  /** Re-run DAG extraction (used by DagOrchestrator for /retry in dag phase). */
  shipAdvanceToDag(topicSession: TopicSession): Promise<void>

  /** Handle the /execute command (used by SplitOrchestrator). */
  handleExecuteCommand(topicSession: TopicSession, directive?: string): Promise<void>

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
