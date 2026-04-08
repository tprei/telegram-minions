import { describe, it, expect } from "vitest"
import { Readable } from "node:stream"
import type http from "node:http"
import { parseBody } from "../src/http-utils.js"

function fakeRequest(chunks: string[]): http.IncomingMessage {
  const stream = new Readable({
    read() {
      for (const chunk of chunks) {
        this.push(Buffer.from(chunk))
      }
      this.push(null)
    },
  })
  return stream as unknown as http.IncomingMessage
}

describe("parseBody", () => {
  it("parses a valid JSON body from a single chunk", async () => {
    const req = fakeRequest(['{"key":"value"}'])
    const result = await parseBody(req)
    expect(result).toEqual({ key: "value" })
  })

  it("parses a valid JSON body split across multiple chunks", async () => {
    const req = fakeRequest(['{"ke', 'y":"va', 'lue"}'])
    const result = await parseBody(req)
    expect(result).toEqual({ key: "value" })
  })

  it("rejects with an error for invalid JSON", async () => {
    const req = fakeRequest(["not json"])
    await expect(parseBody(req)).rejects.toThrow("Invalid JSON body")
  })

  it("rejects when the stream emits an error", async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error("connection reset"))
      },
    })
    const req = stream as unknown as http.IncomingMessage
    await expect(parseBody(req)).rejects.toThrow("connection reset")
  })

  it("parses an empty JSON object", async () => {
    const req = fakeRequest(["{}"])
    const result = await parseBody(req)
    expect(result).toEqual({})
  })

  it("parses a JSON array", async () => {
    const req = fakeRequest(['[1,2,3]'])
    const result = await parseBody(req)
    expect(result).toEqual([1, 2, 3])
  })

  it("rejects for an empty body", async () => {
    const req = fakeRequest([""])
    await expect(parseBody(req)).rejects.toThrow("Invalid JSON body")
  })
})
