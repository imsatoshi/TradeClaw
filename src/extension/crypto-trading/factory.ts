/**
 * Crypto Trading Engine Factory
 *
 * Instantiate the corresponding crypto trading engine provider based on config
 */

import type { ICryptoTradingEngine } from './interfaces.js';
import { CRYPTO_ALLOWED_SYMBOLS } from './interfaces.js';
import type { Config } from '../../core/config.js';
import { CcxtTradingEngine } from './providers/ccxt/index.js';
import { FreqtradeTradingEngine } from './providers/freqtrade/index.js';

export interface CryptoTradingEngineResult {
  engine: ICryptoTradingEngine;
  directExchangeEngine?: ICryptoTradingEngine; // CCXT direct — for stoploss/conditional orders
  isDryRun: boolean;
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

      console.log(`crypto trading engine: connected to ${providerConfig.exchange} (${providerConfig.defaultMarketType})`);

      return {
        engine,
        isDryRun: providerConfig.sandbox || providerConfig.demoTrading || false,
        close: () => engine.close(),
      };
    }

    case 'freqtrade': {
      // Environment variables override config file values (avoid hardcoded credentials)
      const ftUsername = process.env.FREQTRADE_USERNAME || providerConfig.username;
      const ftPassword = process.env.FREQTRADE_PASSWORD || providerConfig.password;

      if (!ftUsername || !ftPassword) {
        throw new Error(
          'Freqtrade credentials required: set FREQTRADE_USERNAME and FREQTRADE_PASSWORD in .env, or configure in crypto.json',
        );
      }

      const engine = new FreqtradeTradingEngine({
        url: providerConfig.url,
        username: ftUsername,
        password: ftPassword,
        defaultStakeAmount: providerConfig.defaultStakeAmount,
      });

      await engine.init();

      console.log(`crypto trading engine: connected to freqtrade at ${providerConfig.url}`);

      // Try to create direct exchange engine for stoploss/conditional orders
      let directEngine: ICryptoTradingEngine | undefined;
      const apiKey = process.env.EXCHANGE_API_KEY;
      const apiSecret = process.env.EXCHANGE_API_SECRET;
      if (apiKey && apiSecret) {
        try {
          // Use Freqtrade-synced whitelist (already populated by engine.init() above)
          const ccxt = new CcxtTradingEngine({
            exchange: 'binance',
            apiKey,
            apiSecret,
            sandbox: false,
            defaultMarketType: 'swap',
            allowedSymbols: [...CRYPTO_ALLOWED_SYMBOLS],
          });
          await ccxt.init();
          directEngine = ccxt;
          console.log('crypto trading engine: binance direct engine ready (for stoploss/conditional orders)');
        } catch (err) {
          console.warn('crypto trading engine: failed to init direct exchange engine, stoploss orders will fall back to freqtrade:', err);
        }
      }

      return {
        engine,
        directExchangeEngine: directEngine,
        isDryRun: engine.isDryRun,
        close: async () => {
          await engine.close();
          if (directEngine) await (directEngine as CcxtTradingEngine).close();
        },
      };
    }

    default:
      throw new Error(`Unknown crypto trading provider: ${(providerConfig as { type: string }).type}`);
  }
}
