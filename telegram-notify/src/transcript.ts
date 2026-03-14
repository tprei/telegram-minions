import { readFileSync } from "node:fs"

export function extractLastInstruction(transcriptPath: string): string | null {
  try {
    const lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i])
      if (
        entry.type === "user" &&
        !entry.isMeta &&
        typeof entry.message?.content === "string" &&
        !entry.message.content.startsWith("<")
      ) {
        return entry.message.content.trim()
      }
    }
    return null
  } catch {
    return null
  }
}
