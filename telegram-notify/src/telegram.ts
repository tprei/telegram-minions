const MAX_LENGTH = 4096

/** Remove control characters that Telegram rejects as invalid UTF-8. */
function sanitizeText(text: string): string {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
}

/** Track unclosed HTML tags in a chunk and return closing/reopening strings. */
function balanceHtmlTags(chunk: string): { closingTags: string; reopenTags: string } {
  const tagPattern = /<\/?(\w+)>/g
  const stack: string[] = []
  let match: RegExpExecArray | null

  while ((match = tagPattern.exec(chunk)) !== null) {
    if (match[0].startsWith("</")) {
      const idx = stack.lastIndexOf(match[1])
      if (idx !== -1) stack.splice(idx, 1)
    } else {
      stack.push(match[1])
    }
  }

  const closingTags = [...stack].reverse().map((t) => `</${t}>`).join("")
  const reopenTags = stack.map((t) => `<${t}>`).join("")
  return { closingTags, reopenTags }
}

function splitMessage(html: string): string[] {
  if (html.length <= MAX_LENGTH) return [html]

  const chunks: string[] = []
  let remaining = html

  while (remaining.length > MAX_LENGTH) {
    const slice = remaining.slice(0, MAX_LENGTH)
    const lastNewline = slice.lastIndexOf("\n")
    let splitAt = lastNewline > MAX_LENGTH / 2 ? lastNewline : MAX_LENGTH

    // Avoid splitting inside an HTML tag
    const lastOpen = slice.lastIndexOf("<")
    const lastClose = slice.lastIndexOf(">")
    if (lastOpen > lastClose && lastOpen < splitAt) {
      splitAt = lastOpen
    }

    const chunk = remaining.slice(0, splitAt)
    remaining = remaining.slice(splitAt).trimStart()

    const { closingTags, reopenTags } = balanceHtmlTags(chunk)
    chunks.push(chunk + closingTags)
    if (reopenTags) remaining = reopenTags + remaining
  }

  if (remaining) chunks.push(remaining)
  return chunks
}

async function sendOne(
  token: string,
  chatId: string,
  html: string,
  threadId?: number,
  replyToMessageId?: number,
): Promise<number | null> {
  const sanitized = sanitizeText(html)
  try {
    const body: Record<string, unknown> = { chat_id: chatId, text: sanitized, parse_mode: "HTML" }
    if (threadId !== undefined) body.message_thread_id = threadId
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

export async function sendMessage(
  token: string,
  chatId: string,
  html: string,
  threadId?: number,
  replyToMessageId?: number,
): Promise<{ ok: boolean; messageId: number | null }> {
  const chunks = splitMessage(html)

  const firstId = await sendOne(token, chatId, chunks[0], threadId, replyToMessageId)
  if (firstId === null) return { ok: false, messageId: null }

  for (let i = 1; i < chunks.length; i++) {
    if ((await sendOne(token, chatId, chunks[i], threadId, firstId)) === null)
      return { ok: false, messageId: firstId }
  }

  return { ok: true, messageId: firstId }
}

export async function editMessage(
  token: string,
  chatId: string,
  messageId: number,
  html: string,
  threadId?: number,
): Promise<boolean> {
  const sanitized = sanitizeText(html)
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text: sanitized,
      parse_mode: "HTML",
    }
    if (threadId !== undefined) body.message_thread_id = threadId

    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const resBody = await res.text()
      if (resBody.includes("message is not modified")) return true
      process.stderr.write(`telegram: editMessage HTTP ${res.status}: ${resBody}\n`)
      return false
    }

    return true
  } catch (err) {
    process.stderr.write(`telegram: editMessage fetch failed: ${err}\n`)
    return false
  }
}
