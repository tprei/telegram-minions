import { describe, it, expect } from "vitest"
import { CappedStderrBuffer } from "../../src/session/capped-stderr-buffer.js"

describe("CappedStderrBuffer", () => {
  it("starts empty", () => {
    const buf = new CappedStderrBuffer(64)
    expect(buf.toString()).toBe("")
    expect(buf.byteLength).toBe(0)
  })

  it("appends chunks under the limit", () => {
    const buf = new CappedStderrBuffer(64)
    buf.push("hello ")
    buf.push("world")
    expect(buf.toString()).toBe("hello world")
    expect(buf.byteLength).toBe(11)
  })

  it("counts UTF-8 byte length for multibyte input", () => {
    const buf = new CappedStderrBuffer(64)
    buf.push("héllo")
    expect(buf.byteLength).toBe(Buffer.byteLength("héllo"))
    expect(buf.toString()).toBe("héllo")
  })

  it("fills exactly to maxBytes without evicting", () => {
    const buf = new CappedStderrBuffer(10)
    buf.push("abcdefghij")
    expect(buf.toString()).toBe("abcdefghij")
    expect(buf.byteLength).toBe(10)
  })

  it("evicts oldest chunks when a new chunk would exceed maxBytes", () => {
    const buf = new CappedStderrBuffer(10)
    buf.push("aaa")
    buf.push("bbb")
    buf.push("cccc")
    buf.push("dddd")
    const out = buf.toString()
    expect(buf.byteLength).toBeLessThanOrEqual(10)
    expect(out.endsWith("dddd")).toBe(true)
    expect(out).not.toContain("aaa")
  })

  it("evicts only as many old chunks as needed to fit the new chunk", () => {
    const buf = new CappedStderrBuffer(10)
    buf.push("aaaa")
    buf.push("bbbb")
    buf.push("cccc")
    expect(buf.toString()).toBe("bbbbcccc")
    expect(buf.byteLength).toBe(8)
  })

  it("truncates a single chunk larger than maxBytes to its trailing window", () => {
    const buf = new CappedStderrBuffer(5)
    buf.push("oldold")
    buf.push("0123456789ABCDEF")
    expect(buf.toString()).toBe("BCDEF")
    expect(buf.byteLength).toBe(5)
  })

  it("truncates an oversized chunk even when the buffer was empty", () => {
    const buf = new CappedStderrBuffer(4)
    buf.push("LONGTEXT")
    expect(buf.toString()).toBe("TEXT")
    expect(buf.byteLength).toBe(4)
  })

  it("uses the default cap of 64 KiB when no size is given", () => {
    const buf = new CappedStderrBuffer()
    const chunk = "x".repeat(32 * 1024)
    buf.push(chunk)
    buf.push(chunk)
    expect(buf.byteLength).toBe(64 * 1024)
    buf.push("y")
    expect(buf.byteLength).toBeLessThanOrEqual(64 * 1024)
    expect(buf.toString().endsWith("y")).toBe(true)
  })

  it("handles empty pushes without changing state", () => {
    const buf = new CappedStderrBuffer(8)
    buf.push("hi")
    buf.push("")
    expect(buf.toString()).toBe("hi")
    expect(buf.byteLength).toBe(2)
  })
})
