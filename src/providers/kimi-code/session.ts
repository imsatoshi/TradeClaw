/**
 * Kimi Code Session Management
 */

import type { SessionStore } from '../../core/session.js'
import type { CompactionConfig } from '../../core/compaction.js'
import type { MediaAttachment } from '../../core/types.js'
import type { KimiCodeConfig } from './types.js'
import { toTextHistory } from '../../core/session.js'
import { compactIfNeeded } from '../../core/compaction.js'
import { extractMediaFromToolResultContent } from '../../core/media.js'
import { askKimiCode, getKimiCodeProvider } from './provider.js'

// ==================== Types ====================

export interface KimiCodeSessionConfig {
  /** Config passed through to kimi provider. */
  kimiCode: KimiCodeConfig
  /** Compaction config for auto-summarization. */
  compaction: CompactionConfig
  /** Optional system prompt. */
  systemPrompt?: string
  /** Max text history entries to include. Default: 50. */
  maxHistoryEntries?: number
  /** Preamble text inside <chat_history> block. */
  historyPreamble?: string
}

export interface KimiCodeSessionResult {
  text: string
  media: MediaAttachment[]
}

// ==================== Default ====================

const DEFAULT_MAX_HISTORY = 50
const DEFAULT_PREAMBLE =
  'The following is the recent conversation history. Use it as context if it references earlier events or decisions.'

// ==================== Public ====================

/**
 * Call Kimi Code with full session management.
 */
export async function askKimiCodeWithSession(
  prompt: string,
  session: SessionStore,
  config: KimiCodeSessionConfig,
): Promise<KimiCodeSessionResult> {
  const maxHistory = config.maxHistoryEntries ?? DEFAULT_MAX_HISTORY
  const preamble = config.historyPreamble ?? DEFAULT_PREAMBLE

  // 1. Append user message to session
  await session.appendUser(prompt, 'human')

  // 2. Ensure provider is started
  const provider = await getKimiCodeProvider(config.kimiCode)

  // 3. Compact if needed (using kimi as summarizer)
  const compactionResult = await compactIfNeeded(
    session,
    config.compaction,
    async (summarizePrompt) => {
      const r = await provider.ask(summarizePrompt)
      return r.text
    },
  )

  // 4. Read active window and build text history
  const entries = compactionResult.activeEntries ?? await session.readActive()
  const textHistory = toTextHistory(entries).slice(-maxHistory)

  // 5. Build full prompt with <chat_history> if history exists
  let fullPrompt: string
  if (textHistory.length > 0) {
    const lines = textHistory.map((entry) => {
      const tag = entry.role === 'user' ? 'User' : 'Bot'
      return `[${tag}] ${entry.text}`
    })
    fullPrompt = [
      '<chat_history>',
      preamble,
      '',
      ...lines,
      '</chat_history>',
      '',
      prompt,
    ].join('\n')
  } else {
    fullPrompt = prompt
  }

  // 6. Prepend system prompt if provided
  if (config.systemPrompt) {
    fullPrompt = `${config.systemPrompt}\n\n${fullPrompt}`
  }

  // 7. Call kimi — collect media from tool results
  const media: MediaAttachment[] = []
  provider.onToolResult((content) => {
    media.push(...extractMediaFromToolResultContent(content))
  })
  
  const result = await provider.ask(fullPrompt)

  // 8. Persist intermediate messages (tool calls + results) to session
  for (const msg of result.messages) {
    if (msg.role === 'assistant') {
      await session.appendAssistant(msg.content, 'kimi-code')
    } else {
      await session.appendUser(msg.content, 'kimi-code')
    }
  }

  // 9. Return unified result
  const prefix = result.ok ? '' : '[error] '
  return { text: prefix + result.text, media }
}
