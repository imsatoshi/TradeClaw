import type { Update, User } from './types.js'
import type { OutboundMessage } from './types.js'

export interface TelegramClientOptions {
  token: string
  baseUrl?: string
  /** Injectable for testing */
  fetchFn?: typeof globalThis.fetch
}

export class TelegramApiError extends Error {
  constructor(
    public method: string,
    public statusCode: number,
    public description: string,
    public retryAfter?: number,
  ) {
    super(`Telegram API error [${method}]: ${statusCode} ${description}`)
    this.name = 'TelegramApiError'
  }
}

export class TelegramClient {
  private token: string
  private baseUrl: string
  private fetchFn: typeof globalThis.fetch

  constructor(options: TelegramClientOptions) {
    this.token = options.token
    this.baseUrl = options.baseUrl ?? 'https://api.telegram.org'
    this.fetchFn = options.fetchFn ?? globalThis.fetch
  }

  async callApi<T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const url = `${this.baseUrl}/bot${this.token}/${method}`

    let attempts = 0
    const maxAttempts = 3

    while (true) {
      attempts++
      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: params ? JSON.stringify(params) : undefined,
        signal,
      })

      const body = (await res.json()) as { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } }

      if (body.ok) {
        return body.result as T
      }

      const retryAfter = body.parameters?.retry_after
      if (res.status === 429 && retryAfter && attempts < maxAttempts) {
        await this.sleep(retryAfter * 1000, signal)
        continue
      }

      throw new TelegramApiError(method, res.status, body.description ?? 'Unknown error', retryAfter)
    }
  }

  async getMe(signal?: AbortSignal): Promise<User> {
    return this.callApi<User>('getMe', undefined, signal)
  }

  async getUpdates(offset?: number, timeout = 30, signal?: AbortSignal): Promise<Update[]> {
    return this.callApi<Update[]>('getUpdates', {
      offset,
      timeout,
      allowed_updates: ['message', 'edited_message', 'channel_post', 'callback_query'],
    }, signal)
  }

  async sendMessage(params: OutboundMessage, signal?: AbortSignal): Promise<void> {
    await this.callApi('sendMessage', {
      chat_id: params.chatId,
      text: params.text,
      parse_mode: params.parseMode,
      reply_to_message_id: params.replyToMessageId,
      reply_markup: params.replyMarkup,
    }, signal)
  }

  async editMessageText(params: OutboundMessage & { messageId: number }, signal?: AbortSignal): Promise<void> {
    await this.callApi('editMessageText', {
      chat_id: params.chatId,
      message_id: params.messageId,
      text: params.text,
      parse_mode: params.parseMode,
      reply_markup: params.replyMarkup,
    }, signal)
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string, signal?: AbortSignal): Promise<void> {
    await this.callApi('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    }, signal)
  }

  async sendPhoto(chatId: number, photo: Uint8Array, caption?: string, signal?: AbortSignal): Promise<void> {
    const url = `${this.baseUrl}/bot${this.token}/sendPhoto`

    const form = new FormData()
    form.append('chat_id', String(chatId))
    form.append('photo', new Blob([photo as unknown as BlobPart]), 'screenshot.jpg')
    if (caption) form.append('caption', caption)

    let attempts = 0
    const maxAttempts = 3

    while (true) {
      attempts++
      const res = await this.fetchFn(url, { method: 'POST', body: form, signal })
      const body = (await res.json()) as { ok: boolean; description?: string; parameters?: { retry_after?: number } }

      if (body.ok) return

      const retryAfter = body.parameters?.retry_after
      if (res.status === 429 && retryAfter && attempts < maxAttempts) {
        await this.sleep(retryAfter * 1000, signal)
        continue
      }

      throw new TelegramApiError('sendPhoto', res.status, body.description ?? 'Unknown error', retryAfter)
    }
  }

  async setMyCommands(commands: Array<{ command: string; description: string }>, signal?: AbortSignal): Promise<void> {
    await this.callApi('setMyCommands', { commands }, signal)
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(signal.reason)
      }, { once: true })
    })
  }
}
