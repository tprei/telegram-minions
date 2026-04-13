const DEFAULT_MAX_BYTES = 64 * 1024

export class CappedStderrBuffer {
  private chunks: string[] = []
  private totalBytes = 0
  private readonly maxBytes: number

  constructor(maxBytes = DEFAULT_MAX_BYTES) {
    this.maxBytes = maxBytes
  }

  push(text: string): void {
    const textBytes = Buffer.byteLength(text)

    if (this.totalBytes + textBytes <= this.maxBytes) {
      this.chunks.push(text)
      this.totalBytes += textBytes
      return
    }

    while (this.chunks.length > 0 && this.totalBytes + textBytes > this.maxBytes) {
      const removed = this.chunks.shift()!
      this.totalBytes -= Buffer.byteLength(removed)
    }

    if (textBytes > this.maxBytes) {
      const truncated = text.slice(-this.maxBytes)
      this.chunks = [truncated]
      this.totalBytes = Buffer.byteLength(truncated)
    } else {
      this.chunks.push(text)
      this.totalBytes += textBytes
    }
  }

  toString(): string {
    return this.chunks.join("")
  }

  get byteLength(): number {
    return this.totalBytes
  }
}
