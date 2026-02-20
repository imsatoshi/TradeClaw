/**
 * ClaudeCodeProvider — thin adapter wrapping askClaudeCodeWithSession
 * to implement the AIProvider interface.
 *
 * Claude Code doesn't need DeepSeek safety guards — Claude is reliable enough.
 */

import type { AIProvider, AskOptions, ProviderResult } from '../../core/ai-provider.js'
import type { SessionStore } from '../../core/session.js'
import type { CompactionConfig } from '../../core/compaction.js'
import type { ClaudeCodeConfig } from './types.js'
import { askClaudeCodeWithSession } from './session.js'

export class ClaudeCodeProvider implements AIProvider {
  constructor(
    private claudeCodeConfig: ClaudeCodeConfig,
    private compaction: CompactionConfig,
  ) {}

  async askWithSession(prompt: string, session: SessionStore, opts?: AskOptions): Promise<ProviderResult> {
    return askClaudeCodeWithSession(prompt, session, {
      claudeCode: this.claudeCodeConfig,
      compaction: this.compaction,
      systemPrompt: opts?.systemPrompt,
      maxHistoryEntries: opts?.maxHistoryEntries,
      historyPreamble: opts?.historyPreamble,
    })
  }
}
