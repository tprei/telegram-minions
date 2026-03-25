import { execFile } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs/promises"
import path from "node:path"
import type { StackMetadata, StackNode, StackNodeStatus, TopicSession } from "./types.js"
import { StackGraph, createStackMetadata } from "./stack-graph.js"

const execFileAsync = promisify(execFile)

export interface StackOrchestratorCallbacks {
  /** Called when a node starts execution */
  onNodeStart: (node: StackNode) => Promise<void>
  /** Called when a node completes successfully */
  onNodeComplete: (node: StackNode) => Promise<void>
  /** Called when a node fails */
  onNodeError: (node: StackNode, error: string) => Promise<void>
  /** Called when a node is blocked waiting for dependencies */
  onNodeBlocked: (node: StackNode, blockingDeps: string[]) => Promise<void>
  /** Called when a node's branch needs rebasing */
  onNodeRebase: (node: StackNode) => Promise<void>
  /** Called when a merge conflict is detected */
  onConflict: (node: StackNode, conflictFiles: string[]) => Promise<void>
  /** Called when all nodes are complete */
  onStackComplete: (metadata: StackMetadata) => Promise<void>
  /** Spawn a minion for a node - returns thread ID */
  spawnMinion: (node: StackNode, worktree: string, branch: string, task: string) => Promise<number>
  /** Prepare a worktree for a node */
  prepareWorktree: (node: StackNode, baseBranch: string, parentBranches: string[]) => Promise<string>
}

/**
 * StackOrchestrator manages the execution of stacked minions.
 * Handles DAG-based execution, branch management, and merge coordination.
 */
export class StackOrchestrator {
  private graph: StackGraph
  private runningNodes = new Set<string>()
  private completedNodes = new Set<string>()
  private mergedNodes = new Set<string>()
  private isRunning = false

  constructor(
    private readonly metadata: StackMetadata,
    private readonly callbacks: StackOrchestratorCallbacks,
  ) {
    this.graph = new StackGraph(metadata)
  }

  /**
   * Get the underlying graph for queries
   */
  getGraph(): StackGraph {
    return this.graph
  }

  /**
   * Start executing the stack according to its execution mode
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error("Stack is already running")
    }

    // Validate DAG first
    const validation = this.graph.validateDAG()
    if (!validation.valid) {
      throw new Error(`Invalid stack graph: cycle detected: ${validation.cycle?.join(" -> ")}`)
    }

    this.isRunning = true

    // Initialize completed set from already completed nodes
    for (const node of this.graph.getAllNodes()) {
      if (node.status === "completed" || node.status === "merged") {
        this.completedNodes.add(node.id)
        if (node.status === "merged") {
          this.mergedNodes.add(node.id)
        }
      }
    }

    // Start execution based on mode
    if (this.metadata.mode === "sequential") {
      await this.executeSequential()
    } else {
      await this.executeParallel()
    }
  }

  /**
   * Execute nodes sequentially (one at a time, in topological order)
   */
  private async executeSequential(): Promise<void> {
    const sorted = this.graph.topologicalSort()

    for (const node of sorted) {
      if (!this.isRunning) break
      if (node.status !== "pending") continue

      await this.executeNode(node)

      // Wait for completion before moving to next
      // Re-fetch node status as it may have been updated
      const updatedNode = this.graph.getNode(node.id)
      if (!updatedNode || updatedNode.status !== "completed") {
        // Node failed or was blocked, stop sequential execution
        break
      }
    }

    await this.checkCompletion()
  }

  /**
   * Execute nodes in parallel where dependencies allow
   */
  private async executeParallel(): Promise<void> {
    const executeReady = async (): Promise<void> => {
      const ready = this.graph.getReadyNodes(this.completedNodes).filter(
        (n) => n.status === "pending" && !this.runningNodes.has(n.id),
      )

      if (ready.length === 0) {
        return
      }

      // Start all ready nodes in parallel
      const promises = ready.map((node) => this.executeNode(node))
      await Promise.allSettled(promises)

      // Check if more nodes became ready
      if (this.isRunning) {
        await executeReady()
      }
    }

    await executeReady()
    await this.checkCompletion()
  }

  /**
   * Execute a single node
   */
  private async executeNode(node: StackNode): Promise<void> {
    // Check if dependencies are met
    const unmetDeps = node.dependencies.filter((dep) => !this.completedNodes.has(dep))
    if (unmetDeps.length > 0) {
      node.status = "blocked"
      await this.callbacks.onNodeBlocked(node, unmetDeps)
      return
    }

    this.runningNodes.add(node.id)
    node.status = "running"

    try {
      await this.callbacks.onNodeStart(node)

      // Get base branch and parent branches for this node
      const baseBranch = this.graph.getBaseBranch(node.id)
      const parentBranches = this.graph.getParentBranches(node.id)

      // Prepare worktree
      const worktree = await this.callbacks.prepareWorktree(node, baseBranch, parentBranches)
      const branchName = this.generateBranchName(node)
      this.graph.updateNodeBranchInfo(node.id, branchName, worktree)

      // Spawn minion
      const threadId = await this.callbacks.spawnMinion(
        node,
        worktree,
        branchName,
        node.description,
      )
      this.graph.updateNodeSpawnInfo(node.id, threadId)

      // Note: Completion is handled by onNodeComplete callback from outside
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      node.status = "errored"
      node.error = errorMsg
      this.runningNodes.delete(node.id)
      await this.callbacks.onNodeError(node, errorMsg)
    }
  }

  /**
   * Called when a node's minion session completes
   */
  async handleNodeCompletion(nodeId: string, success: boolean, prUrl?: string): Promise<void> {
    const node = this.graph.getNode(nodeId)
    if (!node) return

    this.runningNodes.delete(nodeId)

    if (success) {
      node.status = "completed"
      if (prUrl) {
        node.prUrl = prUrl
      }
      this.completedNodes.add(nodeId)
      await this.callbacks.onNodeComplete(node)

      // Handle merge if auto-merge is enabled
      if (this.metadata.mergeStrategy === "auto") {
        await this.attemptMerge(node)
      }

      // Continue execution if in parallel mode
      if (this.metadata.mode !== "sequential" && this.isRunning) {
        this.executeParallel().catch((err) => {
          process.stderr.write(`stack: parallel execution error: ${err}\n`)
        })
      }
    } else {
      node.status = "errored"
      await this.callbacks.onNodeError(node, "Minion session failed")
    }
  }

  /**
   * Attempt to merge a completed node's PR
   */
  private async attemptMerge(node: StackNode): Promise<boolean> {
    if (!node.prUrl || node.status !== "completed") {
      return false
    }

    try {
      // Extract PR number from URL
      const prMatch = node.prUrl.match(/\/pull\/(\d+)$/)
      if (!prMatch) {
        process.stderr.write(`stack: cannot parse PR URL: ${node.prUrl}\n`)
        return false
      }

      const prNumber = prMatch[1]

      // Merge the PR using gh CLI
      await execFileAsync("gh", ["pr", "merge", prNumber, "--squash", "--delete-branch"], {
        cwd: node.worktree,
      })

      node.status = "merged"
      this.mergedNodes.add(node.id)

      // Rebase children on the merged branch
      await this.rebaseChildren(node)

      return true
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      process.stderr.write(`stack: merge failed for ${node.id}: ${errorMsg}\n`)
      return false
    }
  }

  /**
   * Rebase all children of a merged node
   */
  private async rebaseChildren(parentNode: StackNode): Promise<void> {
    const children = this.graph.getChildren(parentNode.id)

    for (const child of children) {
      if (child.status === "pending" || child.status === "blocked") {
        await this.callbacks.onNodeRebase(child)
      } else if (child.status === "running" || child.status === "completed") {
        // Child already has work - need to rebase its branch
        if (child.worktree && child.branch) {
          try {
            await this.rebaseBranch(child, "main") // After merge, parent is on main
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            child.status = "errored"
            child.error = `Rebase failed: ${errorMsg}`
            await this.callbacks.onNodeError(child, errorMsg)
          }
        }
      }
    }
  }

  /**
   * Rebase a node's branch onto a new base
   */
  async rebaseBranch(node: StackNode, newBase: string): Promise<void> {
    if (!node.worktree || !node.branch) {
      return
    }

    try {
      // Fetch latest
      await execFileAsync("git", ["fetch", "origin"], { cwd: node.worktree })

      // Rebase
      await execFileAsync("git", ["rebase", newBase], { cwd: node.worktree })

      // Force push with lease
      await execFileAsync("git", ["push", "--force-with-lease", "origin", node.branch], {
        cwd: node.worktree,
      })
    } catch (error) {
      // Check for conflicts
      const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
        cwd: node.worktree,
      })
      const conflictFiles = stdout
        .split("\n")
        .filter((line) => line.startsWith("UU") || line.startsWith("AA"))
        .map((line) => line.slice(3))

      if (conflictFiles.length > 0) {
        await this.callbacks.onConflict(node, conflictFiles)
      }

      throw error
    }
  }

  /**
   * Stop the stack execution
   */
  stop(): void {
    this.isRunning = false
  }

  /**
   * Check if all nodes are complete
   */
  private async checkCompletion(): Promise<void> {
    const summary = this.graph.getSummary()
    const allDone =
      summary.byStatus.completed + summary.byStatus.errored + summary.byStatus.merged ===
      summary.total

    if (allDone) {
      await this.callbacks.onStackComplete(this.metadata)
    }
  }

  /**
   * Generate a branch name for a node
   */
  private generateBranchName(node: StackNode): string {
    const safeId = node.id.replace(/[^a-zA-Z0-9-]/g, "-")
    const safeTitle = node.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 30)
      .replace(/^-|-$/g, "")
    return `stack/${this.metadata.slug}/${safeId}-${safeTitle}`
  }

  /**
   * Sync the stack after external changes (e.g., manual merge)
   */
  async syncStack(): Promise<void> {
    // Fetch latest from remote
    for (const node of this.graph.getAllNodes()) {
      if (node.worktree) {
        try {
          await execFileAsync("git", ["fetch", "origin"], { cwd: node.worktree })
        } catch {
          // Ignore fetch errors
        }
      }
    }

    // Check for merged PRs and update status
    for (const node of this.graph.getAllNodes()) {
      if (node.prUrl && node.status === "completed") {
        const prMatch = node.prUrl.match(/\/pull\/(\d+)$/)
        if (prMatch) {
          try {
            const { stdout } = await execFileAsync("gh", [
              "pr",
              "view",
              prMatch[1],
              "--json",
              "state",
            ])
            const pr = JSON.parse(stdout)
            if (pr.state === "MERGED") {
              node.status = "merged"
              this.mergedNodes.add(node.id)
            }
          } catch {
            // Ignore errors
          }
        }
      }
    }
  }
}

/**
 * Extract stack items from a conversation using AI
 * Similar to split extraction but includes dependency information
 */
export interface StackItem {
  id: string
  title: string
  description: string
  dependencies: string[]
}

export interface StackExtractResult {
  items: StackItem[]
  error?: "system" | "parse"
  errorMessage?: string
}

/**
 * Build a stack item with auto-assigned ID
 */
export function createStackItem(
  title: string,
  description: string,
  dependencies: string[] = [],
  idPrefix = "",
): StackItem {
  const id = idPrefix ? `${idPrefix}-${Date.now()}` : `item-${Date.now()}`
  return { id, title, description, dependencies }
}
