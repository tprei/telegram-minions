// InteractiveUI — optional interactive element contract.
//
// Platforms that support inline keyboards / buttons / select menus
// implement this interface. It is optional — platforms without
// interactive elements (e.g. a CLI adapter) can omit it.

import type { KeyboardButton, MessageId, ThreadId } from "./types.js"

export interface InteractiveUI {
  /**
   * Send a message with an inline keyboard (button grid).
   * Returns the message ID for later editing/deletion, or null on failure.
   */
  sendMessageWithKeyboard(
    content: string,
    keyboard: KeyboardButton[][],
    threadId?: ThreadId,
  ): Promise<MessageId | null>

  /**
   * Acknowledge a callback query (button press). Optionally shows a
   * brief notification to the user.
   */
  answerCallbackQuery(queryId: string, text?: string): Promise<void>
}
