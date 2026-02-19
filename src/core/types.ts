import type { Sandbox } from '../extension/analysis-kit/index.js'
import type { ICryptoTradingEngine } from '../extension/crypto-trading/index.js'
import type { Config } from './config.js'
import type { Engine } from './engine.js'

export type { Config }

export interface Plugin {
  name: string
  start(ctx: EngineContext): Promise<void>
  stop(): Promise<void>
}

export interface EngineContext {
  config: Config
  sandbox: Sandbox
  cryptoEngine: ICryptoTradingEngine
  engine: Engine
}

/** A media attachment collected from tool results (e.g. browser screenshots). */
export interface MediaAttachment {
  type: 'image'
  /** Absolute path to the file on disk. */
  path: string
}
