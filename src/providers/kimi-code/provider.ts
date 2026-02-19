/**
 * Kimi Code Provider via ACP (Agent Client Protocol)
 *
 * 启动 kimi acp 服务器，通过 HTTP/WebSocket 通信
 */

import { spawn, ChildProcess } from 'node:child_process'
import { pino } from 'pino'
import type { KimiCodeConfig, KimiCodeResult, KimiCodeMessage } from './types.js'
import type { ContentBlock } from '../../core/session.js'
import { logToolCall } from '../log-tool-call.js'

const logger = pino({
  transport: { target: 'pino/file', options: { destination: 'logs/kimi-code.log', mkdir: true } },
})

/** Strip base64 image data from tool_result content */
function stripImageData(raw: string): string {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return raw
    let changed = false
    const cleaned = parsed.map((item: Record<string, unknown>) => {
      if (item.type === 'image' && (item.source as Record<string, unknown>)?.data) {
        changed = true
        return { type: 'text', text: '[Image saved to disk — use Read tool to view the file]' }
      }
      return item
    })
    return changed ? JSON.stringify(cleaned) : raw
  } catch { return raw }
}

/** Kimi Code ACP Provider */
export class KimiCodeProvider {
  private child: ChildProcess | null = null
  private buffer = ''
  private isReady = false
  private readyPromise: Promise<void>
  private readyResolve!: () => void
  private port: number = 0
  private sessionId: string = ''

  constructor(private config: KimiCodeConfig = {}) {
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve
    })
  }

  /** Start kimi acp server */
  async start(): Promise<void> {
    if (this.child) return

    const {
      cwd = process.cwd(),
      agentFile,
      mcpConfigFile,
    } = this.config

    // Use acp mode with wire protocol
    const args: string[] = ['acp']

    if (agentFile) {
      args.push('--agent-file', agentFile)
    }

    if (mcpConfigFile) {
      args.push('--mcp-config-file', mcpConfigFile)
    }

    logger.info({ args, cwd }, 'Starting kimi acp')

    this.child = spawn('kimi', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    this.child.stdout?.on('data', (chunk: Buffer) => {
      const data = chunk.toString()
      this.buffer += data
      logger.debug({ data: data.slice(0, 200) }, 'kimi stdout')
      
      // Check for ready signal
      if (!this.isReady && (data.includes('ACP server') || data.includes('Listening') || data.includes('http://'))) {
        // Extract port if available
        const portMatch = data.match(/:(\d+)/)
        if (portMatch) {
          this.port = parseInt(portMatch[1], 10)
        }
        this.isReady = true
        this.readyResolve()
        logger.info({ port: this.port }, 'Kimi ACP ready')
      }
    })

    this.child.stderr?.on('data', (chunk: Buffer) => {
      const stderr = chunk.toString()
      logger.debug({ stderr: stderr.slice(0, 200) }, 'kimi stderr')
    })

    this.child.on('error', (err) => {
      logger.error({ error: err.message }, 'kimi spawn error')
    })

    this.child.on('close', (code) => {
      logger.info({ code }, 'kimi process closed')
      this.child = null
      this.isReady = false
    })

    // Wait for ready
    await Promise.race([
      this.readyPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Kimi start timeout')), 10000))
    ])
  }

  /** Stop kimi */
  async stop(): Promise<void> {
    if (!this.child) return
    
    this.child.stdin?.write('/exit\n')
    this.child.stdin?.end()
    
    setTimeout(() => {
      this.child?.kill('SIGTERM')
    }, 1000)
    
    setTimeout(() => {
      this.child?.kill('SIGKILL')
    }, 5000)
  }

  /** Send prompt and get result */
  async ask(prompt: string): Promise<KimiCodeResult> {
    await this.readyPromise
    
    if (!this.child?.stdin) {
      throw new Error('Kimi process not started')
    }

    // In ACP mode, we communicate via the chat interface
    // Send the prompt followed by newline
    logger.info({ promptLength: prompt.length }, 'Sending prompt to kimi')
    
    // Reset state
    const messages: KimiCodeMessage[] = []
    let resultText = ''
    let buffer = ''
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Kimi response timeout'))
      }, 120000) // 2 minute timeout

      const onData = (chunk: Buffer) => {
        const data = chunk.toString()
        buffer += data
        
        // Look for result marker or completion
        // In stream-json mode, we look for specific event types
        let newlineIdx: number
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim()
          buffer = buffer.slice(newlineIdx + 1)
          if (!line) continue

          try {
            const event = JSON.parse(line)
            
            if (event.type === 'assistant' && event.message?.content) {
              const blocks: ContentBlock[] = []
              for (const block of event.message.content) {
                if (block.type === 'tool_use') {
                  logToolCall(block.name, block.input)
                  blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
                } else if (block.type === 'text') {
                  blocks.push({ type: 'text', text: block.text })
                }
              }
              if (blocks.length > 0) {
                messages.push({ role: 'assistant', content: blocks })
              }
            }
            else if (event.type === 'user' && event.message?.content) {
              const blocks: ContentBlock[] = []
              for (const block of event.message.content) {
                if (block.type === 'tool_result') {
                  const content = typeof block.content === 'string'
                    ? block.content
                    : JSON.stringify(block.content ?? '')
                  blocks.push({ type: 'tool_result', tool_use_id: block.tool_use_id, content: stripImageData(content) })
                }
              }
              if (blocks.length > 0) {
                messages.push({ role: 'user', content: blocks })
              }
            }
            else if (event.type === 'result') {
              resultText = event.result ?? ''
              clearTimeout(timeout)
              this.child?.stdout?.off('data', onData)
              resolve({ text: resultText, ok: true, messages })
            }
          } catch {
            // Not JSON, might be plain text output
            if (line.includes('result') || line.includes('Result')) {
              resultText += line + '\n'
            }
          }
        }
      }

      this.child!.stdout!.on('data', onData)
      
      // Send the prompt
      this.child!.stdin!.write(prompt + '\n')
    })
  }
}

/** Singleton instance */
let globalProvider: KimiCodeProvider | null = null

/** Get or create global provider */
export async function getKimiCodeProvider(config?: KimiCodeConfig): Promise<KimiCodeProvider> {
  if (!globalProvider) {
    globalProvider = new KimiCodeProvider(config)
    await globalProvider.start()
  }
  return globalProvider
}

/** Ask kimi (stateless wrapper) */
export async function askKimiCode(
  prompt: string,
  config?: KimiCodeConfig,
): Promise<KimiCodeResult> {
  const provider = await getKimiCodeProvider(config)
  return provider.ask(prompt)
}

/** Cleanup function */
export async function cleanupKimiCodeProvider(): Promise<void> {
  await globalProvider?.stop()
  globalProvider = null
}
