export interface StopHookInput {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode: string
  hook_event_name: string
  stop_hook_active?: boolean
  last_assistant_message?: string
}

export interface HookOutput {
  decision?: "block"
  reason?: string
}

export interface SessionEntry {
  session_id: string
  pane_id: string | null
  cwd: string
  ts: number
}

export interface TelegramUser {
  id: number
  is_bot: boolean
  username?: string
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: { id: number; type: string }
  date: number
  text?: string
  message_thread_id?: number
  is_topic_message?: true
  reply_to_message?: TelegramMessage
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}
