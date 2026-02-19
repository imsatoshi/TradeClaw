import type { Update, Message, User, Chat } from '@grammyjs/types'

let nextUpdateId = 1
let nextMessageId = 1

export function resetCounters() {
  nextUpdateId = 1
  nextMessageId = 1
}

export function user(overrides?: Partial<User>): User {
  return { id: 12345, is_bot: false, first_name: 'Alice', ...overrides }
}

export function chat(overrides?: Partial<Chat>): Chat {
  return { id: 67890, type: 'private', first_name: 'Alice', ...overrides } as Chat
}

function baseMessage(overrides?: Partial<Message>): Message {
  return {
    message_id: nextMessageId++,
    date: 1700000000,
    chat: chat(),
    from: user(),
    ...overrides,
  } as Message
}

export function textUpdate(text: string, overrides?: Partial<Message>): Update {
  return {
    update_id: nextUpdateId++,
    message: baseMessage({ text, ...overrides }),
  } as Update
}

export function commandUpdate(command: string, args = '', botUsername?: string): Update {
  const mention = botUsername ? `@${botUsername}` : ''
  const text = args ? `/${command}${mention} ${args}` : `/${command}${mention}`
  return {
    update_id: nextUpdateId++,
    message: baseMessage({
      text,
      entities: [{ type: 'bot_command', offset: 0, length: `/${command}${mention}`.length }],
    }),
  } as Update
}

export function photoUpdate(caption?: string, overrides?: Partial<Message>): Update {
  return {
    update_id: nextUpdateId++,
    message: baseMessage({
      photo: [
        { file_id: 'small_id', file_unique_id: 'small_u', width: 90, height: 90 },
        { file_id: 'medium_id', file_unique_id: 'med_u', width: 320, height: 320 },
        { file_id: 'large_id', file_unique_id: 'large_u', width: 800, height: 600 },
      ],
      ...(caption ? { caption } : {}),
      ...overrides,
    }),
  } as Update
}

export function documentUpdate(fileName: string, caption?: string): Update {
  return {
    update_id: nextUpdateId++,
    message: baseMessage({
      document: {
        file_id: 'doc_id',
        file_unique_id: 'doc_u',
        file_name: fileName,
        mime_type: 'application/pdf',
      },
      ...(caption ? { caption } : {}),
    }),
  } as Update
}

export function animationUpdate(caption?: string): Update {
  return {
    update_id: nextUpdateId++,
    message: baseMessage({
      animation: {
        file_id: 'anim_id',
        file_unique_id: 'anim_u',
        width: 320,
        height: 240,
        duration: 3,
      },
      // Telegram also sends a document field for animations; include for realism
      document: {
        file_id: 'anim_id',
        file_unique_id: 'anim_u',
        file_name: 'animation.mp4',
        mime_type: 'video/mp4',
      },
      ...(caption ? { caption } : {}),
    }),
  } as Update
}

export function voiceUpdate(duration = 5): Update {
  return {
    update_id: nextUpdateId++,
    message: baseMessage({
      voice: {
        file_id: 'voice_id',
        file_unique_id: 'voice_u',
        duration,
      },
    }),
  } as Update
}

export function stickerUpdate(emoji = '😀'): Update {
  return {
    update_id: nextUpdateId++,
    message: baseMessage({
      sticker: {
        file_id: 'sticker_id',
        file_unique_id: 'sticker_u',
        type: 'regular',
        width: 512,
        height: 512,
        is_animated: false,
        is_video: false,
        emoji,
      },
    }),
  } as Update
}

export function mediaGroupPhotoUpdate(groupId: string, caption?: string): Update {
  return {
    update_id: nextUpdateId++,
    message: baseMessage({
      media_group_id: groupId,
      photo: [
        { file_id: `photo_${nextMessageId}_sm`, file_unique_id: `pu_${nextMessageId}_sm`, width: 90, height: 90 },
        { file_id: `photo_${nextMessageId}_lg`, file_unique_id: `pu_${nextMessageId}_lg`, width: 800, height: 600 },
      ],
      ...(caption ? { caption } : {}),
    }),
  } as Update
}

export function editedMessageUpdate(text: string): Update {
  return {
    update_id: nextUpdateId++,
    edited_message: baseMessage({ text, edit_date: 1700000100 }),
  } as Update
}

export function channelPostUpdate(text: string): Update {
  return {
    update_id: nextUpdateId++,
    channel_post: baseMessage({
      text,
      chat: chat({ id: -1001234567890, type: 'channel', title: 'Test Channel' }),
    }),
  } as Update
}

export function groupMessageUpdate(text: string, chatId = -100999, threadId?: number): Update {
  return {
    update_id: nextUpdateId++,
    message: baseMessage({
      text,
      chat: chat({ id: chatId, type: 'supergroup', title: 'Test Group' }),
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
    }),
  } as Update
}

export function callbackQueryUpdate(data: string, messageText?: string): Update {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: 'cb_123',
      from: user(),
      chat_instance: 'instance_1',
      data,
      ...(messageText
        ? { message: baseMessage({ text: messageText }) }
        : {}),
    },
  } as Update
}
