const MAX_LENGTH = 4096

function splitMessage(html: string): string[] {
  if (html.length <= MAX_LENGTH) return [html]

  const chunks: string[] = []
  let remaining = html

  while (remaining.length > MAX_LENGTH) {
    const slice = remaining.slice(0, MAX_LENGTH)
    const lastNewline = slice.lastIndexOf("\n")
    const splitAt = lastNewline > MAX_LENGTH / 2 ? lastNewline : MAX_LENGTH
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  if (remaining) chunks.push(remaining)
  return chunks
}

async function sendOne(
  token: string,
  chatId: string,
  html: string,
  replyToMessageId?: number,
): Promise<number | null> {
  try {
    const body: Record<string, unknown> = { chat_id: chatId, text: html, parse_mode: "HTML" }
    if (replyToMessageId !== undefined) body.reply_to_message_id = replyToMessageId

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const resBody = await res.text()
      process.stderr.write(`telegram: HTTP ${res.status}: ${resBody}\n`)
      return null
    }

    const data = (await res.json()) as { ok: boolean; result: { message_id: number } }
    return data.result.message_id
  } catch (err) {
    process.stderr.write(`telegram: fetch failed: ${err}\n`)
    return null
  }
}

export async function sendMessage(token: string, chatId: string, html: string): Promise<boolean> {
  const chunks = splitMessage(html)

  const firstId = await sendOne(token, chatId, chunks[0])
  if (firstId === null) return false

  for (let i = 1; i < chunks.length; i++) {
    if ((await sendOne(token, chatId, chunks[i], firstId)) === null) return false
  }

  return true
}
