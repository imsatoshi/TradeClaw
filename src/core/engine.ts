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
    return { text: result.text ?? '', media }
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
    const result = await this.withLock(() =>
      this.agent.generate({
        messages: messages as ModelMessage[],
        onStepFinish: (step) => {
          for (const tr of step.toolResults) {
            media.push(...extractMediaFromToolOutput(tr.output))
          }
        },
      }),
    )

    const text = result.text ?? ''

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
