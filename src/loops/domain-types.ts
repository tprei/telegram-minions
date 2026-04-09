// Loop domain types

/** How a loop outcome resolved */
export type LoopOutcomeResult = "pr_opened" | "no_findings" | "errored" | "quota_exhausted" | "skipped_duplicate"

/** Record of a single loop execution */
export interface LoopOutcome {
  runNumber: number
  startedAt: number
  finishedAt: number
  result: LoopOutcomeResult
  prUrl?: string
  error?: string
  threadId?: string
}

/** Persistent state for one loop definition */
export interface LoopState {
  loopId: string
  enabled: boolean
  lastRunAt?: number
  nextRunAt?: number
  consecutiveFailures: number
  totalRuns: number
  outcomes: LoopOutcome[]
  lastPrUrl?: string
}

/** A loop definition — describes what a loop does and how often */
export interface LoopDefinition {
  id: string
  name: string
  repo: string
  intervalMs: number
  prompt: string
  enabled: boolean
  maxConsecutiveFailures?: number
  maxOutcomeHistory?: number
}
