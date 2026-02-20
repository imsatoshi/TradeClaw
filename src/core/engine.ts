/**
 * Engine — AI conversation service.
 *
 * Pure responsibility: manage a ToolLoopAgent and provide ask/askWithSession.
 * Does NOT own plugins, tools assembly, tick loops, or extension instances.
 * Those concerns live in main.ts (the composition root).
 */

import type { LanguageModel, ModelMessage, Tool } from 'ai'
import type { MediaAttachment } from './types.js'
import { createAgent, type Agent } from '../providers/vercel-ai-sdk/index.js'
import { type SessionStore, toModelMessages } from './session.js'
import { compactIfNeeded, type CompactionConfig } from './compaction.js'
import { extractMediaFromToolOutput } from './media.js'

// ==================== Tool Result Formatter ====================

function formatToolResults(toolResults: any[]): string | null {
  for (const tr of toolResults) {
    // Format cryptoGetPositions
    if (tr.toolName === 'cryptoGetPositions' && Array.isArray(tr.output) && tr.output.length > 0) {
      const positions = tr.output
      let text = '## 📊 您的持仓情况\n\n'
      text += `**持仓数量:** ${positions.length}\n\n`

      let totalPnl = 0
      positions.forEach((p: any, i: number) => {
        text += `**${i + 1}. ${p.symbol}**\n`
        text += `- 方向: ${p.side === 'long' ? '做多 📈' : '做空 📉'}\n`
        text += `- 数量: ${p.size}\n`
        text += `- 开仓价: $${p.entryPrice}\n`
        text += `- 标记价: $${typeof p.markPrice === 'number' ? p.markPrice.toFixed(2) : p.markPrice}\n`
        text += `- 杠杆: ${p.leverage}x\n`
        text += `- 未实现盈亏: $${typeof p.unrealizedPnL === 'number' ? p.unrealizedPnL.toFixed(2) : p.unrealizedPnL}\n`
        text += `- 仓位价值: $${typeof p.positionValue === 'number' ? p.positionValue.toFixed(2) : p.positionValue}\n`
        if (p.percentageOfEquity) text += `- 占权益: ${p.percentageOfEquity}\n`
        text += '\n'
        totalPnl += typeof p.unrealizedPnL === 'number' ? p.unrealizedPnL : 0
      })

      text += `**总未实现盈亏:** $${totalPnl.toFixed(2)}\n`
      return text
    }

    // Format cryptoGetAccount
    if (tr.toolName === 'cryptoGetAccount' && tr.output && typeof tr.output === 'object') {
      const a = tr.output
      let text = '## 💰 账户信息\n\n'
      text += `- **可用余额:** $${typeof a.balance === 'number' ? a.balance.toFixed(2) : a.balance}\n`
      text += `- **账户权益:** $${typeof a.equity === 'number' ? a.equity.toFixed(2) : a.equity}\n`
      text += `- **保证金占用:** $${typeof a.totalMargin === 'number' ? a.totalMargin.toFixed(2) : a.totalMargin}\n`
      text += `- **未实现盈亏:** $${typeof a.unrealizedPnL === 'number' ? a.unrealizedPnL.toFixed(2) : a.unrealizedPnL}\n`
      return text
    }
  }
  return null
}

// ==================== Trading Hallucination Guard ====================

/**
 * Detect when the model claims to have executed a trading action but made
 * zero tool calls — a hallucination that pollutes session history.
 */
const TRADING_CLAIM_RE = /已设置|已提交|订单已|已下单|已挂单|已修改|已取消|已撤单|已平仓|已止盈|已止损|已开仓|order placed|order modified|order cancel|position closed/i

function isTradingHallucination(text: string, toolCallCount: number): boolean {
  return toolCallCount === 0 && TRADING_CLAIM_RE.test(text)
}

const HALLUCINATION_CORRECTION = [
  'SYSTEM CORRECTION: Your previous response claimed to execute a trading action without calling any tools.',
  'This is NOT allowed. You MUST call the actual trading tools (cryptoClosePosition, cryptoPlaceOrder, etc.) to execute orders.',
  'Please try again — call the correct tools NOW to fulfill the user\'s request.',
].join(' ')

// ==================== Types ====================

export interface EngineOpts {
  model: LanguageModel
  tools: Record<string, Tool>
  instructions: string
  maxSteps: number
  compaction: CompactionConfig
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
  private compaction: CompactionConfig

  /** The underlying ToolLoopAgent. */
  readonly agent: Agent

  /** Tools registered with the agent (for MCP exposure, etc.). */
  readonly tools: Record<string, Tool>

  constructor(opts: EngineOpts) {
    this.tools = opts.tools
    this.compaction = opts.compaction
    this.agent = createAgent(opts.model, opts.tools, opts.instructions, opts.maxSteps)
  }

  // ==================== Public API ====================

  /** Whether a generation is currently in progress (for requests-in-flight guard). */
  get isGenerating(): boolean { return this._generating }

  /** Simple prompt (no session context). */
  async ask(prompt: string): Promise<EngineResult> {
    const media: MediaAttachment[] = []
    const result = await this.withLock(() => this.agent.generate({
      prompt,
      onStepFinish: (step) => {
        for (const tr of step.toolResults) {
          media.push(...extractMediaFromToolOutput(tr.output))
        }
      },
    }))

    let text = result.text ?? ''

    // Workaround for models that don't generate detailed responses after tool calls
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

  /** Prompt with session — appends to session and uses full history as context. */
  async askWithSession(prompt: string, session: SessionStore): Promise<EngineResult> {
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

    // Load active window (from last compact boundary onward) and convert
    const entries = compactionResult.activeEntries ?? await session.readActive()
    const messages = toModelMessages(entries)

    // Generate with conversation context — collect media from tool results
    const media: MediaAttachment[] = []
    let totalToolCalls = 0
    const result = await this.withLock(() =>
      this.agent.generate({
        messages: messages as ModelMessage[],
        onStepFinish: (step) => {
          totalToolCalls += step.toolCalls.length
          for (const tr of step.toolResults) {
            media.push(...extractMediaFromToolOutput(tr.output))
          }
        },
      }),
    )

    let text = result.text ?? ''

    // ---- Trading hallucination guard ----
    // If the model claims to have executed trading actions but made zero tool calls,
    // inject a correction and retry once. This prevents session pollution.
    if (isTradingHallucination(text, totalToolCalls)) {
      console.warn('engine: detected trading hallucination (0 tool calls), retrying with correction')

      // Add the hallucinated response + correction as context for retry
      const retryMessages: ModelMessage[] = [
        ...messages as ModelMessage[],
        { role: 'assistant', content: text } as ModelMessage,
        { role: 'user', content: HALLUCINATION_CORRECTION } as ModelMessage,
      ]

      let retryToolCalls = 0
      const retryResult = await this.withLock(() =>
        this.agent.generate({
          messages: retryMessages,
          onStepFinish: (step) => {
            retryToolCalls += step.toolCalls.length
            for (const tr of step.toolResults) {
              media.push(...extractMediaFromToolOutput(tr.output))
            }
          },
        }),
      )

      text = retryResult.text ?? ''

      // If still hallucinating after retry, replace with a safe message
      if (isTradingHallucination(text, retryToolCalls)) {
        console.warn('engine: hallucination persisted after retry, blocking fake response')
        text = '⚠️ 操作失败：系统未能正确执行交易指令。请重新发送你的请求，我会调用正确的工具来操作。'
      }
    }

    // Workaround for models that don't generate detailed responses after tool calls
    // Check if any tool results contain crypto/account data that should be displayed
    const toolResults = (result as any).toolResults || []
    const hasCryptoData = toolResults.some((tr: any) =>
      tr.toolName?.startsWith('crypto') &&
      tr.output &&
      (Array.isArray(tr.output) || (typeof tr.output === 'object' && 'balance' in tr.output))
    )

    if (hasCryptoData && text.length < 100) {
      // AI didn't generate detailed response, format tool results manually
      const formatted = formatToolResults(toolResults)
      if (formatted) {
        text = formatted
      }
    }

    // Append assistant response to session
    await session.appendAssistant(text, 'engine')

    return { text, media }
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
