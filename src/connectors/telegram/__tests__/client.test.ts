import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TelegramClient, TelegramApiError } from '../client.js'

function mockFetch(responses: Array<{ status: number; body: unknown }>): typeof globalThis.fetch {
  const queue = [...responses]
  return vi.fn(async () => {
    const next = queue.shift()!
    return {
      status: next.status,
      json: async () => next.body,
    } as Response
  })
}

function okResponse<T>(result: T) {
  return { status: 200, body: { ok: true, result } }
}

function errorResponse(status: number, description: string, retryAfter?: number) {
  return {
    status,
    body: {
      ok: false,
      description,
      ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {}),
    },
  }
}

describe('TelegramClient', () => {
  let fetchFn: ReturnType<typeof mockFetch>

  function createClient(responses: Parameters<typeof mockFetch>[0]) {
    fetchFn = mockFetch(responses)
    return new TelegramClient({ token: 'test-token', fetchFn })
  }

  it('calls getMe', async () => {
    const client = createClient([okResponse({ id: 123, is_bot: true, first_name: 'TestBot' })])
    const me = await client.getMe()
    expect(me.id).toBe(123)
    expect(me.is_bot).toBe(true)
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/getMe',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('calls getUpdates with offset and timeout', async () => {
    const client = createClient([okResponse([])])
    const updates = await client.getUpdates(42, 10)
    expect(updates).toEqual([])
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/getUpdates',
      expect.objectContaining({
        body: expect.stringContaining('"offset":42'),
      }),
    )
  })

  it('calls sendMessage', async () => {
    const client = createClient([okResponse({ message_id: 1 })])
    await client.sendMessage({ chatId: 67890, text: 'hello' })
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/sendMessage',
      expect.objectContaining({
        body: expect.stringContaining('"chat_id":67890'),
      }),
    )
  })

  it('calls setMyCommands', async () => {
    const client = createClient([okResponse(true)])
    await client.setMyCommands([{ command: 'status', description: 'Show status' }])
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/setMyCommands',
      expect.objectContaining({
        body: expect.stringContaining('"command":"status"'),
      }),
    )
  })

  it('throws TelegramApiError on failure', async () => {
    const client = createClient([errorResponse(400, 'Bad Request: chat not found')])
    await expect(client.sendMessage({ chatId: 99, text: 'hi' })).rejects.toThrow(TelegramApiError)
  })

  it('throws TelegramApiError with correct properties', async () => {
    const client = createClient([errorResponse(400, 'Bad Request: chat not found')])
    try {
      await client.sendMessage({ chatId: 99, text: 'hi' })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(TelegramApiError)
      const err = e as TelegramApiError
      expect(err.method).toBe('sendMessage')
      expect(err.statusCode).toBe(400)
      expect(err.description).toBe('Bad Request: chat not found')
    }
  })

  it('retries on 429 rate limit', async () => {
    vi.useFakeTimers()
    const client = createClient([
      errorResponse(429, 'Too Many Requests', 1),
      okResponse({ message_id: 1 }),
    ])

    const promise = client.sendMessage({ chatId: 67890, text: 'hello' })

    // Advance past the retry delay
    await vi.advanceTimersByTimeAsync(1000)

    await promise
    expect(fetchFn).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })

  it('gives up after max retry attempts', async () => {
    vi.useFakeTimers()
    const client = createClient([
      errorResponse(429, 'Too Many Requests', 1),
      errorResponse(429, 'Too Many Requests', 1),
      errorResponse(429, 'Too Many Requests', 1),
    ])

    const promise = client.sendMessage({ chatId: 67890, text: 'hello' })

    // Attach rejection handler before advancing timers to avoid unhandled rejection
    const assertion = expect(promise).rejects.toThrow(TelegramApiError)

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    await assertion
    expect(fetchFn).toHaveBeenCalledTimes(3)

    vi.useRealTimers()
  })

  it('uses custom baseUrl', async () => {
    fetchFn = mockFetch([okResponse({ id: 1, is_bot: true, first_name: 'Bot' })])
    const client = new TelegramClient({
      token: 'tok',
      baseUrl: 'http://localhost:8081',
      fetchFn,
    })
    await client.getMe()
    expect(fetchFn).toHaveBeenCalledWith(
      'http://localhost:8081/bottok/getMe',
      expect.anything(),
    )
  })

  it('passes AbortSignal to fetch', async () => {
    const controller = new AbortController()
    fetchFn = mockFetch([okResponse({ id: 1, is_bot: true, first_name: 'Bot' })])
    const client = new TelegramClient({ token: 'tok', fetchFn })
    await client.getMe(controller.signal)
    expect(fetchFn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    )
  })
})
