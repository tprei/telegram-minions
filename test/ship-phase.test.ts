import { describe, it, expect } from "vitest"
import type { TopicSession, ShipPhase } from "../src/types.js"

function makeSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 100,
    repo: "test-repo",
    cwd: "/tmp/test",
    slug: "bold-arc",
    conversation: [{ role: "user", text: "ship it" }],
    pendingFeedback: [],
    mode: "plan",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

describe("ShipPhase type", () => {
  it("accepts valid ship phases", () => {
    const phases: ShipPhase[] = ["plan", "architect", "dag"]
    expect(phases).toHaveLength(3)
  })

  it("TopicSession supports shipPhase field", () => {
    const session = makeSession({ shipPhase: "plan" })
    expect(session.shipPhase).toBe("plan")
  })

  it("TopicSession shipPhase is optional and defaults to undefined", () => {
    const session = makeSession()
    expect(session.shipPhase).toBeUndefined()
  })

  it("shipPhase can transition through all phases", () => {
    const session = makeSession({ shipPhase: "plan" })
    expect(session.shipPhase).toBe("plan")

    session.shipPhase = "architect"
    expect(session.shipPhase).toBe("architect")

    session.shipPhase = "dag"
    expect(session.shipPhase).toBe("dag")
  })

  it("shipPhase persists through JSON round-trip", () => {
    const session = makeSession({ shipPhase: "architect" })
    const json = JSON.stringify(session)
    const restored: TopicSession = JSON.parse(json)
    expect(restored.shipPhase).toBe("architect")
  })

  it("shipPhase absence survives JSON round-trip", () => {
    const session = makeSession()
    const json = JSON.stringify(session)
    const restored: TopicSession = JSON.parse(json)
    expect(restored.shipPhase).toBeUndefined()
  })
})
