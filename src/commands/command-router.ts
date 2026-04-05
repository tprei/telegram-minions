import type { SessionMode } from "../domain/session-types.js"
import type { TelegramPhotoSize } from "../domain/telegram-types.js"
import {
  TASK_PREFIX, TASK_SHORT, PLAN_PREFIX, THINK_PREFIX, REVIEW_PREFIX,
  EXECUTE_CMD, STATUS_CMD, STATS_CMD, REPLY_PREFIX, REPLY_SHORT,
  CLOSE_CMD, STOP_CMD, HELP_CMD, CLEAN_CMD, USAGE_CMD, CONFIG_CMD,
  SPLIT_CMD, STACK_CMD, DAG_CMD, JUDGE_CMD, LAND_CMD, RETRY_CMD, FORCE_CMD, DONE_CMD, DOCTOR_CMD, SHIP_PREFIX,
} from "./command-parser.js"

export type RoutedCommand =
  | { type: "status" }
  | { type: "stats" }
  | { type: "usage" }
  | { type: "clean" }
  | { type: "help" }
  | { type: "config"; args: string }
  | { type: "review"; args: string; threadId?: number }
  | { type: "think"; args: string; threadId?: number; photos?: TelegramPhotoSize[] }
  | { type: "plan"; args: string; threadId?: number; photos?: TelegramPhotoSize[] }
  | { type: "ship"; args: string; threadId?: number }
  | { type: "task"; args: string; threadId?: number; photos?: TelegramPhotoSize[] }
  | { type: "close"; threadId: number }
  | { type: "stop"; threadId: number }
  | { type: "execute"; threadId: number; directive?: string }
  | { type: "split"; threadId: number; directive?: string }
  | { type: "stack"; threadId: number; directive?: string }
  | { type: "dag"; threadId: number; directive?: string }
  | { type: "judge"; threadId: number; directive?: string }
  | { type: "land"; threadId: number }
  | { type: "done"; threadId: number }
  | { type: "retry"; threadId: number; nodeId?: string }
  | { type: "force"; threadId: number; nodeId?: string }
  | { type: "doctor"; threadId: number; directive?: string }
  | { type: "reply"; threadId: number; text: string; photos?: TelegramPhotoSize[] }

/**
 * Pure routing function: parses a text message into a structured command.
 *
 * Returns null if the message doesn't match any known command.
 *
 * @param text       - Trimmed message text (may be undefined if only photos)
 * @param threadId   - Thread ID if the message is in a topic, undefined if in the main chat
 * @param sessionMode - The mode of the active topic session (if any)
 * @param hasSession - Whether there's an active topic session for this thread
 * @param photos     - Attached photos (if any)
 */
export function routeCommand(
  text: string | undefined,
  threadId: number | undefined,
  sessionMode: SessionMode | undefined,
  hasSession: boolean,
  photos?: TelegramPhotoSize[],
): RoutedCommand | null {
  if (!text && !photos) return null

  // Global commands (no thread context required)
  if (threadId === undefined) {
    if (text === STATUS_CMD) return { type: "status" }
    if (text === STATS_CMD) return { type: "stats" }
    if (text === USAGE_CMD) return { type: "usage" }
    if (text === CLEAN_CMD) return { type: "clean" }
    if (text === HELP_CMD) return { type: "help" }
    if (text === CONFIG_CMD || text?.startsWith(CONFIG_CMD + " ")) {
      return { type: "config", args: text!.slice(CONFIG_CMD.length).trim() }
    }
  }

  // Session-creating commands (work from any context)
  if (text?.startsWith(REVIEW_PREFIX)) {
    return { type: "review", args: text.slice(REVIEW_PREFIX.length).trim(), threadId }
  }
  if (text?.startsWith(THINK_PREFIX)) {
    return { type: "think", args: text.slice(THINK_PREFIX.length).trim(), threadId, photos }
  }
  if (text?.startsWith(PLAN_PREFIX)) {
    return { type: "plan", args: text.slice(PLAN_PREFIX.length).trim(), threadId, photos }
  }
  if (text?.startsWith(SHIP_PREFIX)) {
    return { type: "ship", args: text.slice(SHIP_PREFIX.length).trim(), threadId }
  }
  if (text?.startsWith(TASK_PREFIX) || text?.startsWith(TASK_SHORT + " ") || text === TASK_SHORT) {
    const args = text.startsWith(TASK_PREFIX)
      ? text.slice(TASK_PREFIX.length).trim()
      : text.slice(TASK_SHORT.length).trim()
    return { type: "task", args, threadId, photos }
  }

  // Thread-scoped commands (require an active topic session)
  if (threadId !== undefined && hasSession) {
    if (text === CLOSE_CMD) return { type: "close", threadId }
    if (text === STOP_CMD) return { type: "stop", threadId }
    if (text === DOCTOR_CMD || text?.startsWith(DOCTOR_CMD + " ")) {
      return { type: "doctor", threadId, directive: text!.slice(DOCTOR_CMD.length).trim() || undefined }
    }

    const isPlanLike = sessionMode === "plan" || sessionMode === "think" || sessionMode === "ship-plan" || sessionMode === "ship-think"
    const isExecutable = isPlanLike || sessionMode === "review"

    if (isExecutable && (text === EXECUTE_CMD || text?.startsWith(EXECUTE_CMD + " "))) {
      return { type: "execute", threadId, directive: text!.slice(EXECUTE_CMD.length).trim() || undefined }
    }
    if (isPlanLike && (text === SPLIT_CMD || text?.startsWith(SPLIT_CMD + " "))) {
      return { type: "split", threadId, directive: text!.slice(SPLIT_CMD.length).trim() || undefined }
    }
    if (isPlanLike && (text === STACK_CMD || text?.startsWith(STACK_CMD + " "))) {
      return { type: "stack", threadId, directive: text!.slice(STACK_CMD.length).trim() || undefined }
    }
    if (isPlanLike && (text === DAG_CMD || text?.startsWith(DAG_CMD + " "))) {
      return { type: "dag", threadId, directive: text!.slice(DAG_CMD.length).trim() || undefined }
    }
    if (isPlanLike && (text === JUDGE_CMD || text?.startsWith(JUDGE_CMD + " "))) {
      return { type: "judge", threadId, directive: text!.slice(JUDGE_CMD.length).trim() || undefined }
    }
    if (text === LAND_CMD) return { type: "land", threadId }
    if (text === DONE_CMD) return { type: "done", threadId }
    if (text === RETRY_CMD || text?.startsWith(RETRY_CMD + " ")) {
      return { type: "retry", threadId, nodeId: text!.slice(RETRY_CMD.length).trim() || undefined }
    }
    if (text?.startsWith(FORCE_CMD + " ") || text === FORCE_CMD) {
      return { type: "force", threadId, nodeId: text!.slice(FORCE_CMD.length).trim() || undefined }
    }
    if (text?.startsWith(REPLY_PREFIX + " ") || text?.startsWith(REPLY_PREFIX + "\n") ||
        text?.startsWith(REPLY_SHORT + " ") || text?.startsWith(REPLY_SHORT + "\n") ||
        text === REPLY_PREFIX || text === REPLY_SHORT) {
      const stripped = text.startsWith(REPLY_PREFIX)
        ? text.slice(REPLY_PREFIX.length).trim()
        : text.slice(REPLY_SHORT.length).trim()
      return { type: "reply", threadId, text: stripped, photos }
    }
  }

  return null
}
