import { Bot, InlineKeyboard, InputFile } from 'grammy'
import { autoRetry } from '@grammyjs/auto-retry'
import { readFile } from 'node:fs/promises'
import type { Message } from 'grammy/types'
import type { Plugin, EngineContext, MediaAttachment } from '../../core/types.js'
import type { TelegramConfig, ParsedMessage } from './types.js'
import { parseUpdate, parseCallbackQuery, extractMedia, parseCommand } from './handler.js'
import { MediaGroupMerger } from './media-group.js'
import { SessionStore } from '../../core/session.js'
import { forceCompact } from '../../core/compaction.js'
import { readAIConfig, writeAIConfig, type AIProvider } from '../../core/ai-config.js'
import { registerConnector, touchInteraction } from '../../core/connector-registry.js'
import { initTelegramBotApi } from './telegram-api.js'
import { takePendingProposal } from '../../core/pending-actions.js'
import { formatForTelegram } from './format.js'

const MAX_MESSAGE_LENGTH = 4096

const PROVIDER_LABELS: Record<AIProvider, string> = {
  'claude-code': 'Claude Code',
  'vercel-ai-sdk': 'Vercel AI SDK',
}

export class TelegramPlugin implements Plugin {
  name = 'telegram'
  private config: TelegramConfig
  private bot: Bot | null = null
  private merger: MediaGroupMerger | null = null
  private unregisterConnector?: () => void

  /** Per-user unified session stores (keyed by userId). */
  private sessions = new Map<number, SessionStore>()

  /** Throttle: last time we sent an auth-guidance reply per chatId. */
  private authReplyThrottle = new Map<number, number>()

  /** Reference to engine. */
  private engineRef: import('../../core/engine.js').Engine | null = null

  constructor(
    config: Omit<TelegramConfig, 'pollingTimeout'> & { pollingTimeout?: number },
  ) {
    this.config = { pollingTimeout: 30, ...config }
  }

  async start(ctx: EngineContext) {
    this.engineRef = ctx.engine

    const bot = new Bot(this.config.token)

    // Auto-retry on 429 rate limits
    bot.api.config.use(autoRetry())

    // Error handler
    bot.catch((err) => {
      console.error('telegram bot error:', err)
    })

    // ── Middleware: auth guard ──
    bot.use(async (grammyCtx, next) => {
      const chatId = grammyCtx.chat?.id
      if (!chatId) return
      if (this.config.allowedChatIds.length === 0 || this.config.allowedChatIds.includes(chatId)) return next()

      const now = Date.now()
      const last = this.authReplyThrottle.get(chatId) ?? 0
      if (now - last > 60_000) {
        this.authReplyThrottle.set(chatId, now)
        console.log(`telegram: unauthorized chat ${chatId}, set TELEGRAM_CHAT_ID=${chatId} to allow`)
        await grammyCtx.reply('This chat is not authorized. Add this chat ID to TELEGRAM_CHAT_ID in your environment config.').catch(() => {})
      }
    })

    // ── Commands ──
    bot.command('status', async (grammyCtx) => {
      const aiConfig = await readAIConfig()
      await grammyCtx.reply(`Engine is running. Provider: ${PROVIDER_LABELS[aiConfig.provider]}`)
    })

    bot.command('settings', async (grammyCtx) => {
      await this.sendSettingsMenu(grammyCtx.chat.id)
    })

    bot.command('compact', async (grammyCtx) => {
      const userId = grammyCtx.from?.id
      if (!userId) return
      await this.handleCompactCommand(grammyCtx.chat.id, userId)
    })

    // ── Callback queries (inline keyboard presses) ──
    bot.on('callback_query:data', async (grammyCtx) => {
      const data = grammyCtx.callbackQuery.data
      const chatId = grammyCtx.chat?.id ?? grammyCtx.from.id
      const userId = grammyCtx.from.id
      try {
        // Provider switch
        if (data.startsWith('provider:')) {
          const provider = data.slice('provider:'.length) as AIProvider
          await writeAIConfig(provider)
          await grammyCtx.answerCallbackQuery({ text: `Switched to ${PROVIDER_LABELS[provider]}` })

          const ccLabel = provider === 'claude-code' ? '> Claude Code' : 'Claude Code'
          const aiLabel = provider === 'vercel-ai-sdk' ? '> Vercel AI SDK' : 'Vercel AI SDK'
          const keyboard = new InlineKeyboard()
            .text(ccLabel, 'provider:claude-code')
            .text(aiLabel, 'provider:vercel-ai-sdk')
          await grammyCtx.editMessageText(
            `Current provider: ${PROVIDER_LABELS[provider]}\n\nChoose default AI provider:`,
            { reply_markup: keyboard },
          )
          return
        }

        // Trade proposal: confirm
        if (data.startsWith('trade:confirm:')) {
          const proposalId = data.slice('trade:confirm:'.length)
          const proposal = takePendingProposal(proposalId)

          if (!proposal) {
            await grammyCtx.answerCallbackQuery({ text: '⏰ Proposal expired or already handled' })
            await grammyCtx.editMessageText('⏰ Trade proposal expired.')
            return
          }

          await grammyCtx.answerCallbackQuery({ text: '✅ Confirmed — executing trade...' })
          await grammyCtx.editMessageText(`${proposal.summary}\n\n⏳ Executing...`)

          try {
            const session = await this.getSession(userId)
            const result = await ctx.engine.askWithSession(proposal.confirmationPrompt, session, { maxHistoryEntries: 20, dataTTL: 2 * 60 * 1000 })
            await this.sendReplyToChat(chatId, result.text, result.media)
          } catch (err) {
            await bot.api.sendMessage(chatId, `❌ Trade execution failed: ${err instanceof Error ? err.message : String(err)}`)
          }
          return
        }

        // Trade proposal: cancel
        if (data.startsWith('trade:cancel:')) {
          const proposalId = data.slice('trade:cancel:'.length)
          takePendingProposal(proposalId)
          await grammyCtx.answerCallbackQuery({ text: '❌ Trade cancelled' })
          await grammyCtx.editMessageText('❌ Trade proposal cancelled by user.')
          return
        }

        await grammyCtx.answerCallbackQuery()
      } catch (err) {
        console.error('telegram callback query error:', err)
      }
    })

    // ── Set up media group merger ──
    this.merger = new MediaGroupMerger({
      onMerged: (message) => this.handleMessage(ctx, message),
    })

    // ── Messages (text, media, edited, channel posts) ──
    const buildParsed = (msg: Message): ParsedMessage => {
      const text = msg.text ?? msg.caption ?? ''
      const from = msg.from
      let command: string | undefined
      let commandArgs: string | undefined
      if (msg.entities) {
        const cmdEntity = msg.entities.find((e) => e.type === 'bot_command' && e.offset === 0)
        if (cmdEntity) {
          const parsed = parseCommand(text, bot.botInfo.username)
          if (parsed) { command = parsed.command; commandArgs = parsed.args }
        }
      }
      return {
        chatId: msg.chat.id,
        messageId: msg.message_id,
        from: { id: from?.id ?? 0, firstName: from?.first_name ?? '', username: from?.username },
        date: new Date(msg.date * 1000),
        text,
        command,
        commandArgs,
        media: extractMedia(msg),
        mediaGroupId: (msg as any).media_group_id,
        raw: msg,
      }
    }

    const messageHandler = (msg: Message) => {
      const parsed = buildParsed(msg)
      console.log(`telegram: [${parsed.chatId}] ${parsed.from.firstName}: ${parsed.text?.slice(0, 80) || '(media)'}`)
      // Skip command messages — handled by grammY command handlers
      if (parsed.command) return
      this.merger!.push(parsed)
    }

    bot.on('message', (grammyCtx) => messageHandler(grammyCtx.message))
    bot.on('edited_message', (grammyCtx) => messageHandler(grammyCtx.editedMessage))
    bot.on('channel_post', (grammyCtx) => messageHandler(grammyCtx.channelPost))

    // ── Register commands with Telegram ──
    await bot.api.setMyCommands([
      { command: 'status', description: 'Show engine status' },
      { command: 'settings', description: 'Choose default AI provider' },
      { command: 'compact', description: 'Force compact session context' },
    ])

    // ── Initialize and get bot info ──
    await bot.init()
    const aiConfig = await readAIConfig()
    console.log(`telegram plugin: connected as @${bot.botInfo.username} (provider: ${aiConfig.provider})`)

    // Initialize the direct Telegram API singleton (used by proposeTradeWithButtons tool)
    if (this.config.allowedChatIds.length > 0) {
      initTelegramBotApi(this.config.token, this.config.allowedChatIds[0])
    }

    // ── Register connector for outbound delivery (heartbeat / cron responses) ──
    if (this.config.allowedChatIds.length > 0) {
      const deliveryChatId = this.config.allowedChatIds[0]
      this.unregisterConnector = registerConnector({
        channel: 'telegram',
        to: String(deliveryChatId),
        deliver: async (text: string) => {
          const formatted = formatForTelegram(text)
          const chunks = splitMessage(formatted, MAX_MESSAGE_LENGTH)
          for (const chunk of chunks) {
            await bot.api.sendMessage(deliveryChatId, chunk, { parse_mode: 'HTML' })
          }
        },
      })
    }

    // ── Start polling ──
    this.bot = bot
    bot.start({
      allowed_updates: ['message', 'edited_message', 'channel_post', 'callback_query'],
      onStart: () => console.log('telegram: polling started'),
    }).catch((err) => {
      console.error('telegram polling fatal error:', err)
    })
  }

  async stop() {
    this.merger?.flush()
    await this.bot?.stop()
    this.unregisterConnector?.()
  }

  private async getSession(userId: number): Promise<SessionStore> {
    let session = this.sessions.get(userId)
    if (!session) {
      session = new SessionStore(`telegram/${userId}`)
      await session.restore()
      this.sessions.set(userId, session)
      console.log(`telegram: session telegram/${userId} ready`)
    }
    return session
  }

  /**
   * Sends "typing..." chat action and refreshes it every 4 seconds.
   * Returns a function to stop the indicator.
   */
  private startTypingIndicator(chatId: number): () => void {
    const send = () => {
      this.bot?.api.sendChatAction(chatId, 'typing').catch(() => {})
    }
    send()
    const interval = setInterval(send, 4000)
    return () => clearInterval(interval)
  }

  private async handleMessage(ctx: EngineContext, message: ParsedMessage) {
    try {
      touchInteraction('telegram', String(message.chatId))

      const prompt = this.buildPrompt(message)
      if (!prompt) return

      // Send "..." placeholder + typing indicator
      const placeholder = await this.bot!.api.sendMessage(message.chatId, '...').catch(() => null)
      const stopTyping = this.startTypingIndicator(message.chatId)

      try {
        // Unified routing — always through engine.askWithSession()
        const session = await this.getSession(message.from.id)
        const result = await ctx.engine.askWithSession(prompt, session, {
          maxHistoryEntries: 20,
          dataTTL: 2 * 60 * 1000,
          historyPreamble: 'The following is the recent conversation from this Telegram chat. Use it as context if the user references earlier messages.',
        })
        stopTyping()
        await this.sendReplyWithPlaceholder(message.chatId, result.text, result.media, placeholder?.message_id)
      } catch (err) {
        stopTyping()
        // Edit placeholder to show error instead of leaving "..."
        if (placeholder) {
          await this.bot!.api.editMessageText(
            message.chatId, placeholder.message_id,
            'Sorry, something went wrong processing your message.',
          ).catch(() => {})
        }
        throw err
      }
    } catch (err) {
      console.error('telegram message handling error:', err)
    }
  }

  private async handleCompactCommand(chatId: number, userId: number) {
    const session = await this.getSession(userId)
    await this.bot!.api.sendMessage(chatId, '> Compacting session...')

    const result = await forceCompact(
      session,
      async (summarizePrompt) => {
        const r = await this.engineRef!.ask(summarizePrompt)
        return r.text
      },
    )

    if (!result) {
      await this.bot!.api.sendMessage(chatId, 'Session is empty, nothing to compact.')
    } else {
      await this.bot!.api.sendMessage(chatId, `Compacted. Pre-compaction: ~${result.preTokens} tokens.`)
    }
  }

  private async sendSettingsMenu(chatId: number) {
    const aiConfig = await readAIConfig()
    const ccLabel = aiConfig.provider === 'claude-code' ? '> Claude Code' : 'Claude Code'
    const aiLabel = aiConfig.provider === 'vercel-ai-sdk' ? '> Vercel AI SDK' : 'Vercel AI SDK'

    const keyboard = new InlineKeyboard()
      .text(ccLabel, 'provider:claude-code')
      .text(aiLabel, 'provider:vercel-ai-sdk')

    await this.bot!.api.sendMessage(
      chatId,
      `Current provider: ${PROVIDER_LABELS[aiConfig.provider]}\n\nChoose default AI provider:`,
      { reply_markup: keyboard },
    )
  }

  private buildPrompt(message: ParsedMessage): string | null {
    const parts: string[] = []

    if (message.from.firstName) {
      parts.push(`[From: ${message.from.firstName}${message.from.username ? ` (@${message.from.username})` : ''}]`)
    }

    if (message.text) {
      parts.push(message.text)
    }

    if (message.media.length > 0) {
      const mediaDesc = message.media
        .map((m) => {
          const details: string[] = [m.type]
          if (m.fileName) details.push(m.fileName)
          if (m.mimeType) details.push(m.mimeType)
          return `[${details.join(': ')}]`
        })
        .join(' ')
      parts.push(mediaDesc)
    }

    const prompt = parts.join('\n')
    return prompt || null
  }

  /**
   * Send a reply, optionally editing a placeholder "..." message into the first text chunk.
   */
  private async sendReplyWithPlaceholder(chatId: number, text: string, media?: MediaAttachment[], placeholderMsgId?: number) {
    console.log(`telegram: sendReply chatId=${chatId} textLen=${text.length} media=${media?.length ?? 0}`)

    // Send images first
    if (media && media.length > 0) {
      for (let i = 0; i < media.length; i++) {
        try {
          const buf = await readFile(media[i].path)
          await this.bot!.api.sendPhoto(chatId, new InputFile(buf, 'screenshot.jpg'))
        } catch (err) {
          console.error(`telegram: failed to send photo ${i + 1}:`, err)
        }
      }
    }

    // Send text — edit placeholder for first chunk, send the rest as new messages
    if (text) {
      const formatted = formatForTelegram(text)
      const chunks = splitMessage(formatted, MAX_MESSAGE_LENGTH)
      let startIdx = 0

      if (placeholderMsgId && chunks.length > 0) {
        const edited = await this.bot!.api.editMessageText(chatId, placeholderMsgId, chunks[0], { parse_mode: 'HTML' }).then(() => true).catch(() => false)
        if (edited) startIdx = 1
      }

      for (let i = startIdx; i < chunks.length; i++) {
        await this.bot!.api.sendMessage(chatId, chunks[i], { parse_mode: 'HTML' })
      }

      if (startIdx > 0) return
    }

    // No text or edit failed — clean up placeholder
    if (placeholderMsgId) {
      await this.bot!.api.deleteMessage(chatId, placeholderMsgId).catch(() => {})
    }
  }

  /** Simple send without placeholder (used by connector delivery). */
  private async sendReplyToChat(chatId: number, text: string, media?: MediaAttachment[]) {
    await this.sendReplyWithPlaceholder(chatId, text, media)
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }

    let splitAt = remaining.lastIndexOf('\n', maxLength)
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = remaining.lastIndexOf(' ', maxLength)
    }
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = maxLength
    }

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}
