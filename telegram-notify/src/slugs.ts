const ADJECTIVES = [
  "amber", "azure", "bold", "brave", "bright", "calm", "cedar", "clear",
  "cold", "coral", "crisp", "dark", "dawn", "deep", "deft", "dry",
  "dusk", "early", "even", "fair", "fast", "fern", "firm", "flat",
  "fleet", "fresh", "frost", "gold", "grand", "gray", "green", "grey",
  "hard", "high", "hush", "iron", "jade", "keen", "kind", "lake",
  "late", "lean", "light", "lime", "lone", "long", "loud", "low",
  "mild", "mint", "mist", "moss", "mute", "new", "next", "noon",
  "oak", "old", "pale", "pine", "plain", "pure", "quick", "quiet",
]

const NOUNS = [
  "arc", "ash", "bay", "beam", "bird", "blade", "bloom", "bolt",
  "bone", "brook", "cave", "cliff", "cloud", "creek", "crest", "crow",
  "dale", "dawn", "dell", "dew", "dune", "dust", "fall", "fawn",
  "field", "fire", "flint", "flow", "foam", "fold", "ford", "forge",
  "fox", "frost", "gale", "gate", "glade", "glen", "glow", "grain",
  "grove", "gulf", "haze", "hill", "hive", "hold", "horn", "hull",
  "isle", "knoll", "lake", "lane", "leaf", "ledge", "log", "marsh",
  "mead", "mill", "moor", "moss", "peak", "pine", "pool", "reed",
  "ridge", "rift", "rise", "river", "rock", "root", "rune", "rush",
]

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0
  }
  return h
}

export function generateSlug(sessionId: string): string {
  const h = hash(sessionId)
  const adj = ADJECTIVES[h % ADJECTIVES.length]
  const noun = NOUNS[Math.floor(h / ADJECTIVES.length) % NOUNS.length]
  return `${adj}-${noun}`
}
