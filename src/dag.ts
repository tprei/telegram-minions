export type DagNodeStatus = "pending" | "ready" | "running" | "done" | "failed" | "skipped"

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
        throw new Error(`Node "${item.id}" depends on unknown node "${dep}"`)
      }
    }
    if (item.dependsOn.includes(item.id)) {
      throw new Error(`Node "${item.id}" depends on itself`)
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
    throw new Error("DAG contains a cycle")
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
 * Check if the entire DAG is complete (all nodes done, failed, or skipped).
 */
export function isDagComplete(graph: DagGraph): boolean {
  return graph.nodes.every((n) =>
    n.status === "done" || n.status === "failed" || n.status === "skipped",
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
} {
  const counts = { total: 0, done: 0, running: 0, ready: 0, pending: 0, failed: 0, skipped: 0 }
  for (const node of graph.nodes) {
    counts.total++
    counts[node.status]++
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
export function renderDagStatus(graph: DagGraph): string {
  const statusIcon: Record<DagNodeStatus, string> = {
    pending: "⏳",
    ready: "🔜",
    running: "⚡",
    done: "✅",
    failed: "❌",
    skipped: "⏭️",
  }

  const progress = dagProgress(graph)
  const sorted = topologicalSort(graph)

  const lines: string[] = [`📊 <b>DAG Status</b>\n`]

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

    lines.push(`${indent}${icon} <b>${escapeHtml(node.title)}</b>${prSuffix}${depSuffix}`)
  }

  lines.push("")
  lines.push(
    `Progress: ${progress.done}/${progress.total} complete` +
    (progress.running > 0 ? `, ${progress.running} running` : "") +
    (progress.failed > 0 ? `, ${progress.failed} failed` : "") +
    (progress.skipped > 0 ? `, ${progress.skipped} skipped` : ""),
  )

  return lines.join("\n")
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
