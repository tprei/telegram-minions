// FileHandler — file upload/download contract.
//
// Platforms that support sending and receiving files implement this
// interface. Used by the Observer to send screenshots and by the
// Dispatcher to download user-attached images.

import type { MessageId, ThreadId } from "./types.js"

export interface FileHandler {
  /**
   * Send a photo from a file path.
   * Returns the message ID on success, null on failure.
   */
  sendPhoto(
    photoPath: string,
    threadId?: ThreadId,
    caption?: string,
  ): Promise<MessageId | null>

  /**
   * Send a photo from an in-memory buffer.
   * Returns the message ID on success, null on failure.
   */
  sendPhotoBuffer(
    buffer: Buffer,
    filename: string,
    threadId?: ThreadId,
    caption?: string,
  ): Promise<MessageId | null>

  /**
   * Download a file by its platform-specific file ID to a local path.
   * Returns true on success, false on failure.
   */
  downloadFile(fileId: string, destPath: string): Promise<boolean>
}
