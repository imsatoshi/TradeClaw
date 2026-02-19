import type { Update, Message } from './types.js'
import type { ParsedMessage, ParsedCallbackQuery, MediaRef } from './types.js'

/**
 * Extract the "interesting" message from an Update.
 * Telegram sends different fields for different update types.
 */
function extractMessage(update: Update): Message | undefined {
  return (
    (update as any).message ??
    (update as any).edited_message ??
    (update as any).channel_post ??
    (update as any).edited_channel_post
  )
}

export function extractMedia(msg: Message): MediaRef[] {
  const media: MediaRef[] = []

  if ('photo' in msg && msg.photo) {
    // Telegram sends multiple sizes; pick the largest
    const largest = msg.photo.reduce((a, b) =>
      (a.width ?? 0) * (a.height ?? 0) >= (b.width ?? 0) * (b.height ?? 0) ? a : b,
    )
    media.push({
      type: 'photo',
      fileId: largest.file_id,
      width: largest.width,
      height: largest.height,
    })
  }

  if ('animation' in msg && msg.animation) {
    media.push({
      type: 'animation',
      fileId: msg.animation.file_id,
      fileName: msg.animation.file_name,
      mimeType: msg.animation.mime_type,
      width: msg.animation.width,
      height: msg.animation.height,
    })
  } else if ('document' in msg && msg.document) {
    // Only add document if there's no animation (Telegram sends both for GIFs)
    media.push({
      type: 'document',
      fileId: msg.document.file_id,
      fileName: msg.document.file_name,
      mimeType: msg.document.mime_type,
    })
  }

  if ('voice' in msg && msg.voice) {
    media.push({
      type: 'voice',
      fileId: msg.voice.file_id,
      mimeType: msg.voice.mime_type,
    })
  }

  if ('video' in msg && msg.video) {
    media.push({
      type: 'video',
      fileId: msg.video.file_id,
      fileName: msg.video.file_name,
      mimeType: msg.video.mime_type,
      width: msg.video.width,
      height: msg.video.height,
    })
  }

  if ('video_note' in msg && msg.video_note) {
    media.push({
      type: 'video_note',
      fileId: msg.video_note.file_id,
    })
  }

  if ('audio' in msg && msg.audio) {
    media.push({
      type: 'audio',
      fileId: msg.audio.file_id,
      fileName: msg.audio.file_name,
      mimeType: msg.audio.mime_type,
    })
  }

  if ('sticker' in msg && msg.sticker) {
    media.push({
      type: 'sticker',
      fileId: msg.sticker.file_id,
      width: msg.sticker.width,
      height: msg.sticker.height,
    })
  }

  return media
}

export function parseCommand(
  text: string,
  botUsername?: string,
): { command: string; args: string } | null {
  // Match /command or /command@botname, optionally followed by args
  const match = text.match(/^\/([a-zA-Z0-9_]+)(?:@(\S+))?(?:\s+(.*))?$/)
  if (!match) return null

  const [, command, mention, args] = match

  // If the command mentions a specific bot and it's not us, ignore
  if (mention && botUsername && mention.toLowerCase() !== botUsername.toLowerCase()) {
    return null
  }

  return { command, args: args?.trim() ?? '' }
}

export function parseCallbackQuery(update: Update): ParsedCallbackQuery | null {
  const cq = (update as any).callback_query
  if (!cq) return null

  return {
    chatId: cq.message?.chat?.id ?? cq.from.id,
    messageId: cq.message?.message_id ?? 0,
    callbackQueryId: cq.id,
    data: cq.data ?? '',
    from: {
      id: cq.from.id,
      firstName: cq.from.first_name ?? '',
      username: cq.from.username,
    },
  }
}

export function parseUpdate(update: Update, botUsername?: string): ParsedMessage | null {
  const msg = extractMessage(update)
  if (!msg) return null

  const text = ('text' in msg ? msg.text : undefined) ?? ('caption' in msg ? msg.caption : undefined) ?? ''
  const from = msg.from

  let command: string | undefined
  let commandArgs: string | undefined

  // Only parse commands from bot_command entities
  if ('entities' in msg && msg.entities) {
    const cmdEntity = msg.entities.find((e) => e.type === 'bot_command' && e.offset === 0)
    if (cmdEntity) {
      const parsed = parseCommand(text, botUsername)
      if (parsed) {
        command = parsed.command
        commandArgs = parsed.args
      }
    }
  }

  return {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    from: {
      id: from?.id ?? 0,
      firstName: from?.first_name ?? '',
      username: from?.username,
    },
    date: new Date(msg.date * 1000),
    text,
    command,
    commandArgs,
    media: extractMedia(msg),
    mediaGroupId: 'media_group_id' in msg ? (msg as any).media_group_id : undefined,
    raw: update,
  }
}
