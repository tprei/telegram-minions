import { describe, it, expect } from "vitest"
import { CappedStderrBuffer } from "../../src/session/capped-stderr-buffer.js"

describe("CappedStderrBuffer", () => {
  it("stores and concatenates pushed text", () => {
    const buf = new CappedStderrBuffer()
    buf.push("hello ")
    buf.push("world")
    expect(buf.toString()).toBe("hello world")
  })

  it("tracks byteLength accurately", () => {
    const buf = new CappedStderrBuffer()
    buf.push("abc")
    expect(buf.byteLength).toBe(3)
    buf.push("def")
    expect(buf.byteLength).toBe(6)
  })

  it("starts empty", () => {
    const buf = new CappedStderrBuffer()
    expect(buf.toString()).toBe("")
    expect(buf.byteLength).toBe(0)
  })

  it("evicts oldest chunks when capacity is exceeded", () => {
    const buf = new CappedStderrBuffer(10)
    buf.push("aaaa") // 4 bytes
    buf.push("bbbb") // 4 bytes, total 8
    buf.push("cccc") // 4 bytes, would be 12 → evict "aaaa" → total 8
    expect(buf.toString()).toBe("bbbbcccc")
    expect(buf.byteLength).toBeLessThanOrEqual(10)
  })

  it("evicts multiple chunks if needed to fit new text", () => {
    const buf = new CappedStderrBuffer(10)
    buf.push("aa") // 2
    buf.push("bb") // 2, total 4
    buf.push("cc") // 2, total 6
    buf.push("12345678") // 8 bytes, need to evict until 8 fits in 10
    expect(buf.toString()).toContain("12345678")
    expect(buf.byteLength).toBeLessThanOrEqual(10)
  })

  it("truncates a single oversized push to maxBytes from the end", () => {
    const buf = new CappedStderrBuffer(5)
    buf.push("abcdefghij") // 10 bytes > 5
    const result = buf.toString()
    expect(result).toBe("fghij")
    expect(buf.byteLength).toBeLessThanOrEqual(5)
  })

  it("handles oversized push after existing content", () => {
    const buf = new CappedStderrBuffer(5)
    buf.push("xx")
    buf.push("abcdefghij") // oversized, replaces everything
    const result = buf.toString()
    expect(result).toBe("fghij")
    expect(buf.byteLength).toBeLessThanOrEqual(5)
  })

  it("handles multi-byte characters in byteLength tracking", () => {
    const buf = new CappedStderrBuffer(10)
    // "é" is 2 bytes in UTF-8
    buf.push("éé") // 4 bytes
    expect(buf.byteLength).toBe(4)
    buf.push("aaaaaa") // 6 bytes, total 10 — exactly at limit
    expect(buf.byteLength).toBe(10)
    expect(buf.toString()).toBe("ééaaaaaa")
  })

  it("uses default max of 64KB", () => {
    const buf = new CappedStderrBuffer()
    const chunk = "x".repeat(1024)
    for (let i = 0; i < 64; i++) {
      buf.push(chunk) // push 64KB total
    }
    expect(buf.byteLength).toBe(64 * 1024)
    // One more push should cause eviction
    buf.push("overflow")
    expect(buf.byteLength).toBeLessThanOrEqual(64 * 1024)
  })

  it("exact fit does not evict", () => {
    const buf = new CappedStderrBuffer(6)
    buf.push("abc") // 3
    buf.push("def") // 3, total 6 — exactly at limit
    expect(buf.toString()).toBe("abcdef")
    expect(buf.byteLength).toBe(6)
  })
})
