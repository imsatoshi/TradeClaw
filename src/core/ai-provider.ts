/**
 * AIProvider interface + ProviderRouter — upstream-aligned provider abstraction.
 *
 * The ProviderRouter reads ai-config.json at call time to decide whether to
 * route to VercelAIProvider (DeepSeek) or ClaudeCodeProvider (Claude CLI).
 * Engine delegates to this instead of managing provider logic itself.
 */

import type { SessionStore } from './session.js'
import type { MediaAttachment } from './types.js'
import { readAIConfig } from './ai-config.js'

// ==================== Types ====================

export interface AskOptions {
  /** Preamble text injected before conversation history. */
  historyPreamble?: string
  /** System prompt for the provider. */
  systemPrompt?: string
  /** Max history entries to include. */
  maxHistoryEntries?: number
}

export interface ProviderResult {
  text: string
  media: MediaAttachment[]
}

// ==================== Interface ====================

export interface AIProvider {
  askWithSession(prompt: string, session: SessionStore, opts?: AskOptions): Promise<ProviderResult>
}

// ==================== Router ====================

export class ProviderRouter implements AIProvider {
  constructor(
    private vercel: AIProvider,
    private claudeCode: AIProvider | null,
  ) {}

  async askWithSession(prompt: string, session: SessionStore, opts?: AskOptions): Promise<ProviderResult> {
    const aiConfig = await readAIConfig()
    if (aiConfig.provider === 'claude-code' && this.claudeCode) {
      return this.claudeCode.askWithSession(prompt, session, opts)
    }
    return this.vercel.askWithSession(prompt, session, opts)
  }
}
