import { describe, it, expect, beforeEach } from 'vitest'
import { parseUpdate, parseCommand, extractMedia } from '../handler.js'
import {
  resetCounters,
  textUpdate,
  commandUpdate,
  photoUpdate,
  documentUpdate,
  animationUpdate,
  voiceUpdate,
  stickerUpdate,
  mediaGroupPhotoUpdate,
  editedMessageUpdate,
  channelPostUpdate,
  groupMessageUpdate,
  callbackQueryUpdate,
} from './fixtures.js'

beforeEach(() => {
  resetCounters()
})

// ── parseCommand ──────────────────────────────────────────────

describe('parseCommand', () => {
  it('parses a simple command', () => {
    expect(parseCommand('/start')).toEqual({ command: 'start', args: '' })
  })

  it('parses command with args', () => {
    expect(parseCommand('/status detailed')).toEqual({ command: 'status', args: 'detailed' })
  })

  it('parses command with multi-word args', () => {
    expect(parseCommand('/ask what is the price of BTC')).toEqual({
      command: 'ask',
      args: 'what is the price of BTC',
    })
  })

  it('parses command with bot mention', () => {
    expect(parseCommand('/start@mybot', 'mybot')).toEqual({ command: 'start', args: '' })
  })

  it('ignores command for a different bot', () => {
    expect(parseCommand('/start@otherbot', 'mybot')).toBeNull()
  })

  it('is case-insensitive for bot mention', () => {
    expect(parseCommand('/start@MyBot', 'mybot')).toEqual({ command: 'start', args: '' })
  })

  it('returns null for non-command text', () => {
    expect(parseCommand('hello world')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseCommand('')).toBeNull()
  })
})

// ── extractMedia ──────────────────────────────────────────────

describe('extractMedia', () => {
  it('picks the largest photo', () => {
    const update = photoUpdate()
    const msg = update.message!
    const media = extractMedia(msg)
    expect(media).toHaveLength(1)
    expect(media[0]).toEqual({
      type: 'photo',
      fileId: 'large_id',
      width: 800,
      height: 600,
    })
  })

  it('extracts document', () => {
    const update = documentUpdate('report.pdf')
    const msg = update.message!
    const media = extractMedia(msg)
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({
      type: 'document',
      fileId: 'doc_id',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
    })
  })

  it('extracts animation (not document) from GIF messages', () => {
    const update = animationUpdate()
    const msg = update.message!
    const media = extractMedia(msg)
    // Should have animation only, not the duplicate document
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({
      type: 'animation',
      fileId: 'anim_id',
    })
  })

  it('extracts voice', () => {
    const update = voiceUpdate(10)
    const msg = update.message!
    const media = extractMedia(msg)
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({
      type: 'voice',
      fileId: 'voice_id',
    })
  })

  it('extracts sticker', () => {
    const update = stickerUpdate('🎉')
    const msg = update.message!
    const media = extractMedia(msg)
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({
      type: 'sticker',
      fileId: 'sticker_id',
      width: 512,
      height: 512,
    })
  })

  it('returns empty array for plain text', () => {
    const update = textUpdate('hello')
    const msg = update.message!
    const media = extractMedia(msg)
    expect(media).toEqual([])
  })
})

// ── parseUpdate ───────────────────────────────────────────────

describe('parseUpdate', () => {
  it('parses a text message', () => {
    const parsed = parseUpdate(textUpdate('hello'))
    expect(parsed).not.toBeNull()
    expect(parsed!.chatId).toBe(67890)
    expect(parsed!.text).toBe('hello')
    expect(parsed!.from.id).toBe(12345)
    expect(parsed!.from.firstName).toBe('Alice')
    expect(parsed!.command).toBeUndefined()
    expect(parsed!.media).toEqual([])
  })

  it('parses a command', () => {
    const parsed = parseUpdate(commandUpdate('status', 'detailed'))
    expect(parsed).not.toBeNull()
    expect(parsed!.command).toBe('status')
    expect(parsed!.commandArgs).toBe('detailed')
    expect(parsed!.text).toBe('/status detailed')
  })

  it('parses a command with no args', () => {
    const parsed = parseUpdate(commandUpdate('start'))
    expect(parsed!.command).toBe('start')
    expect(parsed!.commandArgs).toBe('')
  })

  it('parses command with bot mention', () => {
    const parsed = parseUpdate(commandUpdate('start', '', 'mybot'), 'mybot')
    expect(parsed!.command).toBe('start')
  })

  it('ignores command for different bot', () => {
    const parsed = parseUpdate(commandUpdate('start', '', 'otherbot'), 'mybot')
    expect(parsed!.command).toBeUndefined()
  })

  it('parses photo with caption', () => {
    const parsed = parseUpdate(photoUpdate('nice pic'))
    expect(parsed!.text).toBe('nice pic')
    expect(parsed!.media).toHaveLength(1)
    expect(parsed!.media[0].type).toBe('photo')
  })

  it('parses photo without caption', () => {
    const parsed = parseUpdate(photoUpdate())
    expect(parsed!.text).toBe('')
    expect(parsed!.media).toHaveLength(1)
  })

  it('parses document', () => {
    const parsed = parseUpdate(documentUpdate('data.csv', 'here is the data'))
    expect(parsed!.text).toBe('here is the data')
    expect(parsed!.media).toHaveLength(1)
    expect(parsed!.media[0].type).toBe('document')
    expect(parsed!.media[0].fileName).toBe('data.csv')
  })

  it('parses animation', () => {
    const parsed = parseUpdate(animationUpdate('funny'))
    expect(parsed!.text).toBe('funny')
    expect(parsed!.media).toHaveLength(1)
    expect(parsed!.media[0].type).toBe('animation')
  })

  it('parses voice', () => {
    const parsed = parseUpdate(voiceUpdate())
    expect(parsed!.text).toBe('')
    expect(parsed!.media).toHaveLength(1)
    expect(parsed!.media[0].type).toBe('voice')
  })

  it('parses sticker', () => {
    const parsed = parseUpdate(stickerUpdate('😀'))
    expect(parsed!.text).toBe('')
    expect(parsed!.media).toHaveLength(1)
    expect(parsed!.media[0].type).toBe('sticker')
  })

  it('parses edited message', () => {
    const parsed = parseUpdate(editedMessageUpdate('corrected text'))
    expect(parsed).not.toBeNull()
    expect(parsed!.text).toBe('corrected text')
  })

  it('parses channel post', () => {
    const parsed = parseUpdate(channelPostUpdate('announcement'))
    expect(parsed).not.toBeNull()
    expect(parsed!.text).toBe('announcement')
    expect(parsed!.chatId).toBe(-1001234567890)
  })

  it('parses group message', () => {
    const parsed = parseUpdate(groupMessageUpdate('group chat', -100999))
    expect(parsed!.chatId).toBe(-100999)
    expect(parsed!.text).toBe('group chat')
  })

  it('includes message_thread_id as part of raw', () => {
    const parsed = parseUpdate(groupMessageUpdate('threaded', -100999, 42))
    expect(parsed).not.toBeNull()
    expect(parsed!.text).toBe('threaded')
  })

  it('returns null for callback_query (no message field)', () => {
    const parsed = parseUpdate(callbackQueryUpdate('action_1'))
    // callback_query without message → extractMessage returns undefined
    expect(parsed).toBeNull()
  })

  it('preserves mediaGroupId', () => {
    const parsed = parseUpdate(mediaGroupPhotoUpdate('album_1', 'first'))
    expect(parsed!.mediaGroupId).toBe('album_1')
  })

  it('date is a proper Date object', () => {
    const parsed = parseUpdate(textUpdate('hi'))
    expect(parsed!.date).toBeInstanceOf(Date)
    expect(parsed!.date.getTime()).toBe(1700000000 * 1000)
  })

  it('increments message IDs across calls', () => {
    const p1 = parseUpdate(textUpdate('a'))
    const p2 = parseUpdate(textUpdate('b'))
    expect(p2!.messageId).toBe(p1!.messageId + 1)
  })
})
