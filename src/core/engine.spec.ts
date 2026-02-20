import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { Engine, type EngineOpts, type EngineResult } from './engine.js'
import { DEFAULT_COMPACTION_CONFIG, type CompactionConfig } from './compaction.js'
import type { SessionStore, SessionEntry } from './session.js'
import type { AIProvider, AskOptions, ProviderResult } from './ai-provider.js'
import { createAgent } from '../providers/vercel-ai-sdk/index.js'

// ==================== Helpers ====================

/** Minimal LanguageModelV3GenerateResult for the mock. */
function makeDoGenerate(text = 'mock response') {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    },
    warnings: [],
  }
}

function makeMockModel(text = 'mock response') {
  return new MockLanguageModelV3({ doGenerate: makeDoGenerate(text) })
}

/** Create a mock AIProvider that returns a fixed text and tracks calls. */
function makeMockProvider(text = 'provider response'): AIProvider & { calls: Array<{ prompt: string; opts?: AskOptions }> } {
  const calls: Array<{ prompt: string; opts?: AskOptions }> = []
  return {
    calls,
    askWithSession: vi.fn(async (prompt: string, _session: SessionStore, opts?: AskOptions): Promise<ProviderResult> => {
      calls.push({ prompt, opts })
      return { text, media: [] }
    }),
  }
}

function makeEngine(overrides: {
  model?: any
  tools?: Record<string, any>
  provider?: AIProvider
  instructions?: string
} = {}): Engine {
  const model = overrides.model ?? makeMockModel()
  const tools = overrides.tools ?? {}
  const agent = createAgent(model, tools, overrides.instructions ?? 'You are a test agent.', 1)
  const provider = overrides.provider ?? makeMockProvider()

  return new Engine({ agent, tools, provider })
}

/** In-memory SessionStore mock (no filesystem). */
function makeSessionMock(entries: SessionEntry[] = []): SessionStore {
  const store: SessionEntry[] = [...entries]
  return {
    id: 'test-session',
    appendUser: vi.fn(async (content: string) => {
      const e: SessionEntry = {
        type: 'user',
        message: { role: 'user', content },
        uuid: `u-${store.length}`,
        parentUuid: null,
        sessionId: 'test-session',
        timestamp: new Date().toISOString(),
      }
      store.push(e)
      return e
    }),
    appendAssistant: vi.fn(async (content: string) => {
      const e: SessionEntry = {
        type: 'assistant',
        message: { role: 'assistant', content },
        uuid: `a-${store.length}`,
        parentUuid: null,
        sessionId: 'test-session',
        timestamp: new Date().toISOString(),
      }
      store.push(e)
      return e
    }),
    appendRaw: vi.fn(async () => {}),
    readAll: vi.fn(async () => [...store]),
    readActive: vi.fn(async () => [...store]),
    restore: vi.fn(async () => {}),
    exists: vi.fn(async () => store.length > 0),
  } as unknown as SessionStore
}

// ==================== Tests ====================

describe('Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -------------------- Construction --------------------

  describe('constructor', () => {
    it('creates an engine with agent and tools', () => {
      const engine = makeEngine({ instructions: 'custom instructions' })
      expect(engine.agent).toBeDefined()
      expect(engine.tools).toEqual({})
    })

    it('exposes provided tools via readonly property', () => {
      const dummyTool = { description: 'test', inputSchema: {}, execute: async () => 'ok' }
      const engine = makeEngine({ tools: { myTool: dummyTool } as any })
      expect(engine.tools).toHaveProperty('myTool')
    })
  })

  // -------------------- ask() --------------------

  describe('ask()', () => {
    it('returns text from the model', async () => {
      const model = makeMockModel('hello world')
      const engine = makeEngine({ model })

      const result = await engine.ask('say hello')
      expect(result.text).toBe('hello world')
      expect(result.media).toEqual([])
    })

    it('returns empty string when model returns null text', async () => {
      const model = new MockLanguageModelV3({
        doGenerate: {
          content: [],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 0, text: 0, reasoning: undefined },
          },
          warnings: [],
        },
      })
      const engine = makeEngine({ model })

      const result = await engine.ask('empty response')
      expect(result.text).toBe('')
    })

    it('collects media from tool results via onStepFinish', async () => {
      const model = makeMockModel('no media')
      const engine = makeEngine({ model })

      const result = await engine.ask('test')
      expect(result.media).toEqual([])
    })
  })

  // -------------------- askWithSession() --------------------

  describe('askWithSession()', () => {
    it('delegates to the AIProvider', async () => {
      const provider = makeMockProvider('provider reply')
      const engine = makeEngine({ provider })
      const session = makeSessionMock()

      const result = await engine.askWithSession('user prompt', session)

      expect(provider.askWithSession).toHaveBeenCalledWith('user prompt', session, undefined)
      expect(result.text).toBe('provider reply')
      expect(result.media).toEqual([])
    })

    it('passes opts through to the provider', async () => {
      const provider = makeMockProvider('with opts')
      const engine = makeEngine({ provider })
      const session = makeSessionMock()
      const opts: AskOptions = {
        systemPrompt: 'test',
        maxHistoryEntries: 10,
        historyPreamble: 'preamble',
      }

      await engine.askWithSession('prompt', session, opts)

      expect(provider.askWithSession).toHaveBeenCalledWith('prompt', session, opts)
    })
  })

  // -------------------- withLock (concurrency) --------------------

  describe('concurrency', () => {
    it('serializes concurrent ask() calls', async () => {
      const order: number[] = []
      let callCount = 0
      const model = new MockLanguageModelV3({
        doGenerate: async () => {
          const n = ++callCount
          order.push(n)
          // Simulate async delay
          await new Promise((r) => setTimeout(r, 10))
          return makeDoGenerate(`response ${n}`)
        },
      })
      const engine = makeEngine({ model })

      // Launch two concurrent requests
      const [r1, r2] = await Promise.all([
        engine.ask('first'),
        engine.ask('second'),
      ])

      // Both should complete — order should be sequential (1 before 2)
      expect(order).toEqual([1, 2])
      expect(r1.text).toBe('response 1')
      expect(r2.text).toBe('response 2')
    })

    it('serializes concurrent askWithSession() calls', async () => {
      let callCount = 0
      const provider: AIProvider = {
        askWithSession: vi.fn(async (_prompt, _session, _opts) => {
          const n = ++callCount
          await new Promise((r) => setTimeout(r, 10))
          return { text: `session response ${n}`, media: [] }
        }),
      }
      const engine = makeEngine({ provider })
      const session = makeSessionMock()

      const [r1, r2] = await Promise.all([
        engine.askWithSession('first', session),
        engine.askWithSession('second', session),
      ])

      expect(r1.text).toBe('session response 1')
      expect(r2.text).toBe('session response 2')
    })

    it('releases lock even when generation throws', async () => {
      let callCount = 0
      const model = new MockLanguageModelV3({
        doGenerate: async () => {
          callCount++
          if (callCount === 1) throw new Error('boom')
          return makeDoGenerate('recovered')
        },
      })
      const engine = makeEngine({ model })

      // First call should fail
      await expect(engine.ask('fail')).rejects.toThrow('boom')

      // Second call should succeed (lock released)
      const result = await engine.ask('recover')
      expect(result.text).toBe('recovered')
    })
  })

  // -------------------- isGenerating --------------------

  describe('isGenerating', () => {
    it('is false before any call', () => {
      const engine = makeEngine()
      expect(engine.isGenerating).toBe(false)
    })

    it('is true during generation and false after', async () => {
      let observedDuringGeneration = false

      const slowModel = new MockLanguageModelV3({
        doGenerate: async () => {
          await new Promise((r) => setTimeout(r, 50))
          return makeDoGenerate('slow')
        },
      })
      const slowEngine = makeEngine({ model: slowModel })

      const promise = slowEngine.ask('test')

      // Give it a tick to enter withLock
      await new Promise((r) => setTimeout(r, 5))
      observedDuringGeneration = slowEngine.isGenerating

      await promise
      expect(observedDuringGeneration).toBe(true)
      expect(slowEngine.isGenerating).toBe(false)
    })

    it('resets to false even on error', async () => {
      const model = new MockLanguageModelV3({
        doGenerate: async () => { throw new Error('fail') },
      })
      const engine = makeEngine({ model })

      await expect(engine.ask('test')).rejects.toThrow()
      expect(engine.isGenerating).toBe(false)
    })
  })
})
