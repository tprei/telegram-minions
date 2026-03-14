import { readFileSync } from "node:fs"

export function extractLastInstruction(transcriptPath: string): string | null {
  try {
    const lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i])
      if (entry.type !== "user" || entry.isMeta) continue
      const content = entry.message?.content
      if (typeof content !== "string") continue

      const commandMatch = content.match(/<command-name>(\S+)<\/command-name>/)
      if (commandMatch) return commandMatch[1]

      if (!content.startsWith("<")) return content.trim()
    }
    return null
  } catch {
    return null
  }
}
