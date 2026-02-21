/**
 * Global singleton for direct Telegram Bot API calls from tool handlers.
 *
 * Initialized by TelegramPlugin.start() with the bot token and primary chat ID.
 * Used by the proposeTradeWithButtons tool to send messages with inline keyboards
 * without going through the connector registry (which only sends plain text).
 */

interface InlineButton {
  text: string
  callback_data: string
}

let botToken: string | undefined
let defaultChatId: number | undefined

/**
 * Initialize the singleton. Called by TelegramPlugin.start().
 */
export function initTelegramBotApi(token: string, chatId: number): void {
  botToken = token
  defaultChatId = chatId
}

/**
 * Send a message to Telegram, optionally with inline keyboard buttons.
 * Returns the sent message_id on success, or null on failure.
 */
export async function sendTelegramMessage(
  text: string,
  options?: {
    chatId?: number
    replyMarkup?: { inline_keyboard: InlineButton[][] }
    parseMode?: 'HTML' | 'MarkdownV2'
  },
): Promise<number | null> {
  if (!botToken || !defaultChatId) {
    console.warn('telegram-api: not initialized — call initTelegramBotApi() first')
    return null
  }

  const chatId = options?.chatId ?? defaultChatId
  const body: Record<string, unknown> = { chat_id: chatId, text }

  if (options?.parseMode) body.parse_mode = options.parseMode
  if (options?.replyMarkup) body.reply_markup = options.replyMarkup

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json() as { ok: boolean; result?: { message_id: number }; description?: string }

    if (!data.ok) {
      console.warn(`telegram-api: sendMessage failed: ${data.description}`)
      return null
    }
    return data.result?.message_id ?? null
  } catch (err) {
    console.warn('telegram-api: fetch error:', err instanceof Error ? err.message : err)
    return null
  }
}

export function getTelegramDefaultChatId(): number | undefined {
  return defaultChatId
}
