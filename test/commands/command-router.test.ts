import { describe, it, expect } from "vitest"
import { routeCommand } from "../../src/commands/command-router.js"

describe("routeCommand", () => {
  describe("null cases", () => {
    it("returns null for undefined text and no photos", () => {
      expect(routeCommand(undefined, undefined, undefined, false)).toBeNull()
    })

    it("returns null for unrecognized text", () => {
      expect(routeCommand("hello world", undefined, undefined, false)).toBeNull()
    })
  })

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
      expect(routeCommand("/config set foo=bar", undefined, undefined, false)).toEqual({ type: "config", args: "set foo=bar" })
    })

    it("routes /loops with no args", () => {
      expect(routeCommand("/loops", undefined, undefined, false)).toEqual({ type: "loops", args: "" })
    })

    it("routes /loops with args", () => {
      expect(routeCommand("/loops start myloop", undefined, undefined, false)).toEqual({ type: "loops", args: "start myloop" })
    })

    it("does not route /status inside a thread", () => {
      expect(routeCommand("/status", 42, undefined, false)).toBeNull()
    })
  })

  describe("session-creating commands", () => {
    it("routes /task with args", () => {
      expect(routeCommand("/task Fix the bug", undefined, undefined, false)).toEqual({
        type: "task", args: "Fix the bug", threadId: undefined, photos: undefined,
      })
    })

    it("routes /w shorthand", () => {
      expect(routeCommand("/w Fix the bug", undefined, undefined, false)).toEqual({
        type: "task", args: "Fix the bug", threadId: undefined, photos: undefined,
      })
    })

    it("routes /plan with args", () => {
      expect(routeCommand("/plan Design auth flow", 10, undefined, false)).toEqual({
        type: "plan", args: "Design auth flow", threadId: 10, photos: undefined,
      })
    })

    it("routes /think with args", () => {
      expect(routeCommand("/think Why is X slow?", 10, undefined, false)).toEqual({
        type: "think", args: "Why is X slow?", threadId: 10, photos: undefined,
      })
    })

    it("routes /review with args", () => {
      expect(routeCommand("/review app 42", undefined, undefined, false)).toEqual({
        type: "review", args: "app 42", threadId: undefined,
      })
    })

    it("routes /ship with args", () => {
      expect(routeCommand("/ship feature branch", 5, undefined, false)).toEqual({
        type: "ship", args: "feature branch", threadId: 5,
      })
    })

    it("passes photos through for /task", () => {
      const photos = [{ file_id: "abc", file_unique_id: "u1", width: 100, height: 100 }]
      const result = routeCommand("/task Fix it", 1, undefined, false, photos)
      expect(result).toEqual({
        type: "task", args: "Fix it", threadId: 1, photos,
      })
    })
  })

  describe("thread-scoped commands", () => {
    it("routes /close in active session", () => {
      expect(routeCommand("/close", 42, "task", true)).toEqual({ type: "close", threadId: 42 })
    })

    it("routes /stop in active session", () => {
      expect(routeCommand("/stop", 42, "task", true)).toEqual({ type: "stop", threadId: 42 })
    })

    it("routes /land in active session", () => {
      expect(routeCommand("/land", 42, "plan", true)).toEqual({ type: "land", threadId: 42 })
    })

    it("routes /done in active session", () => {
      expect(routeCommand("/done", 42, "task", true)).toEqual({ type: "done", threadId: 42 })
    })

    it("does not route /close without a session", () => {
      expect(routeCommand("/close", 42, undefined, false)).toBeNull()
    })

    it("does not route /close without a thread", () => {
      expect(routeCommand("/close", undefined, undefined, false)).toBeNull()
    })

    it("routes /doctor bare", () => {
      expect(routeCommand("/doctor", 42, "task", true)).toEqual({
        type: "doctor", threadId: 42, directive: undefined,
      })
    })

    it("routes /doctor with directive", () => {
      expect(routeCommand("/doctor check deps", 42, "task", true)).toEqual({
        type: "doctor", threadId: 42, directive: "check deps",
      })
    })

    it("routes /retry bare", () => {
      expect(routeCommand("/retry", 42, "task", true)).toEqual({
        type: "retry", threadId: 42, nodeId: undefined,
      })
    })

    it("routes /retry with nodeId", () => {
      expect(routeCommand("/retry node-1", 42, "task", true)).toEqual({
        type: "retry", threadId: 42, nodeId: "node-1",
      })
    })

    it("routes /force bare", () => {
      expect(routeCommand("/force", 42, "task", true)).toEqual({
        type: "force", threadId: 42, nodeId: undefined,
      })
    })

    it("routes /force with nodeId", () => {
      expect(routeCommand("/force node-2", 42, "task", true)).toEqual({
        type: "force", threadId: 42, nodeId: "node-2",
      })
    })
  })

  describe("plan-mode commands", () => {
    it("routes /execute in plan mode", () => {
      expect(routeCommand("/execute", 42, "plan", true)).toEqual({
        type: "execute", threadId: 42, directive: undefined,
      })
    })

    it("routes /execute with directive in think mode", () => {
      expect(routeCommand("/execute focus on auth", 42, "think", true)).toEqual({
        type: "execute", threadId: 42, directive: "focus on auth",
      })
    })

    it("routes /execute in review mode", () => {
      expect(routeCommand("/execute", 42, "review", true)).toEqual({
        type: "execute", threadId: 42, directive: undefined,
      })
    })

    it("does not route /execute in task mode", () => {
      expect(routeCommand("/execute", 42, "task", true)).toBeNull()
    })

    it("routes /split in plan mode", () => {
      expect(routeCommand("/split", 42, "plan", true)).toEqual({
        type: "split", threadId: 42, directive: undefined,
      })
    })

    it("routes /stack in think mode", () => {
      expect(routeCommand("/stack", 42, "think", true)).toEqual({
        type: "stack", threadId: 42, directive: undefined,
      })
    })

    it("routes /dag in plan mode", () => {
      expect(routeCommand("/dag", 42, "plan", true)).toEqual({
        type: "dag", threadId: 42, directive: undefined,
      })
    })

    it("routes /judge in plan mode", () => {
      expect(routeCommand("/judge", 42, "plan", true)).toEqual({
        type: "judge", threadId: 42, directive: undefined,
      })
    })

    it("does not route /split in task mode", () => {
      expect(routeCommand("/split", 42, "task", true)).toBeNull()
    })

    it("routes /execute in ship-plan mode", () => {
      expect(routeCommand("/execute", 42, "ship-plan", true)).toEqual({
        type: "execute", threadId: 42, directive: undefined,
      })
    })

    it("routes /split in ship-think mode", () => {
      expect(routeCommand("/split", 42, "ship-think", true)).toEqual({
        type: "split", threadId: 42, directive: undefined,
      })
    })
  })

  describe("reply commands", () => {
    it("routes /reply with text", () => {
      expect(routeCommand("/reply Hello agent", 42, "task", true)).toEqual({
        type: "reply", threadId: 42, text: "Hello agent", photos: undefined,
      })
    })

    it("routes /r shorthand", () => {
      expect(routeCommand("/r Hello agent", 42, "task", true)).toEqual({
        type: "reply", threadId: 42, text: "Hello agent", photos: undefined,
      })
    })

    it("routes /reply with newline", () => {
      expect(routeCommand("/reply\nMultiline text", 42, "task", true)).toEqual({
        type: "reply", threadId: 42, text: "Multiline text", photos: undefined,
      })
    })

    it("routes bare /reply with empty text", () => {
      expect(routeCommand("/reply", 42, "task", true)).toEqual({
        type: "reply", threadId: 42, text: "", photos: undefined,
      })
    })
  })
})
