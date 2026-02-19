/**
 * Securities Trading Engine Factory
 *
 * Instantiate the corresponding securities trading engine provider based on config
 */

import type { ISecuritiesTradingEngine } from './interfaces.js';
import type { Config } from '../../core/config.js';

export interface SecuritiesTradingEngineResult {
  engine: ISecuritiesTradingEngine;
  close: () => Promise<void>;
}

/**
 * Create securities trading engine
 *
 * @returns engine instance, or null (provider = 'none')
 */
export async function createSecuritiesTradingEngine(
  config: Config,
): Promise<SecuritiesTradingEngineResult | null> {
  const providerConfig = config.securities.provider;

  switch (providerConfig.type) {
    case 'none':
      return null;

    case 'alpaca': {
      // Dynamic import to avoid loading Alpaca SDK when not needed
      const { AlpacaTradingEngine } = await import('./providers/alpaca/index.js');

      const apiKey = process.env.ALPACA_API_KEY;
      const secretKey = process.env.ALPACA_SECRET_KEY;

      if (!apiKey || !secretKey) {
        throw new Error(
          'ALPACA_API_KEY and ALPACA_SECRET_KEY must be set in .env for Alpaca provider',
        );
      }

      const engine = new AlpacaTradingEngine({
        apiKey,
        secretKey,
        paper: providerConfig.paper,
        allowedSymbols: config.securities.allowedSymbols,
      });

      await engine.init();

      return {
        engine,
        close: () => engine.close(),
      };
    }

    default:
      throw new Error(`Unknown securities provider: ${(providerConfig as { type: string }).type}`);
  }
}
