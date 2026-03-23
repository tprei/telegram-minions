const ADJECTIVES = [
  "bold","calm","cool","dark","deep","deft","dusk","fair","fast","fine",
  "firm","free","full","gold","good","gray","grey","high","keen","kind",
  "last","lean","long","loud","mild","mint","mist","near","next","nice",
  "open","pale","peak","pine","pink","pure","rare","rich","rose","sage",
  "salt","sand","silk","slim","slow","soft","sole","star","still","sure",
  "tall","tame","teal","thin","tide","torn","true","vast","warm","wide",
  "wild","wind","wise","worn",
]

const NOUNS = [
  "arc","ash","bay","bog","cap","cay","den","dew","dune","elm",
  "fen","fig","fin","fir","fjord","fog","ford","gale","glen","gorge",
  "gulf","haze","hill","holm","horn","isle","ivy","knoll","lake","larch",
  "lea","ledge","lichen","lime","loch","log","mace","marsh","mead","mesa",
  "mire","mist","moor","moss","oak","peak","pine","pool","reef","ridge",
  "rill","river","rock","rose","run","rush","sand","sedge","shoal","shore",
  "silt","sky","slope","snow","soil","spur","stone","tide","tor","vale",
]

// Simple string hash using the djb-style multiply-and-add recurrence
// (h = h * 31 + char) widely used in Java's String.hashCode and similar.
// The `>>> 0` coerces the result to an unsigned 32-bit integer after every
// step so the value stays in a predictable non-negative range, avoiding
// JavaScript's floating-point quirks for large intermediate sums.
function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h * 31) + s.charCodeAt(i)) >>> 0
  }
  return h
}

export function generateSlug(seed: string): string {
  const h = hash(seed)
  const adj = ADJECTIVES[h % ADJECTIVES.length]
  const noun = NOUNS[Math.floor(h / ADJECTIVES.length) % NOUNS.length]
  return `${adj}-${noun}`
}
