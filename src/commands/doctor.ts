/**
 * Doctor command — diagnostic evidence gathering and prompt building.
 *
 * Collects thread state, parent/child summaries, DAG graph status,
 * and structures everything into a diagnostic prompt that a planning
 * session can use for root-cause analysis.
 */

import type { TopicSession, TopicMessage } from "../domain/session-types.js"
import type { DagGraph } from "../dag/dag.js"
import { dagProgress, renderDagStatus } from "../dag/dag.js"
import { threadLink } from "../telegram/format.js"

// ── Types ──────────────────────────────────────────────────────────────

export interface ThreadSummary {
  threadId: string
  slug: string
  mode: string
  repo: string
  lastState?: string
  branch?: string
  prUrl?: string
  dagNodeId?: string
  splitLabel?: string
  conversationTail: string[]
  isActive: boolean
}

export interface DiagnosticEvidence {
  /** The thread where /doctor was invoked. */
  currentThread: ThreadSummary
  /** Parent thread summary, if this is a child session. */
  parentThread?: ThreadSummary
  /** Child thread summaries, if this thread has children. */
  childThreads: ThreadSummary[]
  /** DAG graph status rendering, if a DAG is associated. */
  dagStatus?: string
  /** DAG progress counts, if a DAG is associated. */
  dagProgress?: ReturnType<typeof dagProgress>
  /** Nodes with errors or failures in the DAG. */
  dagFailedNodes: Array<{ id: string; title: string; status: string; error?: string }>
  /** Telegram chat ID for generating thread links. */
  chatId?: number | string
}

// ── Constants ──────────────────────────────────────────────────────────

const MAX_TAIL_MESSAGES = 6
const MAX_MESSAGE_CHARS = 500

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Summarize a thread by extracting session metadata and the tail
 * of its conversation history.
 */
export function summarizeThread(
  session: TopicSession,
  isActive: boolean,
): ThreadSummary {
  return {
    threadId: session.threadId,
    slug: session.slug,
    mode: session.mode,
    repo: session.repo,
    lastState: session.lastState,
    branch: session.branch,
    prUrl: session.prUrl,
    dagNodeId: session.dagNodeId,
    splitLabel: session.splitLabel,
    conversationTail: extractConversationTail(session.conversation),
    isActive,
  }
}

/**
 * Extract the last N messages from a conversation, truncating each
 * to a reasonable length. Returns an array of "Role: text" strings.
 */
export function extractConversationTail(
  conversation: TopicMessage[],
  maxMessages = MAX_TAIL_MESSAGES,
  maxChars = MAX_MESSAGE_CHARS,
): string[] {
  const tail = conversation.slice(-maxMessages)
  return tail.map((msg) => {
    const label = msg.role === "user" ? "User" : "Agent"
    const text = stripToolNoise(msg.text)
    const truncated = text.length > maxChars
      ? text.slice(0, maxChars).trimEnd() + "…"
      : text
    return `${label}: ${truncated}`
  })
}

// ── Evidence gathering ─────────────────────────────────────────────────

export interface GatherEvidenceOptions {
  /** The thread where /doctor was invoked. */
  currentSession: TopicSession
  /** Whether the current session has an active running agent. */
  isCurrentActive: boolean
  /** Lookup function: threadId → TopicSession | undefined */
  getSession: (threadId: string) => TopicSession | undefined
  /** Lookup function: threadId → boolean (is session actively running) */
  isSessionActive: (threadId: string) => boolean
  /** Lookup function: dagId → DagGraph | undefined */
  getDag: (dagId: string) => DagGraph | undefined
  /** Telegram chat ID for generating thread links. */
  chatId?: number | string
}

/**
 * Gather all diagnostic evidence relevant to the thread where
 * /doctor was invoked. Walks parent/child relationships, collects
 * conversation tails, DAG status, and error information.
 */
export function gatherDiagnosticEvidence(opts: GatherEvidenceOptions): DiagnosticEvidence {
  const {
    currentSession,
    isCurrentActive,
    getSession,
    isSessionActive,
    getDag,
    chatId,
  } = opts

  const currentThread = summarizeThread(currentSession, isCurrentActive)

  // Resolve parent
  let parentThread: ThreadSummary | undefined
  if (currentSession.parentThreadId != null) {
    const parentSession = getSession(currentSession.parentThreadId)
    if (parentSession) {
      parentThread = summarizeThread(parentSession, isSessionActive(parentSession.threadId))
    }
  }

  // Resolve children — from current thread or from parent
  const parentForChildren = parentThread ? getSession(currentSession.parentThreadId!) : currentSession
  const childThreadIds = parentForChildren?.childThreadIds ?? []
  const childThreads: ThreadSummary[] = []
  for (const childId of childThreadIds) {
    const childSession = getSession(childId)
    if (childSession) {
      childThreads.push(summarizeThread(childSession, isSessionActive(childId)))
    }
  }

  // Resolve DAG — from current thread, parent, or walk up
  const dagId = currentSession.dagId
    ?? (parentThread ? getSession(currentSession.parentThreadId!)?.dagId : undefined)
  let dagStatus: string | undefined
  let dagProg: ReturnType<typeof dagProgress> | undefined
  const dagFailedNodes: DiagnosticEvidence["dagFailedNodes"] = []

  if (dagId) {
    const graph = getDag(dagId)
    if (graph) {
      dagStatus = renderDagStatus(graph)
      dagProg = dagProgress(graph)
      for (const node of graph.nodes) {
        if (node.status === "failed" || node.status === "ci-failed" || node.status === "skipped") {
          dagFailedNodes.push({
            id: node.id,
            title: node.title,
            status: node.status,
            error: node.error,
          })
        }
      }
    }
  }

  return {
    currentThread,
    parentThread,
    childThreads,
    dagStatus,
    dagProgress: dagProg,
    dagFailedNodes,
    chatId,
  }
}

// ── Prompt building ────────────────────────────────────────────────────

/**
 * Build a diagnostic task prompt from gathered evidence.
 * This prompt is given to a planning session that will analyze
 * the situation and propose a fix.
 */
export function buildDoctorPrompt(evidence: DiagnosticEvidence): string {
  const lines: string[] = []

  lines.push("## Diagnostic report")
  lines.push("")
  lines.push("You are a diagnostic agent. A user ran `/doctor` because something went wrong with their minions coordination. Analyze the evidence below, identify the root cause, and propose a concrete fix plan.")
  lines.push("")

  // Current thread
  lines.push("### Current thread")
  lines.push("")
  lines.push(formatThreadBlock(evidence.currentThread, evidence.chatId))
  lines.push("")

  // Parent thread
  if (evidence.parentThread) {
    lines.push("### Parent thread")
    lines.push("")
    lines.push(formatThreadBlock(evidence.parentThread, evidence.chatId))
    lines.push("")
  }

  // Child threads
  if (evidence.childThreads.length > 0) {
    lines.push("### Child threads")
    lines.push("")
    for (const child of evidence.childThreads) {
      lines.push(formatThreadBlock(child, evidence.chatId))
      lines.push("")
    }
  }

  // DAG status
  if (evidence.dagStatus) {
    lines.push("### DAG status")
    lines.push("")
    lines.push(stripHtmlTags(evidence.dagStatus))
    lines.push("")

    if (evidence.dagProgress) {
      const p = evidence.dagProgress
      lines.push(`Progress: ${p.done}/${p.total} done, ${p.running} running, ${p.failed} failed, ${p.skipped} skipped, ${p.ciPending} CI pending, ${p.ciFailed} CI failed`)
      lines.push("")
    }
  }

  // Failed/problematic nodes
  if (evidence.dagFailedNodes.length > 0) {
    lines.push("### Failed/problematic nodes")
    lines.push("")
    for (const node of evidence.dagFailedNodes) {
      lines.push(`- **${node.id}** (${node.title}): status=${node.status}${node.error ? ` — error: ${node.error}` : ""}`)
    }
    lines.push("")
  }

  // Instructions
  lines.push("### Instructions")
  lines.push("")
  lines.push("1. Identify the root cause: Why did the coordination fail? Common issues include:")
  lines.push("   - A child session completed but the parent didn't advance to the next DAG node")
  lines.push("   - A session errored but the error wasn't propagated correctly")
  lines.push("   - CI checks failed and the retry mechanism didn't trigger")
  lines.push("   - A quota exhaustion caused a session to stop prematurely")
  lines.push("   - A merge conflict blocked a fan-in node")
  lines.push("2. Propose a concrete fix: What specific actions should be taken to resolve the issue?")
  lines.push("3. If the fix involves code changes, describe exactly what needs to change and where.")
  lines.push("4. If the fix involves manual intervention (e.g., re-running a node, force-advancing a DAG), describe the steps.")
  lines.push("")

  return lines.join("\n")
}

/**
 * Format a single thread summary as a readable text block.
 */
function formatThreadBlock(summary: ThreadSummary, chatId?: number | string): string {
  const lines: string[] = []

  const link = threadLink(chatId, summary.threadId)
  const slugDisplay = link ? `[${summary.slug}](${link})` : summary.slug

  lines.push(`**${slugDisplay}** — ${summary.mode} mode`)

  const details: string[] = []
  details.push(`repo: ${summary.repo}`)
  if (summary.lastState) details.push(`state: ${summary.lastState}`)
  if (summary.isActive) details.push("currently running")
  if (summary.branch) details.push(`branch: ${summary.branch}`)
  if (summary.prUrl) details.push(`PR: ${summary.prUrl}`)
  if (summary.dagNodeId) details.push(`DAG node: ${summary.dagNodeId}`)
  if (summary.splitLabel) details.push(`label: ${summary.splitLabel}`)
  lines.push(details.join(" · "))

  if (summary.conversationTail.length > 0) {
    lines.push("")
    lines.push("Recent messages:")
    for (const msg of summary.conversationTail) {
      lines.push(`> ${msg}`)
    }
  }

  return lines.join("\n")
}

/**
 * Strip HTML tags from a string (for converting Telegram HTML to plain text).
 */
function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, "")
}

/**
 * Strip tool call/result noise from message text.
 */
function stripToolNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "[code block]")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
