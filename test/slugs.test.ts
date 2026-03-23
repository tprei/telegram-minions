import { describe, it, expect } from "vitest"
import { generateSlug } from "../src/slugs.js"

describe("generateSlug", () => {
  it("returns an adjective-noun pair separated by a hyphen", () => {
    const slug = generateSlug("test-seed")
    expect(slug).toMatch(/^[a-z]+-[a-z]+$/)
  })

  it("is deterministic — same seed produces same slug", () => {
    const a = generateSlug("deterministic-seed")
    const b = generateSlug("deterministic-seed")
    expect(a).toBe(b)
  })

  it("produces different slugs for different seeds", () => {
    const a = generateSlug("seed-alpha")
    const b = generateSlug("seed-beta")
    expect(a).not.toBe(b)
  })

  it("handles empty string seed", () => {
    const slug = generateSlug("")
    expect(slug).toMatch(/^[a-z]+-[a-z]+$/)
  })

  it("handles UUID-style seeds", () => {
    const slug = generateSlug("550e8400-e29b-41d4-a716-446655440000")
    expect(slug).toMatch(/^[a-z]+-[a-z]+$/)
  })
})
