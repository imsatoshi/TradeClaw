/**
 * Symbol bidirectional mapping
 *
 * Internal symbol ("BTC/USD") <-> CCXT symbol ("BTC/USDT:USDT")
 *
 * Automatically discovers the best match from exchange.loadMarkets() results
 */

interface MarketInfo {
  symbol: string;
  base: string;
  quote: string;
  type: string; // 'spot' | 'swap' | 'future' | 'option'
  settle?: string;
  active?: boolean;
  precision?: {
    price?: number;
    amount?: number;
  };
}

export class SymbolMapper {
  private internalToCcxt = new Map<string, string>();
  private ccxtToInternal = new Map<string, string>();
  private precisionMap = new Map<string, { price: number; amount: number }>();

  constructor(
    private allowedSymbols: string[],
    private defaultMarketType: 'spot' | 'swap',
  ) {}

  /**
   * Initialize mapping from ccxt exchange.markets
   */
  init(markets: Record<string, MarketInfo>): void {
    for (const internalSymbol of this.allowedSymbols) {
      const base = internalSymbol.split('/')[0];
      if (!base) continue;

      const ccxtSymbol = this.findBestMatch(base, markets);
      if (!ccxtSymbol) {
        // Skip if no match found; don't block other symbols
        continue;
      }

      this.internalToCcxt.set(internalSymbol, ccxtSymbol);
      this.ccxtToInternal.set(ccxtSymbol, internalSymbol);

      const market = markets[ccxtSymbol];
      if (market?.precision) {
        this.precisionMap.set(internalSymbol, {
          price: market.precision.price ?? 2,
          amount: market.precision.amount ?? 8,
        });
      }
    }
  }

  /**
   * Find the best ccxt market for a given base asset
   *
   * Priority (defaultMarketType = 'swap'):
   * 1. swap USDT-settled: "BTC/USDT:USDT"
   * 2. swap USD-settled:  "BTC/USD:USD"
   * 3. spot USDT:         "BTC/USDT"
   * 4. spot USD:          "BTC/USD"
   *
   * Reversed when defaultMarketType = 'spot'
   */
  private findBestMatch(
    base: string,
    markets: Record<string, MarketInfo>,
  ): string | null {
    const candidates: Array<{ symbol: string; priority: number }> = [];

    for (const [symbol, market] of Object.entries(markets)) {
      if (market.base !== base) continue;
      if (market.active === false) continue;

      const isSwap = market.type === 'swap' || market.type === 'future';
      const isSpot = market.type === 'spot';
      const isUsdt = market.quote === 'USDT' || market.settle === 'USDT';
      const isUsd = market.quote === 'USD' || market.settle === 'USD';

      if (!isSwap && !isSpot) continue;
      if (!isUsdt && !isUsd) continue;

      let priority: number;
      if (this.defaultMarketType === 'swap') {
        if (isSwap && isUsdt) priority = 0;
        else if (isSwap && isUsd) priority = 1;
        else if (isSpot && isUsdt) priority = 2;
        else priority = 3;
      } else {
        if (isSpot && isUsdt) priority = 0;
        else if (isSpot && isUsd) priority = 1;
        else if (isSwap && isUsdt) priority = 2;
        else priority = 3;
      }

      candidates.push({ symbol, priority });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.priority - b.priority);
    return candidates[0].symbol;
  }

  /** Internal "BTC/USD" → CCXT "BTC/USDT:USDT" */
  toCcxt(internalSymbol: string): string {
    const ccxt = this.internalToCcxt.get(internalSymbol);
    if (!ccxt) {
      throw new Error(`No CCXT mapping for symbol: ${internalSymbol}`);
    }
    return ccxt;
  }

  /** CCXT "BTC/USDT:USDT" → Internal "BTC/USD" */
  toInternal(ccxtSymbol: string): string {
    const internal = this.ccxtToInternal.get(ccxtSymbol);
    if (!internal) {
      throw new Error(`No internal mapping for CCXT symbol: ${ccxtSymbol}`);
    }
    return internal;
  }

  /** Attempt conversion; returns null if no mapping exists */
  tryToInternal(ccxtSymbol: string): string | null {
    return this.ccxtToInternal.get(ccxtSymbol) ?? null;
  }

  /** Get symbol precision */
  getPrecision(internalSymbol: string): { price: number; amount: number } {
    return this.precisionMap.get(internalSymbol) ?? { price: 2, amount: 8 };
  }

  /** Get all mapped internal symbols */
  getMappedSymbols(): string[] {
    return [...this.internalToCcxt.keys()];
  }
}
