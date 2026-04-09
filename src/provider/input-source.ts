// ChatInputSource — input polling/receiving contract.
//
// Abstracts how a platform receives incoming messages and callbacks.
// Telegram uses long-polling; Discord/Slack use websockets or webhooks.
// The dispatcher calls poll() in a loop or subscribes to events.

import type { ChatUpdate } from "./types.js"

export interface ChatInputSource {
  /**
   * Poll for new updates. Returns an array of platform-agnostic updates.
   *
   * For poll-based platforms (Telegram), this performs a long-poll with the
   * given timeout. For event-based platforms (Discord, Slack), this may
   * drain a buffered queue or block until events arrive.
   *
   * @param cursor - Opaque cursor/offset for pagination. Pass the value
   *   returned by `getCursor()` after processing updates.
   * @param timeoutSeconds - How long to wait for new updates (0 = non-blocking).
   */
  poll(cursor: string, timeoutSeconds: number): Promise<ChatUpdate[]>

  /**
   * Get the current cursor position. The dispatcher persists this between
   * poll cycles to avoid reprocessing updates.
   */
  getCursor(): string

  /**
   * Advance the cursor past the given updates. Call after successfully
   * processing a batch of updates.
   */
  advanceCursor(updates: ChatUpdate[]): void
}
