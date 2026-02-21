import type { Plugin, EngineContext, MediaAttachment } from '../../core/types.js'
import type { TelegramConfig, ParsedMessage } from './types.js'
import { TelegramClient } from './client.js'
import { runPollingLoop } from './polling.js'
import { parseUpdate, parseCallbackQuery } from './handler.js'
import { MediaGroupMerger } from './media-group.js'
import { askClaudeCode, askClaudeCodeWithSession } from '../../providers/claude-code/index.js'
import type { ClaudeCodeConfig } from '../../providers/claude-code/index.js'
import { SessionStore } from '../../core/session.js'
import { forceCompact, type CompactionConfig } from '../../core/compaction.js'
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
  private claudeCodeConfig: ClaudeCodeConfig
  private abortController: AbortController | null = null
  private pollingPromise: Promise<void> | null = null
  private merger: MediaGroupMerger | null = null
  private botUsername?: string
  private unregisterConnector?: () => void

  /** Cached AI provider setting. */
  private currentProvider: AIProvider = 'vercel-ai-sdk'

  /** Compaction config from engine config. */
  private compactionConfig!: CompactionConfig

  /** Reference to engine for compact and other operations. */
  private engineRef: import('../../core/engine.js').Engine | null = null

  /** Per-user generation lock — prevents concurrent AI calls for the same user. */
  private userLocks = new Map<number, Promise<void>>()

  /** Per-user unified session stores (keyed by userId). */
  private sessions = new Map<number, SessionStore>()

  constructor(
    config: Omit<TelegramConfig, 'pollingTimeout'> & { pollingTimeout?: number },
    claudeCodeConfig: ClaudeCodeConfig = {},
  ) {
    this.config = { pollingTimeout: 30, ...config }
    this.claudeCodeConfig = claudeCodeConfig
  }

  async start(ctx: EngineContext) {
    // Load persisted settings
    const aiConfig = await readAIConfig()
    this.currentProvider = aiConfig.provider
    this.compactionConfig = ctx.config.compaction
    this.engineRef = ctx.engine

    // Inject agent config into Claude Code config (constructor overrides take precedence)
    this.claudeCodeConfig = {
      allowedTools: ctx.config.agent.claudeCode.allowedTools,
      disallowedTools: ctx.config.agent.claudeCode.disallowedTools,
      maxTurns: ctx.config.agent.claudeCode.maxTurns,
      ...this.claudeCodeConfig,
    }
    const client = new TelegramClient({ token: this.config.token })

    // Verify token and get bot username
    const me = await client.getMe()
    this.botUsername = me.username
    console.log(`telegram plugin: connected as @${me.username} (provider: ${this.currentProvider})`)

    // Initialize the direct Telegram API singleton (used by proposeTradeWithButtons tool)
    if (this.config.allowedChatIds.length > 0) {
      initTelegramBotApi(this.config.token, this.config.allowedChatIds[0])
    }

    // Register connector for outbound delivery (heartbeat / cron responses)
    if (this.config.allowedChatIds.length > 0) {
      const deliveryChatId = this.config.allowedChatIds[0]
      this.unregisterConnector = registerConnector({
        channel: 'telegram',
        to: String(deliveryChatId),
        deliver: async (text: string) => {
          const formatted = formatForTelegram(text)
          const chunks = splitMessage(formatted, MAX_MESSAGE_LENGTH)
          for (const chunk of chunks) {
            await client.sendMessage({ chatId: deliveryChatId, text: chunk, parseMode: 'HTML' })
          }
        },
      })
    }

    // Register commands
    await client.setMyCommands([
      { command: 'status', description: 'Show engine status' },
      { command: 'settings', description: 'Choose default AI provider' },
      { command: 'compact', description: 'Force compact session context' },
    ])

    // Set up media group merger
    this.merger = new MediaGroupMerger({
      onMerged: (message) => this.handleMessage(ctx, client, message),
    })

    // Start polling
    this.abortController = new AbortController()
    this.pollingPromise = runPollingLoop({
      client,
      timeout: this.config.pollingTimeout,
      signal: this.abortController.signal,
      onUpdates: (updates) => {
        console.log(`telegram: received ${updates.length} update(s)`)
        for (const update of updates) {
          // Handle callback queries (inline keyboard presses)
          const cq = parseCallbackQuery(update)
          if (cq) {
            if (this.config.allowedChatIds.length > 0 && !this.config.allowedChatIds.includes(cq.chatId)) continue
            this.handleCallbackQuery(ctx, client, cq.chatId, cq.messageId, cq.callbackQueryId, cq.data, cq.from.id)
            continue
          }

          const parsed = parseUpdate(update, this.botUsername)
          if (!parsed) {
            console.log('telegram: skipped unparseable update', update.update_id)
            continue
          }

          console.log(`telegram: [${parsed.chatId}] ${parsed.from.firstName}: ${parsed.text?.slice(0, 80) || '(media)'}`)

          // Filter by allowed chat IDs
          if (this.config.allowedChatIds.length > 0 && !this.config.allowedChatIds.includes(parsed.chatId)) {
            console.log(`telegram: chat ${parsed.chatId} not in allowedChatIds, skipping`)
            continue
          }

          this.merger!.push(parsed)
        }
      },
      onError: (err) => {
        console.error('telegram polling error:', err)
      },
    })
  }

  async stop() {
    this.merger?.flush()
    this.abortController?.abort()
    await this.pollingPromise
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

  private async handleCallbackQuery(
    ctx: EngineContext,
    client: TelegramClient,
    chatId: number,
    messageId: number,
    callbackQueryId: string,
    data: string,
    userId: number,
  ) {
    try {
      // ── Provider switch ──────────────────────────────────────────────────────
      if (data.startsWith('provider:')) {
        const provider = data.slice('provider:'.length) as AIProvider
        this.currentProvider = provider
        await writeAIConfig(provider)
        await client.answerCallbackQuery(callbackQueryId, `Switched to ${PROVIDER_LABELS[provider]}`)

        const ccLabel = provider === 'claude-code' ? '> Claude Code' : 'Claude Code'
        const aiLabel = provider === 'vercel-ai-sdk' ? '> Vercel AI SDK' : 'Vercel AI SDK'
        await client.editMessageText({
          chatId,
          messageId,
          text: `Current provider: ${PROVIDER_LABELS[provider]}\n\nChoose default AI provider:`,
          replyMarkup: {
            inline_keyboard: [
              [{ text: ccLabel, callback_data: 'provider:claude-code' }],
              [{ text: aiLabel, callback_data: 'provider:vercel-ai-sdk' }],
            ],
          },
        })
        return
      }

      // ── Trade proposal: confirm ──────────────────────────────────────────────
      if (data.startsWith('trade:confirm:')) {
        const proposalId = data.slice('trade:confirm:'.length)
        const proposal = takePendingProposal(proposalId)

        if (!proposal) {
          await client.answerCallbackQuery(callbackQueryId, '⏰ Proposal expired or already handled')
          await client.editMessageText({ chatId, messageId, text: '⏰ Trade proposal expired.' })
          return
        }

        await client.answerCallbackQuery(callbackQueryId, '✅ Confirmed — executing trade...')
        await client.editMessageText({ chatId, messageId, text: `${proposal.summary}\n\n⏳ Executing...` })

        // Re-enter AI flow to execute the confirmed trade
        try {
          const session = await this.getSession(userId)
          const result = await ctx.engine.askWithSession(proposal.confirmationPrompt, session, { maxHistoryEntries: 20, dataTTL: 2 * 60 * 1000 })
          await this.sendReply(client, chatId, result.text, result.media)
        } catch (err) {
          await client.sendMessage({ chatId, text: `❌ Trade execution failed: ${err instanceof Error ? err.message : String(err)}` })
        }
        return
      }

      // ── Trade proposal: cancel ───────────────────────────────────────────────
      if (data.startsWith('trade:cancel:')) {
        const proposalId = data.slice('trade:cancel:'.length)
        takePendingProposal(proposalId)  // discard
        await client.answerCallbackQuery(callbackQueryId, '❌ Trade cancelled')
        await client.editMessageText({ chatId, messageId, text: '❌ Trade proposal cancelled by user.' })
        return
      }

      // ── Unknown callback ─────────────────────────────────────────────────────
      await client.answerCallbackQuery(callbackQueryId)
    } catch (err) {
      console.error('telegram callback query error:', err)
    }
  }

  private async handleMessage(ctx: EngineContext, client: TelegramClient, message: ParsedMessage) {
    // Handle built-in commands without lock (lightweight operations)
    if (message.command) {
      try {
        touchInteraction('telegram', String(message.chatId))
        await this.handleCommand(client, message)
      } catch (err) {
        console.error('telegram command error:', err)
      }
      return
    }

    // Per-user lock: serialize AI generation for the same user
    const userId = message.from.id
    const prev = this.userLocks.get(userId) ?? Promise.resolve()
    let releaseLock!: () => void
    const lockPromise = new Promise<void>((r) => { releaseLock = r })
    this.userLocks.set(userId, lockPromise)

    await prev

    try {
      touchInteraction('telegram', String(message.chatId))

      const prompt = this.buildPrompt(message)
      if (!prompt) return

      if (this.currentProvider === 'claude-code') {
        await this.handleClaudeCodeMessage(client, message, prompt)
      } else {
        const session = await this.getSession(userId)
        const result = await ctx.engine.askWithSession(prompt, session, { maxHistoryEntries: 20, dataTTL: 2 * 60 * 1000 })
        await this.sendReply(client, message.chatId, result.text, result.media)
      }
    } catch (err) {
      console.error('telegram message handling error:', err)
      try {
        await this.sendReply(client, message.chatId, 'Sorry, something went wrong processing your message.')
      } catch (replyErr) {
        console.error('telegram: failed to send error reply:', replyErr)
      }
    } finally {
      releaseLock()
    }
  }

  private async handleCommand(client: TelegramClient, message: ParsedMessage) {
    switch (message.command) {
      case 'status':
        await this.sendReply(client, message.chatId, `Engine is running. Provider: ${PROVIDER_LABELS[this.currentProvider]}`)
        return
      case 'settings':
        await this.sendSettingsMenu(client, message.chatId)
        return
      case 'compact':
        await this.handleCompactCommand(client, message)
        return
      default:
        // Unknown command — fall through (caller handles as regular message)
        return
    }
  }

  private async handleCompactCommand(client: TelegramClient, message: ParsedMessage) {
    const session = await this.getSession(message.from.id)
    await this.sendReply(client, message.chatId, `> Compacting session (via ${PROVIDER_LABELS[this.currentProvider]})...`)

    const result = await forceCompact(
      session,
      async (summarizePrompt) => {
        if (this.currentProvider === 'claude-code') {
          const r = await askClaudeCode(summarizePrompt, { ...this.claudeCodeConfig, maxTurns: 1 })
          return r.text
        } else {
          // vercel-ai-sdk: use engine's ask() (no session, single prompt)
          const r = await this.engineRef!.ask(summarizePrompt)
          return r.text
        }
      },
    )

    if (!result) {
      await this.sendReply(client, message.chatId, 'Session is empty, nothing to compact.')
    } else {
      await this.sendReply(client, message.chatId, `Compacted. Pre-compaction: ~${result.preTokens} tokens.`)
    }
  }

  private async sendSettingsMenu(client: TelegramClient, chatId: number) {
    const ccLabel = this.currentProvider === 'claude-code' ? '> Claude Code' : 'Claude Code'
    const aiLabel = this.currentProvider === 'vercel-ai-sdk' ? '> Vercel AI SDK' : 'Vercel AI SDK'

    await client.sendMessage({
      chatId,
      text: `Current provider: ${PROVIDER_LABELS[this.currentProvider]}\n\nChoose default AI provider:`,
      replyMarkup: {
        inline_keyboard: [
          [{ text: ccLabel, callback_data: 'provider:claude-code' }],
          [{ text: aiLabel, callback_data: 'provider:vercel-ai-sdk' }],
        ],
      },
    })
  }


  private async handleClaudeCodeMessage(client: TelegramClient, message: ParsedMessage, userPrompt: string) {
    await this.sendReply(client, message.chatId, '> Processing with Claude Code...')

    const session = await this.getSession(message.from.id)
    const result = await askClaudeCodeWithSession(userPrompt, session, {
      claudeCode: this.claudeCodeConfig,
      compaction: this.compactionConfig,
      historyPreamble: 'The following is the recent conversation from this Telegram chat. Use it as context if the user references earlier events or decisions.',
    })

    await this.sendReply(client, message.chatId, result.text, result.media)
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

  private async sendReply(client: TelegramClient, chatId: number, text: string, media?: MediaAttachment[]) {
    console.log(`telegram: sendReply chatId=${chatId} textLen=${text.length} media=${media?.length ?? 0}`)

    // Send images first (if any)
    if (media && media.length > 0) {
      for (let i = 0; i < media.length; i++) {
        const attachment = media[i]
        console.log(`telegram: sending photo ${i + 1}/${media.length} path=${attachment.path}`)
        try {
          const { readFile } = await import('node:fs/promises')
          const buf = await readFile(attachment.path)
          console.log(`telegram: photo file size=${buf.byteLength} bytes`)
          await client.sendPhoto(chatId, buf)
          console.log(`telegram: photo ${i + 1} sent ok`)
        } catch (err) {
          console.error(`telegram: failed to send photo ${i + 1}:`, err)
        }
      }
    }

    // Then send text
    if (text) {
      const formatted = formatForTelegram(text)
      const chunks = splitMessage(formatted, MAX_MESSAGE_LENGTH)
      for (const chunk of chunks) {
        await client.sendMessage({ chatId, text: chunk, parseMode: 'HTML' })
      }
    }
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

    // Try to split at a newline
    let splitAt = remaining.lastIndexOf('\n', maxLength)
    if (splitAt === -1 || splitAt < maxLength / 2) {
      // Fall back to splitting at a space
      splitAt = remaining.lastIndexOf(' ', maxLength)
    }
    if (splitAt === -1 || splitAt < maxLength / 2) {
      // Hard split
      splitAt = maxLength
    }

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}
