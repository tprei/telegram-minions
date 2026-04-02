// Ship pipeline types

export type ShipPhase = "think" | "plan" | "judge" | "dag" | "verify" | "done"

export interface AutoAdvance {
  phase: ShipPhase
  featureDescription: string
  autoLand: boolean
}

// Verification types

export type VerificationCheckKind = "quality-gates" | "ci" | "completeness-review"

export type VerificationCheckStatus = "pending" | "running" | "passed" | "failed" | "skipped"

export interface VerificationCheck {
  kind: VerificationCheckKind
  status: VerificationCheckStatus
  nodeId: string
  output?: string
  startedAt?: number
  finishedAt?: number
}

export interface VerificationRound {
  round: number
  checks: VerificationCheck[]
  startedAt: number
  finishedAt?: number
}

export interface VerificationState {
  dagId: string
  maxRounds: number
  rounds: VerificationRound[]
  status: "running" | "passed" | "failed"
}
