import { describe, it, expect } from "vitest"
import { isQuotaError, parseResetTime } from "../src/session/quota-detection.js"

describe("isQuotaError", () => {
  const positives = [
    "You've hit your usage limit for the day",
    "Rate limit exceeded, please try again later",
    "Your quota has been exceeded",
    "You are out of usage for Claude Pro",
    "You've hit the limit for your current plan",
    "Exceeded your usage allowance",
    "Usage resets at 5 PM UTC",
    "Max tokens exceeded for this billing period",
    "Capacity limit reached",
    "Too many requests, slow down",
    "Plan usage limit reached",
    "You've exceeded the rate for this model",
    "usage limit reached, resets in 2 hours",
    "Hit your limit — try again at 5:00 PM UTC",
    "You've hit a limit on your plan. Usage resets at 5 PM UTC.",
  ]

  for (const text of positives) {
    it(`detects: "${text.slice(0, 60)}..."`, () => {
      expect(isQuotaError(text)).toBe(true)
    })
  }

  const negatives = [
    "Session completed successfully",
    "Error: file not found",
    "The quick brown fox jumps over the lazy dog",
    "Connection refused",
    "Timeout waiting for response",
    "",
  ]

  for (const text of negatives) {
    it(`rejects: "${text || "(empty)"}"`, () => {
      expect(isQuotaError(text)).toBe(false)
    })
  }
})

describe("parseResetTime", () => {
  // Use a fixed reference time: 2026-04-01 14:00:00 UTC
  const ref = new Date("2026-04-01T14:00:00Z")

  describe("absolute time parsing", () => {
    it("parses '5 PM UTC' as ~3h from 14:00 UTC", () => {
      const ms = parseResetTime("Usage resets at 5 PM UTC", ref)
      // 3 hours + 1 minute buffer = 10860000
      expect(ms).toBe(3 * 3600_000 + 60_000)
    })

    it("parses '5:00 PM UTC'", () => {
      const ms = parseResetTime("resets at 5:00 PM UTC", ref)
      expect(ms).toBe(3 * 3600_000 + 60_000)
    })

    it("parses '17:00 UTC' (24-hour format without am/pm)", () => {
      const ms = parseResetTime("resets at 17:00 UTC", ref)
      expect(ms).toBe(3 * 3600_000 + 60_000)
    })

    it("wraps to next day if time is in the past", () => {
      // 10:00 UTC is in the past relative to 14:00 UTC
      const ms = parseResetTime("resets at 10:00 AM UTC", ref)
      // 20h until next day 10:00 + 1 min buffer
      expect(ms).toBe(20 * 3600_000 + 60_000)
    })

    it("handles '12 PM' correctly (noon)", () => {
      // 12 PM UTC is 2h in the past from 14:00 UTC → wraps to next day
      const ms = parseResetTime("resets at 12 PM UTC", ref)
      expect(ms).toBe(22 * 3600_000 + 60_000)
    })

    it("handles '12 AM' correctly (midnight)", () => {
      // 12 AM (midnight) UTC from 14:00 UTC → 10h ahead
      const ms = parseResetTime("resets at 12 AM UTC", ref)
      expect(ms).toBe(10 * 3600_000 + 60_000)
    })
  })

  describe("relative time parsing", () => {
    it("parses 'in 30 minutes'", () => {
      const ms = parseResetTime("try again in 30 minutes", ref)
      expect(ms).toBe(30 * 60_000 + 60_000)
    })

    it("parses 'in 2 hours'", () => {
      const ms = parseResetTime("resets in 2 hours", ref)
      expect(ms).toBe(2 * 3600_000 + 60_000)
    })

    it("parses 'in 1 hour'", () => {
      const ms = parseResetTime("quota resets in 1 hour", ref)
      expect(ms).toBe(1 * 3600_000 + 60_000)
    })

    it("parses 'in 90 mins'", () => {
      const ms = parseResetTime("wait, resets in 90 mins", ref)
      expect(ms).toBe(90 * 60_000 + 60_000)
    })

    it("parses 'in 45 seconds'", () => {
      const ms = parseResetTime("retry in 45 seconds", ref)
      // 45s + 1min buffer, but min is 60s → max(45000+60000, 60000) = 105000
      expect(ms).toBe(45_000 + 60_000)
    })
  })

  describe("fallback behavior", () => {
    it("returns default 30 minutes when no time found", () => {
      const ms = parseResetTime("quota exceeded", ref)
      expect(ms).toBe(30 * 60_000)
    })

    it("uses custom default when provided", () => {
      const ms = parseResetTime("quota exceeded", ref, 10 * 60_000)
      expect(ms).toBe(10 * 60_000)
    })

    it("returns at least 60s even if parsed time is tiny", () => {
      // "in 0 minutes" would be 0ms + buffer = 60s, and min is 60s
      const ms = parseResetTime("resets in 0 minutes", ref)
      expect(ms).toBe(60_000)
    })
  })

  describe("prefers absolute over relative when both present", () => {
    it("picks absolute time first", () => {
      const ms = parseResetTime("resets at 5 PM UTC, try again in 30 minutes", ref)
      // Should match 5 PM UTC → 3h + buffer
      expect(ms).toBe(3 * 3600_000 + 60_000)
    })
  })
})
