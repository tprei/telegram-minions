// MessageFormatter — content format conversion contract.
//
// Each platform has its own markup language (Telegram HTML, Discord
// Markdown, Slack mrkdwn). The MessageFormatter converts structured
// content blocks into the platform's native format.
//
// The current codebase produces Telegram HTML directly in format.ts.
// This interface enables future per-platform formatters without
// changing the orchestration layer. For the initial Telegram adapter,
// the formatter is a passthrough (format.ts already produces HTML).

/** A structured content block that formatters convert to platform markup. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "code"; language?: string; code: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "link"; url: string; label?: string }
  | { type: "raw"; markup: string }

export interface MessageFormatter {
  /**
   * Convert structured content blocks to the platform's native format.
   *
   * For Telegram: produces HTML (`<b>`, `<code>`, etc.)
   * For Discord: produces Markdown (`**bold**`, `` ```code``` ``, etc.)
   * For Slack: produces mrkdwn (`*bold*`, `` ```code``` ``, etc.)
   */
  format(blocks: ContentBlock[]): string

  /**
   * Escape a plain text string for safe embedding in the platform's
   * markup language. Equivalent to HTML-escaping for Telegram.
   */
  escapeText(text: string): string

  /** Maximum message length for this platform (e.g. 4096 for Telegram). */
  readonly maxMessageLength: number
}
