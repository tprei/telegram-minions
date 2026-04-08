import { describe, it, expect } from "vitest"
import { isQuotaError, parseResetTime } from "../../src/session/quota-detection.js"

describe("isQuotaError", () => {
  it("detects 'usage limit' messages", () => {
    expect(isQuotaError("You have hit the usage limit for your plan")).toBe(true)
  })

  it("detects 'rate limit' messages", () => {
    expect(isQuotaError("Rate limit exceeded, try again later")).toBe(true)
  })

  it("detects 'quota exceeded' messages", () => {
    expect(isQuotaError("Your quota has been exceeded")).toBe(true)
  })

  it("detects 'too many requests' messages", () => {
    expect(isQuotaError("Too many requests, please slow down")).toBe(true)
  })

  it("detects 'hit the limit' messages", () => {
    expect(isQuotaError("You've hit the limit for today")).toBe(true)
  })

  it("detects 'usage resets' messages", () => {
    expect(isQuotaError("Your usage resets at 5 PM UTC")).toBe(true)
  })

  it("detects 'capacity reached' messages", () => {
    expect(isQuotaError("Capacity reached, please wait")).toBe(true)
  })

  it("detects 'plan usage reached' messages", () => {
    expect(isQuotaError("Your plan usage limit has been reached")).toBe(true)
  })

  it("returns false for normal messages", () => {
    expect(isQuotaError("Hello world")).toBe(false)
    expect(isQuotaError("Task completed successfully")).toBe(false)
    expect(isQuotaError("")).toBe(false)
  })
})

describe("parseResetTime", () => {
  const ref = new Date("2025-06-15T12:00:00Z")

  describe("absolute time with am/pm", () => {
    it("parses '5:00 PM UTC' as future time", () => {
      const ms = parseResetTime("Usage resets at 5:00 PM UTC", ref)
      // 5 PM UTC - 12 PM UTC = 5 hours = 18_000_000ms + 60_000ms buffer
      expect(ms).toBe(5 * 60 * 60 * 1000 + 60_000)
    })

    it("parses '5 PM UTC' without minutes", () => {
      const ms = parseResetTime("Try again at 5 PM UTC", ref)
      expect(ms).toBe(5 * 60 * 60 * 1000 + 60_000)
    })

    it("wraps to next day when time is in the past", () => {
      const ms = parseResetTime("Resets at 10:00 AM UTC", ref)
      // 10 AM is before 12 PM ref, so wraps to next day: 22 hours
      expect(ms).toBe(22 * 60 * 60 * 1000 + 60_000)
    })
  })

  describe("absolute time 24-hour UTC", () => {
    it("parses '17:00 UTC'", () => {
      const ms = parseResetTime("Resets at 17:00 UTC", ref)
      expect(ms).toBe(5 * 60 * 60 * 1000 + 60_000)
    })
  })

  describe("relative time", () => {
    it("parses 'in 30 minutes'", () => {
      const ms = parseResetTime("Try again in 30 minutes", ref)
      expect(ms).toBe(30 * 60 * 1000 + 60_000)
    })

    it("parses 'in 2 hours'", () => {
      const ms = parseResetTime("Resets in 2 hours", ref)
      expect(ms).toBe(2 * 60 * 60 * 1000 + 60_000)
    })

    it("parses 'in 90 seconds'", () => {
      const ms = parseResetTime("Retry in 90 seconds", ref)
      expect(ms).toBe(90 * 1000 + 60_000)
    })

    it("parses abbreviated units like 'mins' and 'hrs'", () => {
      expect(parseResetTime("in 5 mins", ref)).toBe(5 * 60 * 1000 + 60_000)
      expect(parseResetTime("in 1 hr", ref)).toBe(60 * 60 * 1000 + 60_000)
    })
  })

  describe("fallback behavior", () => {
    it("returns default 30 minutes when no time found", () => {
      const ms = parseResetTime("Quota exceeded", ref)
      expect(ms).toBe(30 * 60 * 1000)
    })

    it("uses custom default sleep when provided", () => {
      const ms = parseResetTime("Quota exceeded", ref, 10_000)
      expect(ms).toBe(10_000)
    })
  })

  describe("edge cases", () => {
    it("returns at least 60s even for past times", () => {
      const ms = parseResetTime("in 0 seconds", ref)
      // 0 + 60_000 buffer = 60_000, which equals the 60_000 minimum
      expect(ms).toBeGreaterThanOrEqual(60_000)
    })
  })
})
