/**
 * Kimi Code Provider Types
 */

export interface KimiCodeConfig {
  /** Working directory for the agent. */
  cwd?: string
  /** System prompt. */
  systemPrompt?: string
  /** Custom agent specification file. */
  agentFile?: string
  /** Maximum number of steps in one turn. */
  maxSteps?: number
  /** Maximum number of retries in one step. */
  maxRetries?: number
  /** Enable thinking mode. */
  thinking?: boolean
  /** Automatically approve all actions. */
  yolo?: boolean
  /** MCP config file path. */
  mcpConfigFile?: string
  /** Callback for tool results. */
  onToolResult?: (result: { toolUseId: string; content: string }) => void
}

export interface KimiCodeResult {
  text: string
  ok: boolean
  messages: KimiCodeMessage[]
}

export interface KimiCodeMessage {
  role: 'assistant' | 'user'
  content: Array<{
    type: string
    [key: string]: unknown
  }>
}
