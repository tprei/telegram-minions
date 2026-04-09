// ChatProvider — core messaging contract.
//
// Every platform adapter must implement this interface. It covers
// the minimum set of operations needed by the Observer and Dispatcher:
// sending, editing, deleting, and pinning messages.

import type { MessageId, SendResult, ThreadId } from "./types.js"

export interface ChatProvider {
  /** Send a formatted message to a thread. Returns the first message's ID. */
  sendMessage(
    content: string,
    threadId?: ThreadId,
    replyToMessageId?: MessageId,
  ): Promise<SendResult>

  /** Edit an existing message's content. Returns true on success. */
  editMessage(
    messageId: MessageId,
    content: string,
    threadId?: ThreadId,
  ): Promise<boolean>

  /** Delete a message. Best-effort — implementations should not throw on failure. */
  deleteMessage(messageId: MessageId): Promise<void>

  /** Pin a message in the chat. Best-effort. */
  pinMessage(messageId: MessageId): Promise<void>
}
