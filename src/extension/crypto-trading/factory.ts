/**
 * Crypto Trading Engine Factory
 *
 * Instantiate the corresponding crypto trading engine provider based on config
 */

import type { ICryptoTradingEngine } from './interfaces.js';
import type { Config } from '../../core/config.js';
import { CcxtTradingEngine } from './providers/ccxt/index.js';

export interface CryptoTradingEngineResult {
  engine: ICryptoTradingEngine;
  close: () => Promise<void>;
}

/**
 * Create a crypto trading engine
 *
 * @returns engine instance, or null (provider = 'none')
 */
export async function createCryptoTradingEngine(
  config: Config,
): Promise<CryptoTradingEngineResult | null> {
  const providerConfig = config.crypto.provider;

  switch (providerConfig.type) {
    case 'none':
      return null;

    case 'ccxt': {
      const apiKey = process.env.EXCHANGE_API_KEY;
      const apiSecret = process.env.EXCHANGE_API_SECRET;
      const password = process.env.EXCHANGE_PASSWORD;

      if (!apiKey || !apiSecret) {
        throw new Error(
          'EXCHANGE_API_KEY and EXCHANGE_API_SECRET must be set in .env for CCXT provider',
        );
      }

      const engine = new CcxtTradingEngine({
        exchange: providerConfig.exchange,
        apiKey,
        apiSecret,
        password,
        sandbox: providerConfig.sandbox,
        demoTrading: providerConfig.demoTrading,
        defaultMarketType: providerConfig.defaultMarketType,
        allowedSymbols: config.crypto.allowedSymbols,
        options: providerConfig.options,
      });

      await engine.init();

      return {
        engine,
        close: () => engine.close(),
      };
    }

    default:
      throw new Error(`Unknown crypto trading provider: ${(providerConfig as { type: string }).type}`);
  }
}
