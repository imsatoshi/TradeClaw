/**
 * Engine — AI conversation service (thin layer).
 *
 * Pure responsibility: manage a ToolLoopAgent and provide ask/askWithSession.
 * Session management, guards, and provider routing live in AIProvider implementations.
 * Does NOT own plugins, tools assembly, tick loops, or extension instances.
 * Those concerns live in main.ts (the composition root).
 */

import type { ModelMessage, Tool } from 'ai'
import type { MediaAttachment } from './types.js'
import type { AIProvider, AskOptions, ProviderResult } from './ai-provider.js'
import { createAgent, type Agent } from '../providers/vercel-ai-sdk/index.js'
import { type SessionStore } from './session.js'
import { extractMediaFromToolOutput } from './media.js'
import {
  isTradingHallucination,
  isToolRefusal,
  HALLUCINATION_CORRECTION,
  REFUSAL_CORRECTION,
  formatToolResults,
} from './guards.js'

// ==================== Types ====================

export interface EngineOpts {
  agent: Agent
  tools: Record<string, Tool>
  provider: AIProvider
}

export interface EngineResult {
  text: string
  /** Media produced by tools during the generation (e.g. screenshots). */
  media: MediaAttachment[]
}

// ==================== Engine ====================

export class Engine {
  private generationLock = Promise.resolve()
  private _generating = false

  /** The underlying ToolLoopAgent. */
  readonly agent: Agent

  /** Tools registered with the agent (for MCP exposure, etc.). */
  readonly tools: Record<string, Tool>

  /** The provider router for session-aware calls. */
  private provider: AIProvider

  constructor(opts: EngineOpts) {
    this.agent = opts.agent
    this.tools = opts.tools
    this.provider = opts.provider
  }

  // ==================== Public API ====================

  /** Whether a generation is currently in progress (for requests-in-flight guard). */
  get isGenerating(): boolean { return this._generating }

  /** Simple prompt (no session context). Used for MCP and stateless calls. */
  async ask(prompt: string): Promise<EngineResult> {
    const media: MediaAttachment[] = []
    let totalToolCalls = 0
    const result = await this.withLock(() => this.agent.generate({
      prompt,
      onStepFinish: (step) => {
        totalToolCalls += step.toolCalls.length
        for (const tr of step.toolResults) {
          media.push(...extractMediaFromToolOutput(tr.output))
        }
      },
    }))

    let text = result.text ?? ''

    // Trading hallucination guard
    if (isTradingHallucination(text, totalToolCalls)) {
      console.warn('engine(ask): detected trading hallucination (0 tool calls), retrying with correction')

      let retryToolCalls = 0
      const retryResult = await this.withLock(() => this.agent.generate({
        messages: [
          { role: 'user', content: prompt } as ModelMessage,
          { role: 'assistant', content: text } as ModelMessage,
          { role: 'user', content: HALLUCINATION_CORRECTION } as ModelMessage,
        ],
        onStepFinish: (step) => {
          retryToolCalls += step.toolCalls.length
          for (const tr of step.toolResults) {
            media.push(...extractMediaFromToolOutput(tr.output))
          }
        },
      }))

      text = retryResult.text ?? ''

      if (isTradingHallucination(text, retryToolCalls)) {
        console.warn('engine(ask): hallucination persisted after retry, blocking fake response')
        text = '⚠️ 操作失败：系统未能正确执行交易指令。请重新发送你的请求，我会调用正确的工具来操作。'
      }
    }

    // Tool refusal guard
    if (isToolRefusal(text, totalToolCalls)) {
      console.warn('engine(ask): detected tool refusal after tool failure, retrying with correction')

      let refusalRetryToolCalls = 0
      const refusalRetryResult = await this.withLock(() => this.agent.generate({
        messages: [
          { role: 'user', content: prompt } as ModelMessage,
          { role: 'assistant', content: text } as ModelMessage,
          { role: 'user', content: REFUSAL_CORRECTION } as ModelMessage,
        ],
        onStepFinish: (step) => {
          refusalRetryToolCalls += step.toolCalls.length
          for (const tr of step.toolResults) {
            media.push(...extractMediaFromToolOutput(tr.output))
          }
        },
      }))

      text = refusalRetryResult.text ?? ''

      if (isToolRefusal(text, refusalRetryToolCalls)) {
        console.warn('engine(ask): tool refusal persisted after retry, blocking refusal response')
        text = '⚠️ 操作遇到临时错误，请稍后重试。系统工具正常可用，这只是暂时性问题。'
      }
    }

    // Tool result formatting fallback
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

    return { text, media }
  }

  /** Prompt with session — delegates to the AIProvider (ProviderRouter). */
  async askWithSession(prompt: string, session: SessionStore, opts?: AskOptions): Promise<ProviderResult> {
    return this.withLock(() => this.provider.askWithSession(prompt, session, opts))
  }

  // ==================== Internals ====================

  /** Serialize concurrent calls — one generation at a time. */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.generationLock
    let resolve!: () => void
    this.generationLock = new Promise<void>((r) => { resolve = r })
    await prev
    this._generating = true
    try {
      return await fn()
    } finally {
      this._generating = false
      resolve()
    }
  }
}
