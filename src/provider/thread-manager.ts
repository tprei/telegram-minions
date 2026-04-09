// ThreadManager — thread/topic lifecycle contract.
//
// Platforms that support threaded conversations (Telegram forum topics,
// Discord threads, Slack threads) implement this interface. Platforms
// without native threading can use a no-op or channel-based adapter.

import type { ThreadId, ThreadInfo } from "./types.js"

export interface ThreadManager {
  /** Create a new thread/topic with the given name. */
  createThread(name: string): Promise<ThreadInfo>

  /** Rename an existing thread. */
  editThread(threadId: ThreadId, name: string): Promise<void>

  /** Close/archive a thread. Best-effort. */
  closeThread(threadId: ThreadId): Promise<void>

  /** Delete a thread entirely. Best-effort. */
  deleteThread(threadId: ThreadId): Promise<void>
}
