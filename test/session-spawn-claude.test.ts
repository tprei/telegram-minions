import { describe, it, expect } from "vitest"
import { SessionHandle, type SessionConfig } from "../src/session/session.js"
import type { SessionMeta } from "../src/domain/session-types.js"
const baseConfig: SessionConfig = {
  goose: { provider: "test", model: "test" },
  claude: { planModel: "plan-model", thinkModel: "think-model", reviewModel: "review-model" },
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
}

function makeMeta(mode: string): SessionMeta {
  return {
    sessionId: "test-spawn",
    threadId: 1,
    topicName: "test-spawn",
    repo: "test",
    cwd: "/tmp",
    startedAt: Date.now(),
    mode,
  }
}

describe("SessionHandle.claudeModeConfigs", () => {
  const configs = (SessionHandle as unknown as { claudeModeConfigs: Record<string, (cfg: SessionConfig) => Record<string, unknown>> }).claudeModeConfigs

  it("has entries for all claude modes", () => {
    expect(Object.keys(configs).sort()).toEqual([
      "dag-review", "plan", "review", "ship-plan", "ship-think", "ship-verify", "think",
    ])
  })

  it("plan mode uses planModel and disallowed tools", () => {
    const result = configs["plan"](baseConfig)
    expect(result.model).toBe("plan-model")
    expect(result.disallowedTools).toEqual(["Edit", "Write", "NotebookEdit"])
    expect(result.detached).toBe(true)
  })

  it("think mode uses thinkModel and disallowed tools", () => {
    const result = configs["think"](baseConfig)
    expect(result.model).toBe("think-model")
    expect(result.disallowedTools).toEqual(["Edit", "Write", "NotebookEdit"])
    expect(result.detached).toBe(true)
  })

  it("ship-think mode matches think mode config", () => {
    const think = configs["think"](baseConfig)
    const shipThink = configs["ship-think"](baseConfig)
    expect(shipThink.model).toBe(think.model)
    expect(shipThink.disallowedTools).toEqual(think.disallowedTools)
    expect(shipThink.detached).toBe(think.detached)
  })

  it("review mode uses reviewModel and no detached flag", () => {
    const result = configs["review"](baseConfig)
    expect(result.model).toBe("review-model")
    expect(result.disallowedTools).toEqual(["Edit", "Write", "NotebookEdit"])
    expect(result.detached).toBeUndefined()
  })

  it("ship-plan mode uses planModel and disallowed tools", () => {
    const result = configs["ship-plan"](baseConfig)
    expect(result.model).toBe("plan-model")
    expect(result.disallowedTools).toEqual(["Edit", "Write", "NotebookEdit"])
    expect(result.detached).toBe(true)
  })

  it("ship-verify mode uses reviewModel with no disallowed tools", () => {
    const result = configs["ship-verify"](baseConfig)
    expect(result.model).toBe("review-model")
    expect(result.disallowedTools).toBeUndefined()
    expect(result.detached).toBe(true)
  })

  it("all modes have a systemPrompt string", () => {
    for (const [mode, factory] of Object.entries(configs)) {
      const result = factory(baseConfig)
      expect(result.systemPrompt, `${mode} should have systemPrompt`).toBeDefined()
      expect(typeof result.systemPrompt).toBe("string")
      expect((result.systemPrompt as string).length).toBeGreaterThan(0)
    }
  })
})
