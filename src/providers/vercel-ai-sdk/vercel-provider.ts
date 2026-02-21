/**
 * VercelAIProvider — session-aware AI provider using Vercel AI SDK (ToolLoopAgent).
 *
 * Moved from Engine.askWithSession(). Handles:
 *  - Session append (user message)
 *  - Compaction (microcompact / full LLM summarization)
 *  - Agent generation with conversation context
 *  - DeepSeek safety guards (hallucination + tool refusal detection)
 *  - Tool result formatting fallback
 *  - Session persist (assistant response)
 */

import type { ModelMessage } from 'ai'
import type { Agent } from './agent.js'
import type { AIProvider, AskOptions, ProviderResult } from '../../core/ai-provider.js'
import type { SessionStore } from '../../core/session.js'
import type { MediaAttachment } from '../../core/types.js'
import { toModelMessages } from '../../core/session.js'
import { compactIfNeeded, type CompactionConfig } from '../../core/compaction.js'
import { extractMediaFromToolOutput } from '../../core/media.js'
import {
  isTradingHallucination,
  isToolRefusal,
  HALLUCINATION_CORRECTION,
  REFUSAL_CORRECTION,
  formatToolResults,
} from '../../core/guards.js'

export class VercelAIProvider implements AIProvider {
  constructor(
    private agent: Agent,
    private compaction: CompactionConfig,
  ) {}

  async askWithSession(prompt: string, session: SessionStore, opts?: AskOptions): Promise<ProviderResult> {
    // Append user message to session
    await session.appendUser(prompt, 'human')

    // Compact if needed before loading context
    const compactionResult = await compactIfNeeded(
      session,
      this.compaction,
      async (summarizePrompt) => {
        const r = await this.agent.generate({ prompt: summarizePrompt })
        return r.text ?? ''
      },
    )

    // Load active window and convert to model messages
    const allEntries = compactionResult.activeEntries ?? await session.readActive()

    // Limit history depth — prevents stale tool results from polluting context
    const maxEntries = opts?.maxHistoryEntries
    const entries = (maxEntries != null && allEntries.length > maxEntries)
      ? allEntries.slice(-maxEntries)
      : allEntries
    const messages = toModelMessages(entries)

    // Generate with conversation context — collect media from tool results
    const media: MediaAttachment[] = []
    let totalToolCalls = 0
    const result = await this.agent.generate({
      messages: messages as ModelMessage[],
      onStepFinish: (step) => {
        totalToolCalls += step.toolCalls.length
        for (const tr of step.toolResults) {
          media.push(...extractMediaFromToolOutput(tr.output))
        }
      },
    })

    let text = result.text ?? ''

    // ---- Trading hallucination guard ----
    if (isTradingHallucination(text, totalToolCalls)) {
      console.warn('vercel-provider: detected trading hallucination (0 tool calls), retrying with correction')

      const retryMessages: ModelMessage[] = [
        ...messages as ModelMessage[],
        { role: 'assistant', content: text } as ModelMessage,
        { role: 'user', content: HALLUCINATION_CORRECTION } as ModelMessage,
      ]

      let retryToolCalls = 0
      const retryResult = await this.agent.generate({
        messages: retryMessages,
        onStepFinish: (step) => {
          retryToolCalls += step.toolCalls.length
          for (const tr of step.toolResults) {
            media.push(...extractMediaFromToolOutput(tr.output))
          }
        },
      })

      text = retryResult.text ?? ''

      if (isTradingHallucination(text, retryToolCalls)) {
        console.warn('vercel-provider: hallucination persisted after retry, blocking fake response')
        text = '⚠️ 操作失败：系统未能正确执行交易指令。请重新发送你的请求，我会调用正确的工具来操作。'
      }
    }

    // ---- Tool refusal guard ----
    if (isToolRefusal(text, totalToolCalls)) {
      console.warn('vercel-provider: detected tool refusal after tool failure, retrying with correction')

      const refusalRetryMessages: ModelMessage[] = [
        ...messages as ModelMessage[],
        { role: 'assistant', content: text } as ModelMessage,
        { role: 'user', content: REFUSAL_CORRECTION } as ModelMessage,
      ]

      let refusalRetryToolCalls = 0
      const refusalRetryResult = await this.agent.generate({
        messages: refusalRetryMessages,
        onStepFinish: (step) => {
          refusalRetryToolCalls += step.toolCalls.length
          for (const tr of step.toolResults) {
            media.push(...extractMediaFromToolOutput(tr.output))
          }
        },
      })

      text = refusalRetryResult.text ?? ''

      if (isToolRefusal(text, refusalRetryToolCalls)) {
        console.warn('vercel-provider: tool refusal persisted after retry, blocking refusal response')
        text = '⚠️ 操作遇到临时错误，请稍后重试。系统工具正常可用，这只是暂时性问题。'
      }
    }

    // ---- Tool result formatting fallback ----
    const toolResults = (result as any).toolResults || []
    const hasCryptoData = toolResults.some((tr: any) =>
      tr.toolName?.startsWith('crypto') &&
      tr.output &&
      (Array.isArray(tr.output) || (typeof tr.output === 'object' && 'balance' in tr.output))
    )

    if (hasCryptoData && text.length < 100) {
      const formatted = formatToolResults(toolResults)
      if (formatted) {
        text = formatted
      }
    }

    // Append assistant response to session
    await session.appendAssistant(text, 'engine')

    return { text, media }
  }
}
