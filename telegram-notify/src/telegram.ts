const MAX_LENGTH = 4096
const TRUNCATION_MARKER = "\n[truncated]"

export async function sendMessage(token: string, chatId: string, html: string): Promise<boolean> {
  const text = html.length > MAX_LENGTH
    ? html.slice(0, MAX_LENGTH - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
    : html

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    })

    if (!res.ok) {
      const body = await res.text()
      process.stderr.write(`telegram: HTTP ${res.status}: ${body}\n`)
      return false
    }

    return true
  } catch (err) {
    process.stderr.write(`telegram: fetch failed: ${err}\n`)
    return false
  }
}
