import { describe, it, expect } from "vitest"
import { TranscriptBuilder } from "./transcript-builder.js"
import type { GooseStreamEvent } from "../domain/goose-types.js"
import type {
  AssistantTextEvent,
  StatusEvent,
  ToolCallEvent,
  ToolResultEvent,
  TranscriptEvent,
  TranscriptEventType,
  TurnCompletedEvent,
  TurnStartedEvent,
  UserMessageEvent,
} from "./types.js"

/**
 * Integration-style tests: each scenario is defined as an NDJSON fixture —
 * the exact on-the-wire shape the translator sees from the stream parser —
 * and fed through `TranscriptBuilder.handleEvent` line by line. Assertions
 * run against the flat list of emitted transcript events so coverage is
 * anchored to the public contract rather than implementation details.
 */

interface FixtureRun {
  events: TranscriptEvent[]
  builder: TranscriptBuilder
}

function makeBuilder(sessionId = "fixture-session"): TranscriptBuilder {
  let t = 1_700_000_000_000
  let n = 0
  return new TranscriptBuilder({
    sessionId,
    now: () => ++t,
    idGen: () => `id_${n++}`,
  })
}

function parseNdjson(ndjson: string): GooseStreamEvent[] {
  return ndjson
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => JSON.parse(line) as GooseStreamEvent)
}

function runFixture(ndjson: string, sessionId?: string): FixtureRun {
  const builder = makeBuilder(sessionId)
  const events: TranscriptEvent[] = []
  for (const streamEvent of parseNdjson(ndjson)) {
    events.push(...builder.handleEvent(streamEvent))
  }
  return { events, builder }
}

function typesOf(events: TranscriptEvent[]): TranscriptEventType[] {
  return events.map((e) => e.type)
}

function ofType<T extends TranscriptEventType>(
  events: TranscriptEvent[],
  type: T,
): Extract<TranscriptEvent, { type: T }>[] {
  return events.filter((e): e is Extract<TranscriptEvent, { type: T }> => e.type === type)
}

describe("TranscriptBuilder fixture — text-only turn", () => {
  const fixture = `
    # assistant streams three text chunks then signals complete
    {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"text","text":"Hello "}]}}
    {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"text","text":"there, "}]}}
    {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"text","text":"friend."}]}}
    {"type":"complete","total_tokens":12,"total_cost_usd":0.0001,"num_turns":1}
  `

  it("emits an auto-started turn, streamed deltas, a final block, and turn_completed", () => {
    const { events } = runFixture(fixture)
    expect(typesOf(events)).toEqual([
      "turn_started",
      "assistant_text",
      "assistant_text",
      "assistant_text",
      "assistant_text",
      "turn_completed",
    ])

    const [, d1, d2, d3, final] = events as [
      TurnStartedEvent,
      AssistantTextEvent,
      AssistantTextEvent,
      AssistantTextEvent,
      AssistantTextEvent,
      TurnCompletedEvent,
    ]
    expect(d1.final).toBe(false)
    expect(d2.final).toBe(false)
    expect(d3.final).toBe(false)
    expect(final.final).toBe(true)
    expect(final.text).toBe("Hello there, friend.")
    // Deltas and the final all belong to the same streaming block.
    expect(new Set([d1.blockId, d2.blockId, d3.blockId, final.blockId]).size).toBe(1)

    const done = events[events.length - 1] as TurnCompletedEvent
    expect(done.totalTokens).toBe(12)
    expect(done.totalCostUsd).toBe(0.0001)
    expect(done.errored).toBeUndefined()
  })

  it("auto-starts the turn with the agent_continuation trigger", () => {
    const { events } = runFixture(fixture)
    const started = events[0] as TurnStartedEvent
    expect(started.type).toBe("turn_started")
    expect(started.trigger).toBe("agent_continuation")
    expect(started.turn).toBe(0)
  })
})

describe("TranscriptBuilder fixture — single tool call", () => {
  const fixture = `
    {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"text","text":"Let me check the tests."}]}}
    {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"toolRequest","id":"t_1","toolCall":{"name":"Bash","arguments":{"command":"npm test"}}}]}}
    {"type":"message","message":{"role":"user","created":0,"content":[{"type":"toolResponse","id":"t_1","toolResult":[{"type":"text","text":"All tests passed."}]}]}}
    {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"text","text":"Done."}]}}
    {"type":"complete","total_tokens":34,"total_cost_usd":0.0004,"num_turns":1}
  `

  it("flushes the intro text, then emits tool_call → tool_result, then closing text", () => {
    const { events } = runFixture(fixture)
    // Intro text: one streaming delta + one flushed final before the tool call.
    // Closing text: one streaming delta + one flushed final on turn_completed.
    expect(typesOf(events)).toEqual([
      "turn_started",
      "assistant_text",
      "assistant_text",
      "tool_call",
      "tool_result",
      "assistant_text",
      "assistant_text",
      "turn_completed",
    ])

    const introDelta = events[1] as AssistantTextEvent
    const introFinal = events[2] as AssistantTextEvent
    expect(introDelta.final).toBe(false)
    expect(introFinal.final).toBe(true)
    expect(introFinal.text).toBe("Let me check the tests.")
    expect(introFinal.blockId).toBe(introDelta.blockId)

    const call = events[3] as ToolCallEvent
    expect(call.call.toolUseId).toBe("t_1")
    expect(call.call.kind).toBe("bash")
    expect(call.call.title).toBe("Run command")
    expect(call.call.subtitle).toBe("npm test")

    const result = events[4] as ToolResultEvent
    expect(result.toolUseId).toBe("t_1")
    expect(result.result.status).toBe("ok")
    expect(result.result.text).toBe("All tests passed.")

    const closingDelta = events[5] as AssistantTextEvent
    const closingFinal = events[6] as AssistantTextEvent
    expect(closingDelta.final).toBe(false)
    expect(closingFinal.final).toBe(true)
    expect(closingFinal.text).toBe("Done.")
    expect(closingFinal.blockId).not.toBe(introFinal.blockId)
  })

  it("includes user messages mirrored via userMessage before the stream", () => {
    const builder = makeBuilder("solo-tool")
    const userEvents = builder.userMessage("run the suite")
    const streamEvents: TranscriptEvent[] = []
    for (const ev of parseNdjson(fixture)) {
      streamEvents.push(...builder.handleEvent(ev))
    }
    const all = [...userEvents, ...streamEvents]
    expect(typesOf(all.slice(0, 2))).toEqual(["turn_started", "user_message"])
    const user = all[1] as UserMessageEvent
    expect(user.text).toBe("run the suite")

    // The stream should not open a second turn — the user message already did.
    const newTurns = ofType(streamEvents, "turn_started")
    expect(newTurns).toHaveLength(0)
  })
})

describe("TranscriptBuilder fixture — parallel tool calls", () => {
  // NDJSON = strictly one JSON object per line — the two parallel tool
  // requests share a single assistant message encoded on one line.
  const fixture = [
    `{"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"text","text":"Running both in parallel."}]}}`,
    `{"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"toolRequest","id":"t_a","toolCall":{"name":"Bash","arguments":{"command":"rg foo"}}},{"type":"toolRequest","id":"t_b","toolCall":{"name":"Read","arguments":{"file_path":"/src/app.ts"}}}]}}`,
    `{"type":"message","message":{"role":"user","created":0,"content":[{"type":"toolResponse","id":"t_b","toolResult":"export const app = 1\\n"}]}}`,
    `{"type":"message","message":{"role":"user","created":0,"content":[{"type":"toolResponse","id":"t_a","toolResult":[{"type":"text","text":"no matches"}]}]}}`,
    `{"type":"complete","total_tokens":88,"total_cost_usd":0.002,"num_turns":1}`,
  ].join("\n")

  it("emits two tool_calls, pairs each tool_result with its own toolUseId", () => {
    const { events } = runFixture(fixture)
    expect(typesOf(events)).toEqual([
      "turn_started",
      "assistant_text",
      "assistant_text",
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
      "turn_completed",
    ])

    const calls = ofType(events, "tool_call")
    expect(calls.map((c) => c.call.toolUseId)).toEqual(["t_a", "t_b"])
    expect(calls[0].call.kind).toBe("bash")
    expect(calls[1].call.kind).toBe("read")

    const results = ofType(events, "tool_result")
    expect(results.map((r) => r.toolUseId)).toEqual(["t_b", "t_a"])

    // Result for the Bash call should carry ok status; result for Read should
    // carry the file contents without truncation (well under the 32 KB budget).
    const bashResult = results.find((r) => r.toolUseId === "t_a")!
    const readResult = results.find((r) => r.toolUseId === "t_b")!
    expect(bashResult.result.status).toBe("ok")
    expect(bashResult.result.text).toBe("no matches")
    expect(readResult.result.text).toBe("export const app = 1\n")
    expect(readResult.result.truncated).toBeUndefined()
  })

  it("applies the correct per-kind budget even when the result arrives before its sibling", () => {
    const bigBash = "y".repeat(70 * 1024)
    const smallRead = "hello"
    const fx = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          created: 0,
          content: [
            { type: "toolRequest", id: "t_a", toolCall: { name: "Bash", arguments: { command: "cat /big" } } },
            { type: "toolRequest", id: "t_b", toolCall: { name: "Read", arguments: { file_path: "/tiny" } } },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", created: 0, content: [{ type: "toolResponse", id: "t_b", toolResult: smallRead }] },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", created: 0, content: [{ type: "toolResponse", id: "t_a", toolResult: bigBash }] },
      }),
    ].join("\n")

    const { events } = runFixture(fx)
    const results = ofType(events, "tool_result")
    const bashResult = results.find((r) => r.toolUseId === "t_a")!
    const readResult = results.find((r) => r.toolUseId === "t_b")!

    expect(bashResult.result.truncated).toBe(true)
    expect(bashResult.result.originalBytes).toBe(70 * 1024)
    expect(readResult.result.truncated).toBeUndefined()
    expect(readResult.result.text).toBe(smallRead)
  })
})

describe("TranscriptBuilder fixture — subagent (Task) nesting", () => {
  // The parent agent delegates a subtask via the Task tool. Goose emits an
  // in-band tool_call for the delegation; the subagent's own tool activity
  // arrives afterwards in the parent stream (mimicking how claude-agent-acp
  // surfaces nested work).
  const fixture = `
    {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"text","text":"Delegating to the explorer."}]}}
    {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"toolRequest","id":"task_1","toolCall":{"name":"Task","arguments":{"description":"Find callers","subagent_type":"explorer","prompt":"Find all callers of renderBanner"}}}]}}
    {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"toolRequest","id":"sub_1","toolCall":{"name":"Grep","arguments":{"pattern":"renderBanner","path":"src/"}}}]}}
    {"type":"message","message":{"role":"user","created":0,"content":[{"type":"toolResponse","id":"sub_1","toolResult":[{"type":"text","text":"src/banner.ts:12\\nsrc/banner.ts:48"}]}]}}
    {"type":"message","message":{"role":"user","created":0,"content":[{"type":"toolResponse","id":"task_1","toolResult":[{"type":"text","text":"Found two callers in src/banner.ts"}]}]}}
    {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"text","text":"Explorer reported two callers."}]}}
    {"type":"complete","total_tokens":256,"total_cost_usd":0.01,"num_turns":1}
  `

  it("classifies the delegation as kind=task and surfaces nested tool activity", () => {
    const { events } = runFixture(fixture)
    const calls = ofType(events, "tool_call")
    expect(calls.map((c) => c.call.toolUseId)).toEqual(["task_1", "sub_1"])
    expect(calls[0].call.kind).toBe("task")
    expect(calls[0].call.title).toBe("Delegate to agent")
    expect(calls[0].call.subtitle).toBe("Find callers")
    expect(calls[1].call.kind).toBe("search")
    expect(calls[1].call.subtitle).toBe("renderBanner")
  })

  it("keeps all nested events in a single turn, closes with turn_completed", () => {
    const { events } = runFixture(fixture)
    expect(ofType(events, "turn_started")).toHaveLength(1)
    expect(ofType(events, "turn_completed")).toHaveLength(1)
    for (const ev of events) expect(ev.turn).toBe(0)
  })

  it("pairs each nested tool_call with its own result (no leakage to the parent)", () => {
    const { events } = runFixture(fixture)
    const results = ofType(events, "tool_result")
    const byId = new Map(results.map((r) => [r.toolUseId, r]))

    const sub = byId.get("sub_1")!
    const parent = byId.get("task_1")!
    expect(sub.result.text).toContain("src/banner.ts:12")
    expect(parent.result.text).toBe("Found two callers in src/banner.ts")
    expect(sub.result.status).toBe("ok")
    expect(parent.result.status).toBe("ok")
  })
})

describe("TranscriptBuilder fixture — mid-turn errors", () => {
  const fixture = `
    {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"text","text":"Starting the risky operation…"}]}}
    {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"toolRequest","id":"t_x","toolCall":{"name":"Bash","arguments":{"command":"flaky.sh"}}}]}}
    {"type":"error","error":"upstream provider disconnected"}
  `

  it("flushes buffered text, closes the turn with errored:true, and does not require a complete event", () => {
    const { events, builder } = runFixture(fixture)
    // Intro text streams as a delta, gets flushed as final when the tool call
    // arrives, then the error closes the turn.
    expect(typesOf(events)).toEqual([
      "turn_started",
      "assistant_text",
      "assistant_text",
      "tool_call",
      "turn_completed",
    ])

    const introFinal = events[2] as AssistantTextEvent
    expect(introFinal.final).toBe(true)
    expect(introFinal.text).toBe("Starting the risky operation…")

    const done = events[events.length - 1] as TurnCompletedEvent
    expect(done.errored).toBe(true)
    expect(done.totalTokens).toBeUndefined()
    expect(builder.isTurnActive).toBe(false)
  })

  it("emits a status banner when the tool_call payload carries an error marker", () => {
    const fx = `
      {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"text","text":"Trying unknown tool"}]}}
      {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"toolRequest","id":"bad","toolCall":{"error":"tool not found: xyz"}}]}}
      {"type":"complete","total_tokens":1,"total_cost_usd":0,"num_turns":1}
    `
    const { events } = runFixture(fx)
    const statuses = ofType(events, "status")
    expect(statuses).toHaveLength(1)
    const status = statuses[0] as StatusEvent
    expect(status.kind).toBe("tool_call_error")
    expect(status.severity).toBe("error")
    expect(status.message).toBe("tool not found: xyz")
    expect(status.data).toEqual({ toolUseId: "bad" })

    // The turn should still close cleanly on complete.
    const done = events[events.length - 1] as TurnCompletedEvent
    expect(done.type).toBe("turn_completed")
    expect(done.errored).toBeUndefined()
  })

  it("treats an error-status tool_result as an error result payload", () => {
    // Anthropic-style error envelope: is_error on the outer wrapper, text
    // payload inside content blocks.
    const fx = [
      `{"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"toolRequest","id":"t_e","toolCall":{"name":"Bash","arguments":{"command":"exit 1"}}}]}}`,
      `{"type":"message","message":{"role":"user","created":0,"content":[{"type":"toolResponse","id":"t_e","toolResult":{"is_error":true,"content":[{"type":"text","text":"command failed"}]}}]}}`,
      `{"type":"complete","total_tokens":3,"total_cost_usd":0,"num_turns":1}`,
    ].join("\n")
    const { events } = runFixture(fx)
    const result = ofType(events, "tool_result")[0] as ToolResultEvent
    expect(result.result.status).toBe("error")
    expect(result.result.error).toBe("command failed")
  })
})

describe("TranscriptBuilder fixture — invariants across fixtures", () => {
  const allFixtures = [
    // text-only
    `
      {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"text","text":"hi"}]}}
      {"type":"complete","total_tokens":1,"total_cost_usd":0,"num_turns":1}
    `,
    // single tool
    `
      {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"toolRequest","id":"t","toolCall":{"name":"Read","arguments":{"file_path":"/a"}}}]}}
      {"type":"message","message":{"role":"user","created":0,"content":[{"type":"toolResponse","id":"t","toolResult":"ok"}]}}
      {"type":"complete","total_tokens":1,"total_cost_usd":0,"num_turns":1}
    `,
    // mid-turn error
    `
      {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"text","text":"partial"}]}}
      {"type":"error","error":"boom"}
    `,
  ]

  it.each(allFixtures.map((fx, i) => ({ fx, i })))(
    "produces strictly monotonic seq numbers (fixture $i)",
    ({ fx }) => {
      const { events } = runFixture(fx)
      for (let i = 1; i < events.length; i++) {
        expect(events[i].seq).toBe(events[i - 1].seq + 1)
      }
    },
  )

  it("stamps every event with the session id across a multi-scenario stream", () => {
    const fx = `
      {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"text","text":"hello"}]}}
      {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"toolRequest","id":"a","toolCall":{"name":"Bash","arguments":{"command":"ls"}}}]}}
      {"type":"message","message":{"role":"user","created":0,"content":[{"type":"toolResponse","id":"a","toolResult":"ok"}]}}
      {"type":"complete","total_tokens":2,"total_cost_usd":0,"num_turns":1}
    `
    const { events } = runFixture(fx, "warm-stone")
    expect(events.length).toBeGreaterThan(0)
    for (const ev of events) expect(ev.sessionId).toBe("warm-stone")
  })

  it("ignores idle and notification stream events inside fixtures", () => {
    const fx = `
      {"type":"notification","extensionId":"ext","message":"progress"}
      {"type":"idle"}
      {"type":"message","message":{"role":"assistant","created":0,"content":[{"type":"text","text":"text"}]}}
      {"type":"complete","total_tokens":1,"total_cost_usd":0,"num_turns":1}
    `
    const { events } = runFixture(fx)
    expect(typesOf(events)).toEqual([
      "turn_started",
      "assistant_text",
      "assistant_text",
      "turn_completed",
    ])
  })
})
