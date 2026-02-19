import type { ParsedMessage } from './types.js'

const DEFAULT_FLUSH_MS = 500

export interface MediaGroupMergerOptions {
  flushMs?: number
  onMerged: (message: ParsedMessage) => void
  /** Injectable for testing with fake timers */
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
}

/**
 * Buffers messages that share a media_group_id and merges them into a single
 * ParsedMessage after a short timeout. Messages without a media_group_id are
 * emitted immediately.
 */
export class MediaGroupMerger {
  private groups = new Map<string, { messages: ParsedMessage[]; timer: ReturnType<typeof setTimeout> }>()
  private flushMs: number
  private onMerged: (message: ParsedMessage) => void
  private _setTimeout: typeof globalThis.setTimeout
  private _clearTimeout: typeof globalThis.clearTimeout

  constructor(options: MediaGroupMergerOptions) {
    this.flushMs = options.flushMs ?? DEFAULT_FLUSH_MS
    this.onMerged = options.onMerged
    this._setTimeout = options.setTimeout ?? globalThis.setTimeout
    this._clearTimeout = options.clearTimeout ?? globalThis.clearTimeout
  }

  push(message: ParsedMessage): void {
    if (!message.mediaGroupId) {
      this.onMerged(message)
      return
    }

    const groupId = message.mediaGroupId
    const existing = this.groups.get(groupId)

    if (existing) {
      this._clearTimeout(existing.timer)
      existing.messages.push(message)
      existing.timer = this._setTimeout(() => this.flushGroup(groupId), this.flushMs)
    } else {
      const timer = this._setTimeout(() => this.flushGroup(groupId), this.flushMs)
      this.groups.set(groupId, { messages: [message], timer })
    }
  }

  /** Flush all pending groups immediately. Call on shutdown. */
  flush(): void {
    for (const groupId of [...this.groups.keys()]) {
      this.flushGroup(groupId)
    }
  }

  get pendingCount(): number {
    return this.groups.size
  }

  private flushGroup(groupId: string): void {
    const group = this.groups.get(groupId)
    if (!group) return

    this._clearTimeout(group.timer)
    this.groups.delete(groupId)

    const messages = group.messages.sort((a, b) => a.messageId - b.messageId)
    const first = messages[0]

    // Find the message with caption text (if any)
    const captionMsg = messages.find((m) => m.text.length > 0)

    // Merge all media into a single array
    const allMedia = messages.flatMap((m) => m.media)

    const merged: ParsedMessage = {
      ...first,
      text: captionMsg?.text ?? '',
      media: allMedia,
    }

    this.onMerged(merged)
  }
}
