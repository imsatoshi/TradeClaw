import type { Update, Message, Chat, User } from '@grammyjs/types'

export type { Update, Message, Chat, User }

export interface TelegramConfig {
  token: string
  /** Chat IDs allowed to interact. Empty = allow all. */
  allowedChatIds: number[]
  /** Polling timeout in seconds (Telegram long-poll parameter). Default: 30 */
  pollingTimeout: number
}

export interface ParsedMessage {
  chatId: number
  messageId: number
  from: { id: number; firstName: string; username?: string }
  date: Date
  text: string
  command?: string
  commandArgs?: string
  media: MediaRef[]
  /** media_group_id if present */
  mediaGroupId?: string
  raw: Update
}

export interface MediaRef {
  type: 'photo' | 'document' | 'animation' | 'voice' | 'sticker' | 'video' | 'video_note' | 'audio'
  fileId: string
  fileName?: string
  mimeType?: string
  width?: number
  height?: number
}

export interface InlineKeyboardButton {
  text: string
  callback_data?: string
}

export interface OutboundMessage {
  chatId: number
  text: string
  parseMode?: 'HTML' | 'MarkdownV2'
  replyToMessageId?: number
  replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] }
}

export interface ParsedCallbackQuery {
  chatId: number
  messageId: number
  callbackQueryId: string
  data: string
  from: { id: number; firstName: string; username?: string }
}
