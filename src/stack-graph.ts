import type { StackNode, StackMetadata, StackNodeStatus } from "./types.js"

/**
 * StackGraph provides operations for managing the DAG structure of stacked minions.
 * Supports linear chains, tree structures, and diamond dependencies.
 */
export class StackGraph {
  constructor(private readonly metadata: StackMetadata) {}

  /**
   * Get a node by ID
   */
  getNode(id: string): StackNode | undefined {
    return this.metadata.nodes.get(id)
  }

  /**
   * Get all nodes
   */
  getAllNodes(): StackNode[] {
    return Array.from(this.metadata.nodes.values())
  }

  /**
   * Get root nodes (nodes with no dependencies)
   */
  getRoots(): StackNode[] {
    return this.getAllNodes().filter((node) => node.dependencies.length === 0)
  }

  /**
   * Get leaf nodes (nodes that nothing depends on)
   */
  getLeaves(): StackNode[] {
    const dependedOn = new Set<string>()
    for (const node of this.getAllNodes()) {
      for (const dep of node.dependencies) {
        dependedOn.add(dep)
      }
    }
    return this.getAllNodes().filter((node) => !dependedOn.has(node.id))
  }

  /**
   * Get children of a node (nodes that depend on this node)
   */
  getChildren(nodeId: string): StackNode[] {
    return this.getAllNodes().filter((node) => node.dependencies.includes(nodeId))
  }

  /**
   * Get all descendants of a node (transitive children)
   */
  getDescendants(nodeId: string): StackNode[] {
    const descendants: StackNode[] = []
    const visited = new Set<string>()
    const queue = [nodeId]

    while (queue.length > 0) {
      const current = queue.shift()!
      for (const child of this.getChildren(current)) {
        if (!visited.has(child.id)) {
          visited.add(child.id)
          descendants.push(child)
          queue.push(child.id)
        }
      }
    }

    return descendants
  }

  /**
   * Get nodes that are ready to execute (all dependencies satisfied)
   */
  getReadyNodes(completed: Set<string>): StackNode[] {
    return this.getAllNodes().filter(
      (node) =>
        node.status === "pending" &&
        node.dependencies.every((dep) => completed.has(dep)),
    )
  }

  /**
   * Get the base branch for a node.
   * - Root nodes: "main"
   * - Single dependency: parent's branch
   * - Multiple dependencies: merge base of all parent branches
   */
  getBaseBranch(nodeId: string): string {
    const node = this.getNode(nodeId)
    if (!node) return "main"

    if (node.dependencies.length === 0) {
      return "main"
    }

    if (node.dependencies.length === 1) {
      const parent = this.getNode(node.dependencies[0]!)
      return parent?.branch ?? "main"
    }

    // For multiple dependencies, return the first parent's branch
    // The orchestrator will need to merge all parent branches
    const firstParent = this.getNode(node.dependencies[0]!)
    return firstParent?.branch ?? "main"
  }

  /**
   * Get all parent branches for a node (for multi-parent merge scenarios)
   */
  getParentBranches(nodeId: string): string[] {
    const node = this.getNode(nodeId)
    if (!node) return ["main"]

    if (node.dependencies.length === 0) {
      return ["main"]
    }

    return node.dependencies
      .map((depId) => this.getNode(depId)?.branch)
      .filter((branch): branch is string => branch !== undefined)
  }

  /**
   * Validate that the graph is a valid DAG (no cycles)
   * Returns true if valid, false if cycles detected
   */
  validateDAG(): { valid: boolean; cycle?: string[] } {
    const visited = new Set<string>()
    const recursionStack = new Set<string>()
    const path: string[] = []

    for (const node of this.getAllNodes()) {
      if (!visited.has(node.id)) {
        const cycle = this.detectCycle(node.id, visited, recursionStack, path)
        if (cycle) {
          return { valid: false, cycle }
        }
      }
    }

    return { valid: true }
  }

  private detectCycle(
    nodeId: string,
    visited: Set<string>,
    recursionStack: Set<string>,
    path: string[],
  ): string[] | null {
    visited.add(nodeId)
    recursionStack.add(nodeId)
    path.push(nodeId)

    const node = this.getNode(nodeId)
    if (node) {
      for (const depId of node.dependencies) {
        if (!visited.has(depId)) {
          const cycle = this.detectCycle(depId, visited, recursionStack, path)
          if (cycle) return cycle
        } else if (recursionStack.has(depId)) {
          // Found cycle - extract it
          const cycleStart = path.indexOf(depId)
          return path.slice(cycleStart)
        }
      }
    }

    path.pop()
    recursionStack.delete(nodeId)
    return null
  }

  /**
   * Get nodes in topological order (dependencies before dependents)
   */
  topologicalSort(): StackNode[] {
    const result: StackNode[] = []
    const visited = new Set<string>()
    const temp = new Set<string>()

    const visit = (nodeId: string) => {
      if (visited.has(nodeId)) return
      if (temp.has(nodeId)) {
        throw new Error(`Cycle detected at node ${nodeId}`)
      }

      temp.add(nodeId)

      const node = this.getNode(nodeId)
      if (node) {
        for (const depId of node.dependencies) {
          visit(depId)
        }
        visited.add(nodeId)
        result.push(node)
      }

      temp.delete(nodeId)
    }

    for (const node of this.getAllNodes()) {
      visit(node.id)
    }

    return result
  }

  /**
   * Calculate the depth/level of each node (root = 0)
   */
  getNodeDepths(): Map<string, number> {
    const depths = new Map<string, number>()

    const calculate = (nodeId: string): number => {
      if (depths.has(nodeId)) {
        return depths.get(nodeId)!
      }

      const node = this.getNode(nodeId)
      if (!node || node.dependencies.length === 0) {
        depths.set(nodeId, 0)
        return 0
      }

      const maxParentDepth = Math.max(...node.dependencies.map((dep) => calculate(dep)))
      const depth = maxParentDepth + 1
      depths.set(nodeId, depth)
      return depth
    }

    for (const node of this.getAllNodes()) {
      calculate(node.id)
    }

    return depths
  }

  /**
   * Get a summary of the graph structure for display
   */
  getSummary(): { total: number; byStatus: Record<StackNodeStatus, number>; maxDepth: number } {
    const nodes = this.getAllNodes()
    const byStatus: Record<StackNodeStatus, number> = {
      pending: 0,
      running: 0,
      completed: 0,
      errored: 0,
      blocked: 0,
      merged: 0,
    }

    for (const node of nodes) {
      byStatus[node.status]++
    }

    const depths = this.getNodeDepths()
    const maxDepth = Math.max(0, ...depths.values())

    return {
      total: nodes.length,
      byStatus,
      maxDepth,
    }
  }

  /**
   * Update a node's status
   */
  updateNodeStatus(nodeId: string, status: StackNodeStatus, error?: string): void {
    const node = this.metadata.nodes.get(nodeId)
    if (node) {
      node.status = status
      if (error !== undefined) {
        node.error = error
      }
    }
  }

  /**
   * Update a node's branch and worktree info
   */
  updateNodeBranchInfo(nodeId: string, branch: string, worktree: string): void {
    const node = this.metadata.nodes.get(nodeId)
    if (node) {
      node.branch = branch
      node.worktree = worktree
    }
  }

  /**
   * Update a node's thread ID and PR URL
   */
  updateNodeSpawnInfo(nodeId: string, threadId: number, prUrl?: string): void {
    const node = this.metadata.nodes.get(nodeId)
    if (node) {
      node.threadId = threadId
      if (prUrl !== undefined) {
        node.prUrl = prUrl
      }
    }
  }
}

/**
 * Create a new stack from a list of items with dependency information.
 * Supports linear chains, tree structures, and custom DAGs.
 */
export function createStackMetadata(
  stackId: string,
  slug: string,
  parentThreadId: number,
  repoUrl: string | undefined,
  items: Array<{ id: string; title: string; description: string; dependencies: string[] }>,
  mode: "sequential" | "parallel" | "auto" = "auto",
  mergeStrategy: "manual" | "auto" | "merge-queue" = "manual",
): StackMetadata {
  const nodes = new Map<string, StackNode>()

  for (const item of items) {
    nodes.set(item.id, {
      id: item.id,
      title: item.title,
      description: item.description,
      dependencies: item.dependencies,
      status: "pending",
    })
  }

  return {
    stackId,
    slug,
    nodes,
    mode,
    mergeStrategy,
    parentThreadId,
    repoUrl,
    createdAt: Date.now(),
  }
}

/**
 * Build a linear stack from a list of items (each depends on the previous)
 */
export function buildLinearStack(
  stackId: string,
  slug: string,
  parentThreadId: number,
  repoUrl: string | undefined,
  items: Array<{ title: string; description: string }>,
  mode: "sequential" | "parallel" | "auto" = "sequential",
  mergeStrategy: "manual" | "auto" | "merge-queue" = "manual",
): StackMetadata {
  const stackItems = items.map((item, index) => ({
    id: `${stackId}-${index + 1}`,
    title: item.title,
    description: item.description,
    dependencies: index === 0 ? [] : [`${stackId}-${index}`],
  }))

  return createStackMetadata(stackId, slug, parentThreadId, repoUrl, stackItems, mode, mergeStrategy)
}
