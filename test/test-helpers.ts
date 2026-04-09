/**
 * ObjectMother test helper factories.
 *
 * Centralised mock constructors for TelegramClient, Observer, StatsTracker,
 * ProfileStore, DispatcherContext, ActiveSession, TopicSession, and execFile
 * patterns. Eliminates repetitive type casts across the test suite.
 */

import { vi } from "vitest"
import type { ChildProcess } from "node:child_process"
import type { TelegramClient } from "../src/telegram/telegram.js"
import type { Observer, TextCaptureCallback } from "../src/telegram/observer.js"
import type { ChatProvider, FileHandler, ThreadManager } from "../src/provider/index.js"
import type { StatsTracker, SessionRecord, AggregateStats } from "../src/stats.js"
import type { ProfileStore } from "../src/profile-store.js"
import type { DispatcherContext } from "../src/orchestration/dispatcher-context.js"
import type { ActiveSession, PendingTask, MergeResult } from "../src/session/session-manager.js"
import type {
  SessionPort,
  SessionMeta,
  SessionDoneState,
  SessionState,
  TopicSession,
  TopicMessage,
  SessionMode,
} from "../src/domain/session-types.js"
import type { MinionConfig, McpConfig, ProviderProfile } from "../src/config/config-types.js"
import type { DagGraph, DagNode, DagInput } from "../src/dag/dag.js"
import type { QualityReport } from "../src/ci/quality-gates.js"
import type { TelegramPhotoSize } from "../src/domain/telegram-types.js"
import type { AutoAdvance } from "../src/domain/workflow-types.js"
import type { StateBroadcaster } from "../src/api-server.js"

// ── TelegramClient ─────────────────────────────────────────────────────

export function makeMockTelegram(overrides: Partial<TelegramClient> = {}): TelegramClient {
  return {
    getUpdates: vi.fn(async () => []),
    sendMessage: vi.fn(async () => ({ ok: true, messageId: "1" })),
    editMessage: vi.fn(async () => true),
    createForumTopic: vi.fn(async () => ({ message_thread_id: 100, name: "test", icon_color: 0 })),
    editForumTopic: vi.fn(async () => {}),
    pinChatMessage: vi.fn(async () => {}),
    closeForumTopic: vi.fn(async () => {}),
    sendMessageWithKeyboard: vi.fn(async () => "1"),
    answerCallbackQuery: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    deleteForumTopic: vi.fn(async () => {}),
    sendPhoto: vi.fn(async () => "1"),
    sendPhotoBuffer: vi.fn(async () => "1"),
    downloadFile: vi.fn(async () => true),
    ...overrides,
  } as unknown as TelegramClient
}

// ── ChatProvider ──────────────────────────────────────────────────────

export function makeMockChatProvider(overrides: Partial<ChatProvider> = {}): ChatProvider {
  return {
    sendMessage: vi.fn(async () => ({ ok: true, messageId: "1" })),
    editMessage: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => {}),
    pinMessage: vi.fn(async () => {}),
    ...overrides,
  }
}

// ── FileHandler ───────────────────────────────────────────────────────

export function makeMockFileHandler(overrides: Partial<FileHandler> = {}): FileHandler {
  return {
    sendPhoto: vi.fn(async () => "1"),
    sendPhotoBuffer: vi.fn(async () => "1"),
    downloadFile: vi.fn(async () => true),
    ...overrides,
  }
}

// ── ThreadManager ─────────────────────────────────────────────────────

export function makeMockThreadManager(overrides: Partial<ThreadManager> = {}): ThreadManager {
  return {
    createThread: vi.fn(async () => ({ threadId: "100", name: "test" })),
    editThread: vi.fn(async () => {}),
    closeThread: vi.fn(async () => {}),
    deleteThread: vi.fn(async () => {}),
    ...overrides,
  }
}

// ── Observer ───────────────────────────────────────────────────────────

export function makeMockObserver(overrides: Partial<Observer> = {}): Observer {
  return {
    onSessionStart: vi.fn(async () => {}),
    onEvent: vi.fn(async () => {}),
    onSessionEnd: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    ...overrides,
  } as unknown as Observer
}

// ── StatsTracker ───────────────────────────────────────────────────────

export function makeMockStats(overrides: Partial<StatsTracker> = {}): StatsTracker {
  return {
    record: vi.fn(async () => {}),
    load: vi.fn(async () => []),
    aggregate: vi.fn(async (): Promise<AggregateStats> => ({
      totalSessions: 0,
      completedSessions: 0,
      erroredSessions: 0,
      totalTokens: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
    })),
    recentSessions: vi.fn(async () => []),
    breakdownByMode: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as StatsTracker
}

// ── ProfileStore ───────────────────────────────────────────────────────

export function makeMockProfileStore(overrides: Partial<ProfileStore> = {}): ProfileStore {
  return {
    load: vi.fn(),
    save: vi.fn(),
    list: vi.fn(() => [{ id: "claude-acp", name: "Claude Code (default)" }] as ProviderProfile[]),
    get: vi.fn(() => ({ id: "claude-acp", name: "Claude Code (default)" }) as ProviderProfile | undefined),
    add: vi.fn(() => true),
    update: vi.fn(() => true),
    remove: vi.fn(() => true),
    getDefaultId: vi.fn(() => undefined as string | undefined),
    setDefaultId: vi.fn(() => true),
    clearDefault: vi.fn(),
    ...overrides,
  } as unknown as ProfileStore
}

// ── SessionPort ────────────────────────────────────────────────────────

export function makeMockSessionPort(overrides: Partial<SessionPort> = {}): SessionPort {
  const meta: SessionMeta = {
    sessionId: "test-session-1",
    threadId: "1",
    topicName: "test-topic",
    repo: "test-repo",
    cwd: "/tmp/test",
    startedAt: Date.now(),
    mode: "task",
  }

  return {
    meta,
    start: vi.fn(),
    injectReply: vi.fn(() => true),
    waitForCompletion: vi.fn(async (): Promise<SessionDoneState> => "completed"),
    isClosed: vi.fn(() => false),
    getState: vi.fn((): SessionState => "working"),
    isActive: vi.fn(() => true),
    interrupt: vi.fn(),
    kill: vi.fn(async () => {}),
    ...overrides,
  }
}

// ── ActiveSession ──────────────────────────────────────────────────────

export function makeMockActiveSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  const handle = makeMockSessionPort(overrides.handle ? overrides.handle as Partial<SessionPort> : undefined)
  return {
    handle,
    meta: handle.meta,
    task: "test task",
    ...overrides,
    // If handle was overridden, use that directly; otherwise use generated one
    ...(overrides.handle ? { handle: overrides.handle } : { handle }),
  }
}

// ── TopicSession ───────────────────────────────────────────────────────

export function makeMockTopicSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: "1",
    repo: "test-repo",
    cwd: "/tmp/test",
    slug: "test-slug",
    conversation: [],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

// ── PendingTask ────────────────────────────────────────────────────────

export function makeMockPendingTask(overrides: Partial<PendingTask> = {}): PendingTask {
  return {
    task: "test task",
    mode: "task",
    ...overrides,
  }
}

// ── MinionConfig ───────────────────────────────────────────────────────

export function makeMockConfig(overrides: Partial<MinionConfig> = {}): MinionConfig {
  return {
    telegram: { botToken: "test", chatId: "123", allowedUserIds: [1] },
    telegramQueue: { minSendIntervalMs: 0 },
    goose: { provider: "test", model: "test" },
    claude: { planModel: "test", thinkModel: "test", reviewModel: "test" },
    workspace: {
      root: "/tmp/test",
      maxConcurrentSessions: 5,
      maxDagConcurrency: 3,
      maxSplitItems: 10,
      sessionTokenBudget: 100000,
      sessionBudgetUsd: 10,
      sessionTimeoutMs: 300000,
      sessionInactivityTimeoutMs: 60000,
      staleTtlMs: 86400000,
      cleanupIntervalMs: 3600000,
      maxConversationLength: 50,
      maxJudgeOptions: 5,
      judgeAdvocateTimeoutMs: 120000,
      judgeTimeoutMs: 300000,
    },
    ci: {
      babysitEnabled: false,
      maxRetries: 2,
      pollIntervalMs: 5000,
      pollTimeoutMs: 300000,
      dagCiPolicy: "skip",
    },
    mcp: {
      browserEnabled: false,
      githubEnabled: false,
      context7Enabled: false,
      sentryEnabled: false,
      sentryOrgSlug: "",
      sentryProjectSlug: "",
      supabaseEnabled: false,
      supabaseProjectRef: "",
      flyEnabled: false,
      flyOrg: "",
      zaiEnabled: false,
    },
    observer: { activityThrottleMs: 0, textFlushDebounceMs: 0, activityEditDebounceMs: 0 },
    repos: {},
    quota: { retryMax: 2, defaultSleepMs: 60000, sleepBufferMs: 5000 },
    ...overrides,
  }
}

// ── DispatcherContext ──────────────────────────────────────────────────

export function createMockContext(overrides: Partial<DispatcherContext> = {}): DispatcherContext {
  return {
    config: makeMockConfig(),
    chat: makeMockChatProvider(),
    threads: makeMockThreadManager(),
    ui: {
      sendMessageWithKeyboard: vi.fn(async () => "1"),
      answerCallbackQuery: vi.fn(async () => {}),
    },
    observer: makeMockObserver(),
    stats: makeMockStats(),
    profileStore: makeMockProfileStore(),
    broadcaster: undefined,
    sessions: new Map(),
    topicSessions: new Map(),
    dags: new Map(),
    pendingTasks: new Map(),
    abortControllers: new Map(),
    refreshGitToken: vi.fn(async () => {}),
    spawnTopicAgent: vi.fn(async () => true),
    spawnCIFixAgent: vi.fn(async () => {}),
    prepareWorkspace: vi.fn(async () => "/tmp/test/workspace"),
    removeWorkspace: vi.fn(async () => {}),
    cleanBuildArtifacts: vi.fn(),
    rebootstrapDependencies: vi.fn(),
    prepareFanInBranch: vi.fn(async () => null),
    mergeUpstreamBranches: vi.fn((): MergeResult => ({ ok: true, conflictFiles: [] })),
    downloadPhotos: vi.fn(async () => []),
    pushToConversation: vi.fn(),
    extractPRFromConversation: vi.fn(() => null),
    persistTopicSessions: vi.fn(async () => {}),
    persistDags: vi.fn(async () => {}),
    updatePinnedSummary: vi.fn(),
    updateTopicTitle: vi.fn(async () => {}),
    pinThreadMessage: vi.fn(async () => {}),
    updatePinnedSplitStatus: vi.fn(async () => {}),
    updatePinnedDagStatus: vi.fn(async () => {}),
    broadcastSession: vi.fn(),
    broadcastSessionDeleted: vi.fn(),
    broadcastDag: vi.fn(),
    broadcastDagDeleted: vi.fn(),
    closeChildSessions: vi.fn(async () => {}),
    closeSingleChild: vi.fn(async () => {}),
    startWithProfileSelection: vi.fn(async () => {}),
    startDag: vi.fn(async () => {}),
    shipAdvanceToVerification: vi.fn(async () => {}),
    handleLandCommand: vi.fn(async () => {}),
    shipAdvanceToDag: vi.fn(async () => {}),
    handleExecuteCommand: vi.fn(async () => {}),
    runDeferredBabysit: vi.fn(async () => {}),
    babysitPR: vi.fn(async () => {}),
    babysitDagChildCI: vi.fn(async () => true),
    updateDagPRDescriptions: vi.fn(async () => {}),
    scheduleDagNodes: vi.fn(async () => {}),
    spawnSplitChild: vi.fn(async () => null),
    spawnDagChild: vi.fn(async () => null),
    ...overrides,
  }
}

// ── DagNode ───────────────────────────────────────────────────────────

export function makeMockDagNode(overrides: Partial<DagNode> = {}): DagNode {
  return {
    id: "node-1",
    title: "Test node",
    description: "A test DAG node",
    dependsOn: [],
    status: "pending",
    ...overrides,
  }
}

// ── DagGraph ──────────────────────────────────────────────────────────

export function makeMockDagGraph(overrides: Partial<DagGraph> = {}): DagGraph {
  return {
    id: "dag-1",
    nodes: [],
    parentThreadId: "1",
    repo: "test-repo",
    createdAt: Date.now(),
    ...overrides,
  }
}

// ── execFile mock helpers ──────────────────────────────────────────────

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void

/**
 * Configure a mocked `execFile` to call back with success output.
 * Use with `vi.mocked(execFile)` after mocking `node:child_process`.
 */
export function mockExecFileSuccess(
  mockExecFile: ReturnType<typeof vi.fn>,
  output: string,
): void {
  mockExecFile.mockImplementation((...allArgs: unknown[]) => {
    const cb = allArgs[allArgs.length - 1] as ExecFileCallback
    cb(null, output, "")
    return undefined as unknown as ChildProcess
  })
}

/**
 * Configure a mocked `execFile` to call back with an error.
 */
export function mockExecFileError(
  mockExecFile: ReturnType<typeof vi.fn>,
  stderr = "command failed",
): void {
  const err = Object.assign(new Error("Command failed"), { stderr })
  mockExecFile.mockImplementation((...allArgs: unknown[]) => {
    const cb = allArgs[allArgs.length - 1] as ExecFileCallback
    cb(err, "", stderr)
    return undefined as unknown as ChildProcess
  })
}

/**
 * Configure a mocked `execFile` to respond differently per command.
 * Takes an array of `{ match, output }` pairs. First matching entry wins.
 * Unmatched calls return empty output.
 */
export function mockExecFileResponses(
  mockExecFile: ReturnType<typeof vi.fn>,
  responses: { match: string | RegExp; output?: string; error?: string }[],
): void {
  mockExecFile.mockImplementation((...allArgs: unknown[]) => {
    const cmd = String(allArgs[0])
    const args = Array.isArray(allArgs[1]) ? allArgs[1].join(" ") : ""
    const fullCmd = `${cmd} ${args}`.trim()
    const cb = allArgs[allArgs.length - 1] as ExecFileCallback

    for (const resp of responses) {
      const matches =
        typeof resp.match === "string"
          ? fullCmd.includes(resp.match)
          : resp.match.test(fullCmd)
      if (matches) {
        if (resp.error) {
          const err = Object.assign(new Error("Command failed"), { stderr: resp.error })
          cb(err, "", resp.error)
        } else {
          cb(null, resp.output ?? "", "")
        }
        return undefined as unknown as ChildProcess
      }
    }

    cb(null, "", "")
    return undefined as unknown as ChildProcess
  })
}
