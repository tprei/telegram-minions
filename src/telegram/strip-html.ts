const TAG_RE = /<\/?(?:a(?:\s+[^>]*)?|b|i|s|code|pre|blockquote|br)[^>]*>/gi
const ENTITY_MAP: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": "\"",
  "&#39;": "'",
  "&nbsp;": " ",
}
const ENTITY_RE = /&(?:lt|gt|amp|quot|#39|nbsp);/g

/**
 * Strip Telegram-style HTML tags so the content survives as plain text in
 * `TopicSession.conversation`. The formatter vocabulary is `<b>`, `<i>`,
 * `<s>`, `<code>`, `<pre>`, `<a href>`, `<blockquote>`, `<br>` — everything
 * else is passed through unchanged. Entity-decodes the handful of escapes
 * `esc()` emits (see src/telegram/format.ts).
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(TAG_RE, "")
    .replace(ENTITY_RE, (match) => ENTITY_MAP[match] ?? match)
    .trim()
}
