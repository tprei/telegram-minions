export interface StopHookInput {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode: string
  hook_event_name: "Stop"
  stop_hook_active: boolean
  last_assistant_message: string
}

export interface HookOutput {
  decision?: "block"
  reason?: string
}
