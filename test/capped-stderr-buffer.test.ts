import { describe, it, expect } from "vitest"
import { CappedStderrBuffer } from "../src/session/capped-stderr-buffer.js"

describe("CappedStderrBuffer", () => {
  it("accumulates small chunks normally", () => {
    const buf = new CappedStderrBuffer()
    buf.push("hello ")
    buf.push("world")
    expect(buf.toString()).toBe("hello world")
  })

  it("reports byteLength correctly", () => {
    const buf = new CappedStderrBuffer(1024)
    buf.push("abc")
    expect(buf.byteLength).toBe(3)
    buf.push("def")
    expect(buf.byteLength).toBe(6)
  })

  it("evicts oldest chunks when limit is exceeded", () => {
    const buf = new CappedStderrBuffer(10)
    buf.push("aaaa") // 4 bytes
    buf.push("bbbb") // 4 bytes, total 8
    buf.push("cccc") // 4 bytes, would be 12 → evict "aaaa" → 8
    expect(buf.toString()).toBe("bbbbcccc")
    expect(buf.byteLength).toBeLessThanOrEqual(10)
  })

  it("handles a single chunk larger than maxBytes", () => {
    const buf = new CappedStderrBuffer(8)
    buf.push("abcdefghijklmnop") // 16 bytes > 8
    const result = buf.toString()
    expect(result).toBe("ijklmnop")
    expect(buf.byteLength).toBeLessThanOrEqual(8)
  })

  it("preserves most recent data after many pushes", () => {
    const buf = new CappedStderrBuffer(20)
    for (let i = 0; i < 100; i++) {
      buf.push(`chunk${i} `)
    }
    const result = buf.toString()
    expect(result).toContain("chunk99")
    expect(buf.byteLength).toBeLessThanOrEqual(20)
  })

  it("handles multi-byte characters", () => {
    const buf = new CappedStderrBuffer(10)
    buf.push("café") // 5 bytes in UTF-8 (é = 2 bytes)
    expect(buf.byteLength).toBe(5)
    buf.push("naïve") // 6 bytes → total 11 → evict first
    expect(buf.toString()).toBe("naïve")
  })

  it("defaults to 64KB max", () => {
    const buf = new CappedStderrBuffer()
    const chunk = "x".repeat(1024) // 1KB
    for (let i = 0; i < 100; i++) {
      buf.push(chunk) // 100KB total
    }
    expect(buf.byteLength).toBeLessThanOrEqual(64 * 1024)
    expect(buf.toString().length).toBeGreaterThan(0)
  })

  it("works correctly with empty strings", () => {
    const buf = new CappedStderrBuffer(10)
    buf.push("")
    buf.push("hello")
    buf.push("")
    expect(buf.toString()).toBe("hello")
  })

  it("evicts multiple old chunks to fit new one", () => {
    const buf = new CappedStderrBuffer(12)
    buf.push("aaa") // 3
    buf.push("bbb") // 6
    buf.push("ccc") // 9
    buf.push("ddddddddd") // 9 bytes, evicts aaa+bbb to fit within 12
    expect(buf.toString()).toBe("cccddddddddd")
    expect(buf.byteLength).toBe(12)
  })
})
