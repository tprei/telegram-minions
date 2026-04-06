import { describe, it, expect } from "vitest"
import { routeCommand } from "../src/commands/command-router.js"

describe("routeCommand", () => {
  describe("global commands (no thread)", () => {
    it("routes /status", () => {
      expect(routeCommand("/status", undefined, undefined, false)).toEqual({ type: "status" })
    })

    it("routes /stats", () => {
      expect(routeCommand("/stats", undefined, undefined, false)).toEqual({ type: "stats" })
    })

    it("routes /usage", () => {
      expect(routeCommand("/usage", undefined, undefined, false)).toEqual({ type: "usage" })
    })

    it("routes /clean", () => {
      expect(routeCommand("/clean", undefined, undefined, false)).toEqual({ type: "clean" })
    })

    it("routes /help", () => {
      expect(routeCommand("/help", undefined, undefined, false)).toEqual({ type: "help" })
    })

    it("routes /config with no args", () => {
      expect(routeCommand("/config", undefined, undefined, false)).toEqual({ type: "config", args: "" })
    })

    it("routes /config with args", () => {
      expect(routeCommand("/config add my-profile My Profile", undefined, undefined, false)).toEqual({
        type: "config",
        args: "add my-profile My Profile",
      })
    })

    it("routes /loops with no args", () => {
      expect(routeCommand("/loops", undefined, undefined, false)).toEqual({ type: "loops", args: "" })
    })

    it("routes /loops with subcommand args", () => {
      expect(routeCommand("/loops enable lint-sweep", undefined, undefined, false)).toEqual({
        type: "loops",
        args: "enable lint-sweep",
      })
    })

    it("routes /loops fire with id", () => {
      expect(routeCommand("/loops fire test-fixer", undefined, undefined, false)).toEqual({
        type: "loops",
        args: "fire test-fixer",
      })
    })

    it("routes /loops interval with id and hours", () => {
      expect(routeCommand("/loops interval lint-sweep 4", undefined, undefined, false)).toEqual({
        type: "loops",
        args: "interval lint-sweep 4",
      })
    })

    it("ignores /loops when in a thread", () => {
      expect(routeCommand("/loops", 123, undefined, false)).toBeNull()
    })

    it("ignores global commands when in a thread", () => {
      expect(routeCommand("/status", 123, undefined, false)).toBeNull()
    })
  })

  describe("session-creating commands", () => {
    it("routes /task with args", () => {
      expect(routeCommand("/task https://github.com/org/repo fix bug", undefined, undefined, false)).toEqual({
        type: "task",
        args: "https://github.com/org/repo fix bug",
        threadId: undefined,
        photos: undefined,
      })
    })

    it("routes /w shorthand", () => {
      expect(routeCommand("/w fix the tests", undefined, undefined, false)).toEqual({
        type: "task",
        args: "fix the tests",
        threadId: undefined,
        photos: undefined,
      })
    })

    it("routes bare /w", () => {
      expect(routeCommand("/w", undefined, undefined, false)).toEqual({
        type: "task",
        args: "",
        threadId: undefined,
        photos: undefined,
      })
    })

    it("routes /plan", () => {
      expect(routeCommand("/plan repo-alias implement feature A", 42, undefined, false)).toEqual({
        type: "plan",
        args: "repo-alias implement feature A",
        threadId: 42,
        photos: undefined,
      })
    })

    it("routes /think", () => {
      expect(routeCommand("/think about auth flow", undefined, undefined, false)).toEqual({
        type: "think",
        args: "about auth flow",
        threadId: undefined,
        photos: undefined,
      })
    })

    it("routes /review", () => {
      expect(routeCommand("/review repo-alias", 99, undefined, false)).toEqual({
        type: "review",
        args: "repo-alias",
        threadId: 99,
      })
    })

    it("routes /ship", () => {
      expect(routeCommand("/ship repo-alias add dark mode", undefined, undefined, false)).toEqual({
        type: "ship",
        args: "repo-alias add dark mode",
        threadId: undefined,
      })
    })

    it("session-creating commands work from any thread", () => {
      expect(routeCommand("/task fix it", 77, "plan", true)).toEqual({
        type: "task",
        args: "fix it",
        threadId: 77,
        photos: undefined,
      })
    })
  })

  describe("thread-scoped commands", () => {
    it("routes /close in a session thread", () => {
      expect(routeCommand("/close", 10, "task", true)).toEqual({ type: "close", threadId: 10 })
    })

    it("routes /stop in a session thread", () => {
      expect(routeCommand("/stop", 10, "task", true)).toEqual({ type: "stop", threadId: 10 })
    })

    it("routes /execute in plan mode", () => {
      expect(routeCommand("/execute", 10, "plan", true)).toEqual({ type: "execute", threadId: 10, directive: undefined })
    })

    it("routes /execute with directive in think mode", () => {
      expect(routeCommand("/execute only the auth part", 10, "think", true)).toEqual({
        type: "execute",
        threadId: 10,
        directive: "only the auth part",
      })
    })

    it("routes /execute in review mode", () => {
      expect(routeCommand("/execute", 10, "review", true)).toEqual({ type: "execute", threadId: 10, directive: undefined })
    })

    it("does not route /execute in task mode", () => {
      expect(routeCommand("/execute", 10, "task", true)).toBeNull()
    })

    it("routes /split in plan mode", () => {
      expect(routeCommand("/split", 10, "plan", true)).toEqual({ type: "split", threadId: 10, directive: undefined })
    })

    it("routes /split with directive in think mode", () => {
      expect(routeCommand("/split first two items", 10, "think", true)).toEqual({
        type: "split",
        threadId: 10,
        directive: "first two items",
      })
    })

    it("does not route /split in task mode", () => {
      expect(routeCommand("/split", 10, "task", true)).toBeNull()
    })

    it("routes /stack in plan mode", () => {
      expect(routeCommand("/stack", 10, "plan", true)).toEqual({ type: "stack", threadId: 10, directive: undefined })
    })

    it("routes /dag in think mode", () => {
      expect(routeCommand("/dag backend only", 10, "think", true)).toEqual({
        type: "dag",
        threadId: 10,
        directive: "backend only",
      })
    })

    it("routes /judge in plan mode", () => {
      expect(routeCommand("/judge", 10, "plan", true)).toEqual({ type: "judge", threadId: 10, directive: undefined })
    })

    it("routes /judge with directive in think mode", () => {
      expect(routeCommand("/judge focus on performance", 10, "think", true)).toEqual({
        type: "judge",
        threadId: 10,
        directive: "focus on performance",
      })
    })

    it("does not route /judge in task mode", () => {
      expect(routeCommand("/judge", 10, "task", true)).toBeNull()
    })

    describe("ship mode commands", () => {
      it("routes /execute in ship-plan mode", () => {
        expect(routeCommand("/execute", 10, "ship-plan", true)).toEqual({ type: "execute", threadId: 10, directive: undefined })
      })

      it("routes /execute with directive in ship-think mode", () => {
        expect(routeCommand("/execute only backend", 10, "ship-think", true)).toEqual({
          type: "execute",
          threadId: 10,
          directive: "only backend",
        })
      })

      it("routes /split in ship-plan mode", () => {
        expect(routeCommand("/split", 10, "ship-plan", true)).toEqual({ type: "split", threadId: 10, directive: undefined })
      })

      it("routes /split with directive in ship-think mode", () => {
        expect(routeCommand("/split first two items", 10, "ship-think", true)).toEqual({
          type: "split",
          threadId: 10,
          directive: "first two items",
        })
      })

      it("routes /stack in ship-plan mode", () => {
        expect(routeCommand("/stack", 10, "ship-plan", true)).toEqual({ type: "stack", threadId: 10, directive: undefined })
      })

      it("routes /stack in ship-think mode", () => {
        expect(routeCommand("/stack auth flow", 10, "ship-think", true)).toEqual({
          type: "stack",
          threadId: 10,
          directive: "auth flow",
        })
      })

      it("routes /dag in ship-plan mode", () => {
        expect(routeCommand("/dag backend only", 10, "ship-plan", true)).toEqual({
          type: "dag",
          threadId: 10,
          directive: "backend only",
        })
      })

      it("routes /dag in ship-think mode", () => {
        expect(routeCommand("/dag", 10, "ship-think", true)).toEqual({ type: "dag", threadId: 10, directive: undefined })
      })

      it("routes /judge in ship-plan mode", () => {
        expect(routeCommand("/judge", 10, "ship-plan", true)).toEqual({ type: "judge", threadId: 10, directive: undefined })
      })

      it("routes /judge with directive in ship-think mode", () => {
        expect(routeCommand("/judge focus on perf", 10, "ship-think", true)).toEqual({
          type: "judge",
          threadId: 10,
          directive: "focus on perf",
        })
      })
    })

    it("routes /doctor in any session mode", () => {
      expect(routeCommand("/doctor", 10, "task", true)).toEqual({ type: "doctor", threadId: 10, directive: undefined })
      expect(routeCommand("/doctor", 10, "plan", true)).toEqual({ type: "doctor", threadId: 10, directive: undefined })
      expect(routeCommand("/doctor", 10, "think", true)).toEqual({ type: "doctor", threadId: 10, directive: undefined })
      expect(routeCommand("/doctor", 10, "review", true)).toEqual({ type: "doctor", threadId: 10, directive: undefined })
      expect(routeCommand("/doctor", 10, "ship-plan", true)).toEqual({ type: "doctor", threadId: 10, directive: undefined })
      expect(routeCommand("/doctor", 10, "ship-think", true)).toEqual({ type: "doctor", threadId: 10, directive: undefined })
    })

    it("routes /doctor with directive", () => {
      expect(routeCommand("/doctor child stuck on node-2", 10, "plan", true)).toEqual({
        type: "doctor",
        threadId: 10,
        directive: "child stuck on node-2",
      })
    })

    it("does not route /doctor without a session", () => {
      expect(routeCommand("/doctor", 10, undefined, false)).toBeNull()
    })

    it("does not route /doctor in main chat", () => {
      expect(routeCommand("/doctor", undefined, undefined, false)).toBeNull()
    })

    it("routes /land", () => {
      expect(routeCommand("/land", 10, "plan", true)).toEqual({ type: "land", threadId: 10 })
    })

    it("routes /done", () => {
      expect(routeCommand("/done", 10, "task", true)).toEqual({ type: "done", threadId: 10 })
    })

    it("routes /done in plan mode", () => {
      expect(routeCommand("/done", 10, "plan", true)).toEqual({ type: "done", threadId: 10 })
    })

    it("routes /retry with no nodeId", () => {
      expect(routeCommand("/retry", 10, "plan", true)).toEqual({ type: "retry", threadId: 10, nodeId: undefined })
    })

    it("routes /retry with nodeId", () => {
      expect(routeCommand("/retry node-3", 10, "plan", true)).toEqual({ type: "retry", threadId: 10, nodeId: "node-3" })
    })

    it("routes /force with nodeId", () => {
      expect(routeCommand("/force node-2", 10, "plan", true)).toEqual({ type: "force", threadId: 10, nodeId: "node-2" })
    })

    it("routes /reply", () => {
      expect(routeCommand("/reply please also add tests", 10, "plan", true)).toEqual({
        type: "reply",
        threadId: 10,
        text: "please also add tests",
        photos: undefined,
      })
    })

    it("routes /r shorthand", () => {
      expect(routeCommand("/r look at the screenshot", 10, "task", true)).toEqual({
        type: "reply",
        threadId: 10,
        text: "look at the screenshot",
        photos: undefined,
      })
    })

    it("does not route thread commands without a session", () => {
      expect(routeCommand("/close", 10, undefined, false)).toBeNull()
      expect(routeCommand("/stop", 10, undefined, false)).toBeNull()
      expect(routeCommand("/land", 10, undefined, false)).toBeNull()
      expect(routeCommand("/done", 10, undefined, false)).toBeNull()
    })
  })

  describe("edge cases", () => {
    it("returns null for undefined text without photos", () => {
      expect(routeCommand(undefined, undefined, undefined, false)).toBeNull()
    })

    it("returns null for unrecognized text", () => {
      expect(routeCommand("hello world", undefined, undefined, false)).toBeNull()
    })

    it("returns null for unrecognized text in a thread with session", () => {
      expect(routeCommand("hello world", 10, "task", true)).toBeNull()
    })
  })
})
