import { describe, it, expect } from "vitest"
import type {
  AutoAdvance,
  ShipPhase,
  TopicSession,
  VerificationCheck,
  VerificationRound,
  VerificationState,
  VerificationCheckKind,
  VerificationCheckStatus,
  SessionMode,
} from "../src/types.js"
import type { PendingTask } from "../src/session-manager.js"

describe("ship session modes", () => {
  it("accepts ship-think as a valid SessionMode", () => {
    const mode: SessionMode = "ship-think"
    expect(mode).toBe("ship-think")
  })

  it("accepts ship-plan as a valid SessionMode", () => {
    const mode: SessionMode = "ship-plan"
    expect(mode).toBe("ship-plan")
  })

  it("accepts ship-verify as a valid SessionMode", () => {
    const mode: SessionMode = "ship-verify"
    expect(mode).toBe("ship-verify")
  })
})

describe("AutoAdvance", () => {
  it("holds ship pipeline state", () => {
    const aa: AutoAdvance = {
      phase: "think",
      featureDescription: "add user authentication",
      autoLand: false,
    }
    expect(aa.phase).toBe("think")
    expect(aa.featureDescription).toBe("add user authentication")
    expect(aa.autoLand).toBe(false)
  })

  it("supports all ShipPhase values", () => {
    const phases: ShipPhase[] = ["think", "plan", "dag", "verify", "done"]
    for (const phase of phases) {
      const aa: AutoAdvance = { phase, featureDescription: "test", autoLand: false }
      expect(aa.phase).toBe(phase)
    }
  })
})

describe("TopicSession.autoAdvance", () => {
  it("is optional and defaults to undefined", () => {
    const session: TopicSession = {
      threadId: 1,
      repo: "test-repo",
      cwd: "/tmp/test",
      slug: "bold-lion",
      conversation: [],
      pendingFeedback: [],
      mode: "ship-think",
      lastActivityAt: Date.now(),
    }
    expect(session.autoAdvance).toBeUndefined()
  })

  it("can be set with autoAdvance state", () => {
    const session: TopicSession = {
      threadId: 1,
      repo: "test-repo",
      cwd: "/tmp/test",
      slug: "bold-lion",
      conversation: [],
      pendingFeedback: [],
      mode: "ship-think",
      lastActivityAt: Date.now(),
      autoAdvance: {
        phase: "dag",
        featureDescription: "implement SSO login",
        autoLand: true,
      },
    }
    expect(session.autoAdvance).toBeDefined()
    expect(session.autoAdvance!.phase).toBe("dag")
    expect(session.autoAdvance!.autoLand).toBe(true)
  })
})

describe("PendingTask.autoAdvance", () => {
  it("carries autoAdvance through profile/repo selection", () => {
    const autoAdvance: AutoAdvance = {
      phase: "think",
      featureDescription: "add SSO login",
      autoLand: false,
    }
    const pending: PendingTask = {
      task: "add SSO login",
      mode: "ship-think",
      repoUrl: "https://github.com/org/repo",
      autoAdvance,
    }
    expect(pending.autoAdvance).toBeDefined()
    expect(pending.autoAdvance!.phase).toBe("think")
    expect(pending.autoAdvance!.featureDescription).toBe("add SSO login")
  })

  it("is optional and defaults to undefined for non-ship modes", () => {
    const pending: PendingTask = {
      task: "fix bug",
      mode: "task",
    }
    expect(pending.autoAdvance).toBeUndefined()
  })
})

describe("VerificationCheck", () => {
  it("represents a single check against a DAG node", () => {
    const check: VerificationCheck = {
      kind: "quality-gates",
      status: "passed",
      nodeId: "auth-module",
      output: "All gates passed",
      startedAt: 1000,
      finishedAt: 2000,
    }
    expect(check.kind).toBe("quality-gates")
    expect(check.status).toBe("passed")
    expect(check.nodeId).toBe("auth-module")
  })

  it("supports all check kinds", () => {
    const kinds: VerificationCheckKind[] = ["quality-gates", "ci", "completeness-review"]
    for (const kind of kinds) {
      const check: VerificationCheck = { kind, status: "pending", nodeId: "n1" }
      expect(check.kind).toBe(kind)
    }
  })

  it("supports all check statuses", () => {
    const statuses: VerificationCheckStatus[] = ["pending", "running", "passed", "failed", "skipped"]
    for (const status of statuses) {
      const check: VerificationCheck = { kind: "ci", status, nodeId: "n1" }
      expect(check.status).toBe(status)
    }
  })
})

describe("VerificationRound", () => {
  it("groups checks into a numbered round", () => {
    const round: VerificationRound = {
      round: 1,
      checks: [
        { kind: "quality-gates", status: "passed", nodeId: "a" },
        { kind: "ci", status: "failed", nodeId: "a", output: "lint error" },
      ],
      startedAt: 1000,
      finishedAt: 2000,
    }
    expect(round.checks).toHaveLength(2)
    expect(round.round).toBe(1)
  })
})

describe("VerificationState", () => {
  it("tracks multi-round verification of a DAG", () => {
    const state: VerificationState = {
      dagId: "dag-123",
      maxRounds: 3,
      rounds: [
        {
          round: 1,
          checks: [
            { kind: "quality-gates", status: "passed", nodeId: "a" },
            { kind: "ci", status: "passed", nodeId: "a" },
            { kind: "completeness-review", status: "passed", nodeId: "a" },
          ],
          startedAt: 1000,
          finishedAt: 2000,
        },
      ],
      status: "passed",
    }
    expect(state.dagId).toBe("dag-123")
    expect(state.maxRounds).toBe(3)
    expect(state.rounds).toHaveLength(1)
    expect(state.status).toBe("passed")
  })

  it("tracks a failed verification that exhausted max rounds", () => {
    const state: VerificationState = {
      dagId: "dag-456",
      maxRounds: 2,
      rounds: [
        {
          round: 1,
          checks: [{ kind: "ci", status: "failed", nodeId: "b", output: "test failure" }],
          startedAt: 1000,
          finishedAt: 2000,
        },
        {
          round: 2,
          checks: [{ kind: "ci", status: "failed", nodeId: "b", output: "still failing" }],
          startedAt: 3000,
          finishedAt: 4000,
        },
      ],
      status: "failed",
    }
    expect(state.rounds).toHaveLength(2)
    expect(state.status).toBe("failed")
  })
})
