import { describe, it, expect } from "vitest"
import { CappedStderrBuffer } from "../../src/session/capped-stderr-buffer.js"

describe("CappedStderrBuffer", () => {
  it("stores and returns pushed text", () => {
    const buf = new CappedStderrBuffer()
    buf.push("hello ")
    buf.push("world")
    expect(buf.toString()).toBe("hello world")
  })

  it("tracks byteLength", () => {
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
    buf.push("cccc") // 4 bytes, would be 12 → evicts "aaaa" then fits
    expect(buf.toString()).toBe("bbbbcccc")
  })

  it("evicts multiple chunks to make room", () => {
    const buf = new CappedStderrBuffer(10)
    buf.push("aa") // 2
    buf.push("bb") // 2, total 4
    buf.push("cc") // 2, total 6
    buf.push("ddddddddd") // 9 bytes, need to evict all three (6 bytes) to fit
    expect(buf.toString()).toBe("ddddddddd")
    expect(buf.byteLength).toBe(9)
  })

  it("truncates a single chunk larger than maxBytes", () => {
    const buf = new CappedStderrBuffer(5)
    buf.push("abcdefghij") // 10 bytes, exceeds 5
    // Should keep the last 5 characters
    expect(buf.toString()).toBe("fghij")
    expect(buf.byteLength).toBe(5)
  })

  it("handles multi-byte characters in byteLength", () => {
    const buf = new CappedStderrBuffer(100)
    const emoji = "😀" // 4 bytes in UTF-8
    buf.push(emoji)
    expect(buf.byteLength).toBe(Buffer.byteLength(emoji))
  })

  it("accepts exactly maxBytes without eviction", () => {
    const buf = new CappedStderrBuffer(10)
    buf.push("aaaaa") // 5
    buf.push("bbbbb") // 5, total 10 — exactly at limit
    expect(buf.toString()).toBe("aaaaabbbbb")
    expect(buf.byteLength).toBe(10)
  })

  it("uses default max of 64KB", () => {
    const buf = new CappedStderrBuffer()
    // Push 64KB of data — should all fit
    const chunk = "x".repeat(1024)
    for (let i = 0; i < 64; i++) {
      buf.push(chunk)
    }
    expect(buf.byteLength).toBe(65536)
    // One more byte should trigger eviction
    buf.push("y")
    expect(buf.byteLength).toBeLessThanOrEqual(65536)
    expect(buf.toString().endsWith("y")).toBe(true)
  })
})
