/** Default sleep duration (ms) when reset time cannot be parsed. */
const DEFAULT_SLEEP_MS = 30 * 60 * 1000 // 30 minutes

/** Extra buffer (ms) added after parsed reset time. */
const RESET_BUFFER_MS = 60 * 1000 // 1 minute

const QUOTA_PATTERNS = [
  /usage.*limit/i,
  /rate.*limit/i,
  /quota.*exceeded/i,
  /out of.*usage/i,
  /hit.*(?:the|your|a)?\s*limit/i,
  /exceeded.*(?:the|your)?\s*(?:usage|rate|quota)/i,
  /usage.*(?:resets?|renews?)/i,
  /max.*(?:usage|tokens?).*(?:reached|exceeded)/i,
  /capacity.*(?:reached|exceeded|limit)/i,
  /too many requests/i,
  /plan.*(?:usage|limit).*(?:reached|exceeded)/i,
]

/** Returns true if the text looks like a Claude quota/rate-limit error. */
export function isQuotaError(text: string): boolean {
  return QUOTA_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * Attempts to extract a reset time from quota error text and returns the
 * number of milliseconds to sleep until that time (plus a small buffer).
 *
 * Falls back to `defaultSleepMs` when no recognizable time is found.
 */
export function parseResetTime(text: string, now?: Date, defaultSleepMs?: number): number {
  const fallback = defaultSleepMs ?? DEFAULT_SLEEP_MS
  const ref = now ?? new Date()

  const parsed = tryParseAbsoluteTime(text, ref) ?? tryParseRelativeTime(text)

  if (parsed === null) return fallback

  // Ensure we sleep at least a small amount even if the time is in the past
  return Math.max(parsed + RESET_BUFFER_MS, 60_000)
}

// ---------------------------------------------------------------------------
// Absolute time patterns
// ---------------------------------------------------------------------------

/**
 * Matches patterns like:
 *   "5:00 PM UTC", "5 PM UTC", "17:00 UTC", "5:00PM UTC"
 *   "5:00 pm", "5pm"
 * Requires am/pm and/or UTC — bare numbers like "2" won't match.
 */
const ABSOLUTE_TIME_WITH_AMPM_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(UTC|utc)?\b/i
const ABSOLUTE_TIME_24H_UTC_RE = /\b(\d{1,2}):(\d{2})\s+(UTC|utc)\b/i

function tryParseAbsoluteTime(text: string, ref: Date): number | null {
  // Try am/pm pattern first, then 24-hour UTC pattern
  const ampmMatch = ABSOLUTE_TIME_WITH_AMPM_RE.exec(text)
  const utcMatch = ABSOLUTE_TIME_24H_UTC_RE.exec(text)
  const match = ampmMatch ?? utcMatch
  if (!match) return null

  let hours = parseInt(match[1], 10)
  const minutes = match[2] ? parseInt(match[2], 10) : 0
  const ampm = ampmMatch ? match[3]?.toLowerCase() : undefined
  const isUtc = ampmMatch ? !!match[4] : true // 24h pattern always has UTC

  if (hours > 23 || minutes > 59) return null

  // Convert 12-hour to 24-hour
  if (ampm === "pm" && hours < 12) hours += 12
  if (ampm === "am" && hours === 12) hours = 0

  // Build target date in the appropriate timezone
  const target = new Date(ref)
  if (isUtc) {
    target.setUTCHours(hours, minutes, 0, 0)
    // If the target is in the past, assume it means tomorrow
    if (target.getTime() <= ref.getTime()) {
      target.setUTCDate(target.getUTCDate() + 1)
    }
  } else {
    target.setHours(hours, minutes, 0, 0)
    if (target.getTime() <= ref.getTime()) {
      target.setDate(target.getDate() + 1)
    }
  }

  return target.getTime() - ref.getTime()
}

// ---------------------------------------------------------------------------
// Relative time patterns
// ---------------------------------------------------------------------------

/**
 * Matches patterns like:
 *   "in 30 minutes", "in 2 hours", "resets in 1 hour"
 *   "after 45 minutes", "try again in 90 minutes"
 */
const RELATIVE_TIME_RE = /\bin\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|seconds?|secs?)\b/i

function tryParseRelativeTime(text: string): number | null {
  const match = RELATIVE_TIME_RE.exec(text)
  if (!match) return null

  const value = parseInt(match[1], 10)
  const unit = match[2].toLowerCase()

  if (unit.startsWith("hour") || unit.startsWith("hr")) {
    return value * 60 * 60 * 1000
  }
  if (unit.startsWith("min")) {
    return value * 60 * 1000
  }
  if (unit.startsWith("sec")) {
    return value * 1000
  }

  return null
}
