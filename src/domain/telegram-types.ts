// Telegram Bot API types

export interface TelegramUser {
  id: number
  is_bot: boolean
  username?: string
  first_name?: string
}

export interface TelegramPhotoSize {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: { id: number; type: string }
  date: number
  text?: string
  caption?: string
  photo?: TelegramPhotoSize[]
  message_thread_id?: number
  is_topic_message?: boolean
}

export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  message?: TelegramMessage
  data?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

export interface TelegramForumTopic {
  message_thread_id: number
  name: string
  icon_color: number
}
