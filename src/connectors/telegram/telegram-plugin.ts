import type { Plugin, EngineContext, MediaAttachment } from '../../core/types.js'
import type { TelegramConfig, ParsedMessage } from './types.js'
import { TelegramClient } from './client.js'
import { runPollingLoop } from './polling.js'
import { parseUpdate, parseCallbackQuery } from './handler.js'
import { MediaGroupMerger } from './media-group.js'
import { askClaudeCode } from '../../providers/claude-code/index.js'
import type { ClaudeCodeConfig } from '../../providers/claude-code/index.js'
import { SessionStore } from '../../core/session.js'
import { forceCompact } from '../../core/compaction.js'
import { readAIConfig, writeAIConfig, type AIProvider } from '../../core/ai-config.js'
import { registerConnector, touchInteraction } from '../../core/connector-registry.js'

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
    // Inject agent config into Claude Code config (used by /compact command)
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
    const aiConfig = await readAIConfig()
    console.log(`telegram plugin: connected as @${me.username} (provider: ${aiConfig.provider})`)

    // Register connector for outbound delivery (heartbeat / cron responses)
    if (this.config.allowedChatIds.length > 0) {
      const deliveryChatId = this.config.allowedChatIds[0]
      this.unregisterConnector = registerConnector({
        channel: 'telegram',
        to: String(deliveryChatId),
        deliver: async (text: string) => {
          const chunks = splitMessage(text, MAX_MESSAGE_LENGTH)
          for (const chunk of chunks) {
            await client.sendMessage({ chatId: deliveryChatId, text: chunk })
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
            this.handleCallbackQuery(client, cq.chatId, cq.messageId, cq.callbackQueryId, cq.data)
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

  private async handleCallbackQuery(client: TelegramClient, chatId: number, messageId: number, callbackQueryId: string, data: string) {
    try {
      if (data.startsWith('provider:')) {
        const provider = data.slice('provider:'.length) as AIProvider
        await writeAIConfig(provider)
        await client.answerCallbackQuery(callbackQueryId, `Switched to ${PROVIDER_LABELS[provider]}`)

        // Edit the original settings message in-place
        const ccLabel = provider === 'claude-code' ? '> Claude Code' : 'Claude Code'
        const aiLabel = provider === 'vercel-ai-sdk' ? '> Vercel AI SDK' : 'Vercel AI SDK'
        await client.editMessageText({
          chatId,
          messageId,
          text: `Current provider: ${PROVIDER_LABELS[provider]}\n\nChoose default AI provider:`,
          replyMarkup: {
            inline_keyboard: [[
              { text: ccLabel, callback_data: 'provider:claude-code' },
              { text: aiLabel, callback_data: 'provider:vercel-ai-sdk' },
            ]],
          },
        })
      } else {
        await client.answerCallbackQuery(callbackQueryId)
      }
    } catch (err) {
      console.error('telegram callback query error:', err)
    }
  }

  private async handleMessage(ctx: EngineContext, client: TelegramClient, message: ParsedMessage) {
    try {
      // Record user interaction for delivery routing
      touchInteraction('telegram', String(message.chatId))

      // Handle built-in commands
      if (message.command) {
        await this.handleCommand(client, message)
        return
      }

      // Build prompt from message content
      const prompt = this.buildPrompt(message)
      if (!prompt) return

      // Route through unified provider (Engine → ProviderRouter → Vercel or Claude Code)
      const session = await this.getSession(message.from.id)
      const result = await ctx.engine.askWithSession(prompt, session, {
        historyPreamble: 'The following is the recent conversation from this Telegram chat. Use it as context if the user references earlier messages.',
      })
      await this.sendReply(client, message.chatId, result.text, result.media)
    } catch (err) {
      console.error('telegram message handling error:', err)
      await this.sendReply(client, message.chatId, 'Sorry, something went wrong processing your message.').catch(() => {})
    }
  }

  private async handleCommand(client: TelegramClient, message: ParsedMessage) {
    switch (message.command) {
      case 'status': {
        const aiConfig = await readAIConfig()
        await this.sendReply(client, message.chatId, `Engine is running. Provider: ${PROVIDER_LABELS[aiConfig.provider]}`)
        return
      }
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
    await this.sendReply(client, message.chatId, '> Compacting session...')

    const result = await forceCompact(
      session,
      async (summarizePrompt) => {
        const r = await askClaudeCode(summarizePrompt, { ...this.claudeCodeConfig, maxTurns: 1 })
        return r.text
      },
    )

    if (!result) {
      await this.sendReply(client, message.chatId, 'Session is empty, nothing to compact.')
    } else {
      await this.sendReply(client, message.chatId, `Compacted. Pre-compaction: ~${result.preTokens} tokens.`)
    }
  }

  private async sendSettingsMenu(client: TelegramClient, chatId: number) {
    const aiConfig = await readAIConfig()
    const ccLabel = aiConfig.provider === 'claude-code' ? '> Claude Code' : 'Claude Code'
    const aiLabel = aiConfig.provider === 'vercel-ai-sdk' ? '> Vercel AI SDK' : 'Vercel AI SDK'

    await client.sendMessage({
      chatId,
      text: `Current provider: ${PROVIDER_LABELS[aiConfig.provider]}\n\nChoose default AI provider:`,
      replyMarkup: {
        inline_keyboard: [[
          { text: ccLabel, callback_data: 'provider:claude-code' },
          { text: aiLabel, callback_data: 'provider:vercel-ai-sdk' },
        ]],
      },
    })
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
      const chunks = splitMessage(text, MAX_MESSAGE_LENGTH)
      for (const chunk of chunks) {
        await client.sendMessage({ chatId, text: chunk })
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
