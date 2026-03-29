import { execSync } from "node:child_process"
import { DagCycleError, DagSelfDependencyError, UnknownNodeError } from "./errors.js"

export type DagNodeStatus = "pending" | "ready" | "running" | "done" | "failed" | "skipped" | "ci-pending" | "ci-failed" | "landed"

export interface DagNode {
  id: string
  title: string
  description: string
  dependsOn: string[]
  status: DagNodeStatus
  threadId?: number
  branch?: string
  prUrl?: string
  error?: string
  recoveryAttempted?: boolean
  mergeBase?: string
}

export interface DagGraph {
  id: string
  nodes: DagNode[]
  parentThreadId: number
  repoUrl?: string
  repo: string
  createdAt: number
}

export interface DagInput {
  id: string
  title: string
  description: string
  dependsOn: string[]
}

/**
 * Detect a cycle in the DAG and return the nodes involved.
 * Uses DFS to find the first cycle path.
 */
function findCycle(nodes: DagNode[] | DagInput[]): string[] {
  const visited = new Set<string>()
  const recursionStack = new Set<string>()
  const path: string[] = []
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))

  function dfs(nodeId: string): string[] | null {
    if (recursionStack.has(nodeId)) {
      // Found a cycle - return the path from this node back to itself
      const cycleStart = path.indexOf(nodeId)
      return path.slice(cycleStart)
    }
    if (visited.has(nodeId)) return null

    visited.add(nodeId)
    recursionStack.add(nodeId)
    path.push(nodeId)

    const node = nodeMap.get(nodeId)
    if (node) {
      for (const dep of node.dependsOn) {
        const cycle = dfs(dep)
        if (cycle) return cycle
      }
    }

    recursionStack.delete(nodeId)
    path.pop()
    return null
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      const cycle = dfs(node.id)
      if (cycle) return cycle
    }
  }

  return []
}

/**
 * Build a DagGraph from extracted items.
 * Validates acyclicity and referential integrity.
 */
export function buildDag(
  dagId: string,
  items: DagInput[],
  parentThreadId: number,
  repo: string,
  repoUrl?: string,
): DagGraph {
  const ids = new Set(items.map((i) => i.id))

  // Validate: all dependsOn references exist
  for (const item of items) {
    for (const dep of item.dependsOn) {
      if (!ids.has(dep)) {
        throw new UnknownNodeError(item.id, dep, Array.from(ids))
      }
    }
    if (item.dependsOn.includes(item.id)) {
      throw new DagSelfDependencyError(item.id)
    }
  }

  const nodes: DagNode[] = items.map((item) => ({
    id: item.id,
    title: item.title,
    description: item.description,
    dependsOn: [...item.dependsOn],
    status: "pending",
  }))

  const graph: DagGraph = {
    id: dagId,
    nodes,
    parentThreadId,
    repo,
    repoUrl,
    createdAt: Date.now(),
  }

  // Validate acyclicity
  const sorted = topologicalSort(graph)
  if (sorted.length !== nodes.length) {
    const cycleNodes = findCycle(nodes)
    throw new DagCycleError(cycleNodes)
  }

  // Set initial ready status for nodes with no dependencies
  for (const node of nodes) {
    if (node.dependsOn.length === 0) {
      node.status = "ready"
    }
  }

  return graph
}

/**
 * Build a linear DAG (stack) from ordered items.
 * Each item depends on the previous one.
 */
export function buildLinearDag(
  dagId: string,
  items: { title: string; description: string }[],
  parentThreadId: number,
  repo: string,
  repoUrl?: string,
): DagGraph {
  const dagItems: DagInput[] = items.map((item, i) => ({
    id: `step-${i}`,
    title: item.title,
    description: item.description,
    dependsOn: i > 0 ? [`step-${i - 1}`] : [],
  }))

  return buildDag(dagId, dagItems, parentThreadId, repo, repoUrl)
}

/**
 * Kahn's algorithm for topological sort.
 * Returns node IDs in topological order, or a shorter array if cycles exist.
 */
export function topologicalSort(graph: DagGraph): string[] {
  const inDegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()

  for (const node of graph.nodes) {
    inDegree.set(node.id, node.dependsOn.length)
    adjacency.set(node.id, [])
  }

  for (const node of graph.nodes) {
    for (const dep of node.dependsOn) {
      adjacency.get(dep)!.push(node.id)
    }
  }

  const queue: string[] = []
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id)
  }

  const sorted: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    sorted.push(id)
    for (const neighbor of adjacency.get(id)!) {
      const newDegree = inDegree.get(neighbor)! - 1
      inDegree.set(neighbor, newDegree)
      if (newDegree === 0) queue.push(neighbor)
    }
  }

  return sorted
}

/**
 * Get nodes that are ready to execute (all dependencies done).
 */
export function readyNodes(graph: DagGraph): DagNode[] {
  return graph.nodes.filter((node) => node.status === "ready")
}

/**
 * Recompute which pending nodes are now ready (all deps done).
 * Call this after a node completes.
 */
export function advanceDag(graph: DagGraph): DagNode[] {
  const statusMap = new Map(graph.nodes.map((n) => [n.id, n.status]))
  const newlyReady: DagNode[] = []

  for (const node of graph.nodes) {
    if (node.status !== "pending") continue

    const allDepsDone = node.dependsOn.every((dep) => statusMap.get(dep) === "done")
    if (allDepsDone) {
      node.status = "ready"
      newlyReady.push(node)
    }
  }

  return newlyReady
}

/**
 * Mark a node as failed and skip all transitive dependents.
 * Returns the list of skipped node IDs.
 */
export function failNode(graph: DagGraph, nodeId: string): string[] {
  const node = graph.nodes.find((n) => n.id === nodeId)
  if (!node) return []

  node.status = "failed"

  const skipped: string[] = []
  const toSkip = new Set<string>()

  // BFS to find all transitive dependents
  const queue = [nodeId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const n of graph.nodes) {
      if (n.dependsOn.includes(current) && !toSkip.has(n.id) && n.status !== "done") {
        toSkip.add(n.id)
        queue.push(n.id)
      }
    }
  }

  for (const id of toSkip) {
    const dependent = graph.nodes.find((n) => n.id === id)!
    dependent.status = "skipped"
    dependent.error = `Skipped: upstream node "${nodeId}" failed`
    skipped.push(id)
  }

  return skipped
}

/**
 * Reset a failed node to "ready" and un-skip its transitive dependents.
 * Returns the list of un-skipped node IDs.
 */
export function resetFailedNode(graph: DagGraph, nodeId: string): string[] {
  const node = graph.nodes.find((n) => n.id === nodeId)
  if (!node || (node.status !== "failed" && node.status !== "ci-failed")) return []

  node.status = "ready"
  node.error = undefined
  node.recoveryAttempted = false

  const reset: string[] = []
  const queue = [nodeId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const n of graph.nodes) {
      if (n.dependsOn.includes(current) && n.status === "skipped") {
        n.status = "pending"
        n.error = undefined
        reset.push(n.id)
        queue.push(n.id)
      }
    }
  }
  return reset
}

/**
 * Check if the entire DAG is complete (all nodes done, failed, or skipped).
 */
export function isDagComplete(graph: DagGraph): boolean {
  return graph.nodes.every((n) =>
    n.status === "done" || n.status === "failed" || n.status === "skipped" || n.status === "ci-failed" || n.status === "landed",
  )
}

/**
 * Get the upstream branches for a node (the branches of its direct dependencies).
 * Used to determine the base branch for workspace creation.
 */
export function getUpstreamBranches(graph: DagGraph, nodeId: string): string[] {
  const node = graph.nodes.find((n) => n.id === nodeId)
  if (!node) return []

  return node.dependsOn
    .map((depId) => graph.nodes.find((n) => n.id === depId)?.branch)
    .filter((b): b is string => b != null)
}

/**
 * Get all transitive downstream nodes (direct and indirect dependents).
 */
export function getDownstreamNodes(graph: DagGraph, nodeId: string): DagNode[] {
  const downstream = new Set<string>()
  const queue = [nodeId]

  while (queue.length > 0) {
    const current = queue.shift()!
    for (const node of graph.nodes) {
      if (node.dependsOn.includes(current) && !downstream.has(node.id)) {
        downstream.add(node.id)
        queue.push(node.id)
      }
    }
  }

  return graph.nodes.filter((n) => downstream.has(n.id))
}

/**
 * Identify downstream nodes that need restacking after an upstream node changed.
 *
 * A node needs restacking when:
 * 1. It has a branch (already started work)
 * 2. It has a recorded mergeBase (the commit it was originally based on)
 * 3. It is a transitive dependent of the changed node
 * 4. It is not in a terminal state (done/failed/skipped)
 *
 * Returns nodes in topological order so they can be restacked parent-first.
 */
export function needsRestack(graph: DagGraph, changedNodeId: string): DagNode[] {
  const sorted = topologicalSort(graph)
  const downstream = getDownstreamNodes(graph, changedNodeId)
  const downstreamIds = new Set(downstream.map((n) => n.id))

  return sorted
    .filter((id) => downstreamIds.has(id))
    .map((id) => graph.nodes.find((n) => n.id === id)!)
    .filter((node) =>
      node.branch != null &&
      node.mergeBase != null &&
      node.status !== "done" &&
      node.status !== "failed" &&
      node.status !== "skipped" &&
      node.status !== "landed",
    )
}

/**
 * Compute the critical path length (longest path through the DAG).
 */
export function criticalPathLength(graph: DagGraph): number {
  const sorted = topologicalSort(graph)
  const dist = new Map<string, number>()

  for (const id of sorted) {
    const node = graph.nodes.find((n) => n.id === id)!
    const maxDepDist = node.dependsOn.length > 0
      ? Math.max(...node.dependsOn.map((d) => dist.get(d) ?? 0))
      : 0
    dist.set(id, maxDepDist + 1)
  }

  return dist.size > 0 ? Math.max(...dist.values()) : 0
}

/**
 * Get DAG progress summary.
 */
export function dagProgress(graph: DagGraph): {
  total: number
  done: number
  running: number
  ready: number
  pending: number
  failed: number
  skipped: number
  ciPending: number
  ciFailed: number
  landed: number
} {
  const counts = { total: 0, done: 0, running: 0, ready: 0, pending: 0, failed: 0, skipped: 0, ciPending: 0, ciFailed: 0, landed: 0 }
  for (const node of graph.nodes) {
    counts.total++
    if (node.status === "ci-pending") counts.ciPending++
    else if (node.status === "ci-failed") counts.ciFailed++
    else if (node.status === "landed") counts.landed++
    else counts[node.status]++
  }
  return counts
}

/**
 * Compute the transitive reduction of the DAG.
 * Removes redundant edges (A→C when A→B→C exists).
 */
export function transitiveReduction(graph: DagGraph): void {
  // For each node, compute all transitive ancestors
  const ancestors = new Map<string, Set<string>>()

  const sorted = topologicalSort(graph)
  for (const id of sorted) {
    const node = graph.nodes.find((n) => n.id === id)!
    const myAncestors = new Set<string>()

    for (const dep of node.dependsOn) {
      myAncestors.add(dep)
      const depAncestors = ancestors.get(dep)
      if (depAncestors) {
        for (const a of depAncestors) myAncestors.add(a)
      }
    }

    ancestors.set(id, myAncestors)
  }

  // Remove edges to nodes that are already reachable transitively
  for (const node of graph.nodes) {
    if (node.dependsOn.length <= 1) continue

    const toRemove: string[] = []
    for (const dep of node.dependsOn) {
      // Check if dep is an ancestor of any other dep
      const otherDeps = node.dependsOn.filter((d) => d !== dep)
      const isRedundant = otherDeps.some((other) => ancestors.get(other)?.has(dep))
      if (isRedundant) toRemove.push(dep)
    }

    node.dependsOn = node.dependsOn.filter((d) => !toRemove.includes(d))
  }
}

/**
 * Render the DAG as an ASCII status display for Telegram.
 */
export function renderDagStatus(graph: DagGraph, isStack?: boolean): string {
  const statusIcon: Record<DagNodeStatus, string> = {
    pending: "⏳",
    ready: "🔜",
    running: "⚡",
    done: "✅",
    failed: "❌",
    skipped: "⏭️",
    "ci-pending": "🔄",
    "ci-failed": "⚠️",
    landed: "🏁",
  }

  const progress = dagProgress(graph)
  const sorted = topologicalSort(graph)

  // Auto-detect stack if not specified (linear DAG where each node has at most one dep)
  const isLinearStack = isStack ?? (
    !graph.nodes.some((n) => n.dependsOn.length > 1) &&
    graph.nodes.every((n, i) => i === 0 || n.dependsOn.length === 1)
  )
  const title = isLinearStack ? "📚 Stack Status" : "🔗 DAG Status"
  const lines: string[] = [`📊 <b>${title}</b>\n`]

  // Group nodes by their depth level for visual hierarchy
  const depth = new Map<string, number>()
  for (const id of sorted) {
    const node = graph.nodes.find((n) => n.id === id)!
    const maxDepDepth = node.dependsOn.length > 0
      ? Math.max(...node.dependsOn.map((d) => depth.get(d) ?? 0))
      : -1
    depth.set(id, maxDepDepth + 1)
  }

  for (const id of sorted) {
    const node = graph.nodes.find((n) => n.id === id)!
    const d = depth.get(id) ?? 0
    const indent = "  ".repeat(d)
    const icon = statusIcon[node.status]
    const prSuffix = node.prUrl ? ` (<a href="${node.prUrl}">PR</a>)` : ""
    const depSuffix = node.dependsOn.length > 0
      ? ` ← ${node.dependsOn.join(", ")}`
      : ""

    const title = escapeHtml(node.title)
    const styledTitle = node.status === "done" || node.status === "skipped" || node.status === "landed"
      ? `<s>${title}</s>`
      : node.status === "running" || node.status === "failed"
        ? `<b>${title}</b>`
        : title
    lines.push(`${indent}${icon} ${styledTitle}${prSuffix}${depSuffix}`)
  }

  lines.push("")
  lines.push(
    `Progress: ${progress.done}/${progress.total} complete` +
    (progress.landed > 0 ? `, ${progress.landed} landed` : "") +
    (progress.running > 0 ? `, ${progress.running} running` : "") +
    (progress.ciPending > 0 ? `, ${progress.ciPending} awaiting CI` : "") +
    (progress.failed > 0 ? `, ${progress.failed} failed` : "") +
    (progress.ciFailed > 0 ? `, ${progress.ciFailed} CI failed` : "") +
    (progress.skipped > 0 ? `, ${progress.skipped} skipped` : ""),
  )

  return lines.join("\n")
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const DAG_STATUS_START = "<!-- dag-status-start -->"
const DAG_STATUS_END = "<!-- dag-status-end -->"

export { DAG_STATUS_START, DAG_STATUS_END }

const statusEmoji: Record<DagNodeStatus, string> = {
  pending: "⏳",
  ready: "🔜",
  running: "⚡",
  done: "✅",
  failed: "❌",
  skipped: "⏭️",
  "ci-pending": "🔄",
  "ci-failed": "⚠️",
  landed: "🏁",
}

const statusLabel: Record<DagNodeStatus, string> = {
  pending: "Pending",
  ready: "Ready",
  running: "Running",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
  "ci-pending": "CI Pending",
  "ci-failed": "CI Failed",
  landed: "Landed",
}

/**
 * Sanitize a node ID for use in mermaid (alphanumeric + hyphens only).
 */
function mermaidId(id: string): string {
  return id.replace(/[^a-zA-Z0-9-]/g, "_")
}

/**
 * Escape text for mermaid node labels (double-quote wrapping handles most cases).
 */
function mermaidLabel(text: string): string {
  return text.replace(/"/g, "'")
}

/**
 * Render the DAG as a GitHub-flavored markdown section with a mermaid flowchart
 * and a status table. The output is wrapped in HTML comment markers for
 * idempotent replacement in PR descriptions.
 *
 * @param graph - The DAG graph to render
 * @param currentNodeId - Optional ID of the "current" node (the one this PR belongs to)
 */
export function renderDagForGitHub(graph: DagGraph, currentNodeId?: string): string {
  if (graph.nodes.length === 0) {
    return [DAG_STATUS_START, "", "_No tasks in DAG._", "", DAG_STATUS_END].join("\n")
  }

  const sorted = topologicalSort(graph)
  const lines: string[] = [DAG_STATUS_START, ""]

  // --- Mermaid flowchart ---
  lines.push("```mermaid")
  lines.push("flowchart TD")

  // Class definitions for statuses
  lines.push("  classDef done fill:#2da44e,stroke:#1a7f37,color:#fff")
  lines.push("  classDef running fill:#bf8700,stroke:#9a6700,color:#fff")
  lines.push("  classDef pending fill:#656d76,stroke:#424a53,color:#fff")
  lines.push("  classDef ready fill:#0969da,stroke:#0550ae,color:#fff")
  lines.push("  classDef failed fill:#cf222e,stroke:#a40e26,color:#fff")
  lines.push("  classDef skipped fill:#656d76,stroke:#424a53,color:#fff,stroke-dasharray: 5 5")
  lines.push("  classDef ci-pending fill:#0969da,stroke:#0550ae,color:#fff,stroke-dasharray: 3 3")
  lines.push("  classDef ci-failed fill:#bf8700,stroke:#9a6700,color:#fff")
  lines.push("  classDef landed fill:#1a7f37,stroke:#116329,color:#fff")
  lines.push("  classDef current stroke:#bf8700,stroke-width:3px")

  // Node declarations
  for (const id of sorted) {
    const node = graph.nodes.find((n) => n.id === id)!
    const mid = mermaidId(id)
    const icon = statusEmoji[node.status]
    const label = mermaidLabel(node.title)
    lines.push(`  ${mid}["${icon} ${label}"]`)
  }

  // Edges
  for (const id of sorted) {
    const node = graph.nodes.find((n) => n.id === id)!
    for (const dep of node.dependsOn) {
      lines.push(`  ${mermaidId(dep)} --> ${mermaidId(id)}`)
    }
  }

  // Apply status classes
  for (const id of sorted) {
    const node = graph.nodes.find((n) => n.id === id)!
    const mid = mermaidId(id)
    lines.push(`  class ${mid} ${node.status}`)
    if (currentNodeId && id === currentNodeId) {
      lines.push(`  class ${mid} current`)
    }
  }

  lines.push("```")
  lines.push("")

  // --- Status table ---
  lines.push("| # | Task | Status | PR |")
  lines.push("|---|------|--------|----|")

  for (let i = 0; i < sorted.length; i++) {
    const id = sorted[i]
    const node = graph.nodes.find((n) => n.id === id)!
    const isCurrent = currentNodeId === id
    const num = String(i + 1)
    const title = isCurrent ? `**${node.title}** _(this PR)_` : node.title
    const status = `${statusEmoji[node.status]} ${statusLabel[node.status]}`
    const pr = node.prUrl ? `[PR](${node.prUrl})` : "—"
    lines.push(`| ${num} | ${title} | ${status} | ${pr} |`)
  }

  const progress = dagProgress(graph)
  lines.push("")
  lines.push(
    `**Progress:** ${progress.done}/${progress.total} complete` +
    (progress.landed > 0 ? ` · ${progress.landed} landed` : "") +
    (progress.running > 0 ? ` · ${progress.running} running` : "") +
    (progress.ciPending > 0 ? ` · ${progress.ciPending} awaiting CI` : "") +
    (progress.failed > 0 ? ` · ${progress.failed} failed` : "") +
    (progress.ciFailed > 0 ? ` · ${progress.ciFailed} CI failed` : "") +
    (progress.skipped > 0 ? ` · ${progress.skipped} skipped` : ""),
  )

  lines.push("")
  lines.push(DAG_STATUS_END)

  return lines.join("\n")
}

/**
 * Replace or append the DAG status section in a PR body.
 * If the body already contains DAG markers, replaces the content between them.
 * Otherwise appends the section at the end.
 */
export function upsertDagSection(body: string, dagSection: string): string {
  const startIdx = body.indexOf(DAG_STATUS_START)
  const endIdx = body.indexOf(DAG_STATUS_END)

  if (startIdx !== -1 && endIdx !== -1) {
    return body.substring(0, startIdx) + dagSection + body.substring(endIdx + DAG_STATUS_END.length)
  }

  const separator = body.length > 0 && !body.endsWith("\n") ? "\n\n" : body.length > 0 ? "\n" : ""
  return body + separator + dagSection
}

export interface BranchCleanupResult {
  worktreeRemoved: boolean
  remoteBranchDeleted: boolean
}

export function cleanupMergedBranch(
  branch: string,
  worktreePath: string | undefined,
  cwd: string,
  opts?: { timeout?: number },
): BranchCleanupResult {
  const timeout = opts?.timeout ?? 120_000
  const execOpts = { stdio: ["pipe" as const, "pipe" as const, "pipe" as const], timeout, cwd, env: { ...process.env } }
  const result: BranchCleanupResult = { worktreeRemoved: false, remoteBranchDeleted: false }

  if (worktreePath) {
    try {
      execSync(`git worktree remove --force ${JSON.stringify(worktreePath)}`, execOpts)
      result.worktreeRemoved = true
    } catch {
      // Worktree may already be cleaned up
    }
  }

  try {
    execSync(`git push origin --delete ${JSON.stringify(branch)}`, execOpts)
    result.remoteBranchDeleted = true
  } catch {
    // Remote branch may already be deleted (e.g., by GitHub after PR merge)
  }

  return result
}
