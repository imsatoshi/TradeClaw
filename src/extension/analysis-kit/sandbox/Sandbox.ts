import {
  SandboxConfig,
} from './interfaces';
import {
  IMarketDataProvider,
  INewsProvider,
  NewsItem,
  GetNewsV2Options,
} from '../data/interfaces';
/**
 * Analysis sandbox (data access + cognitive state)
 *
 * Core responsibilities:
 * 1. Maintains playheadTime -- current data timestamp, updated externally via setPlayheadTime()
 * 2. Provides market data, news, and cognition (frontal lobe) interfaces
 *
 * Not responsible for: trade execution (ITradingEngine), operation tracking (IWallet)
 */
export class Sandbox {
  private playheadTime: Date;
  private config: SandboxConfig;
  readonly marketDataProvider: IMarketDataProvider;
  readonly newsProvider: INewsProvider;

  constructor(
    config: SandboxConfig,
    marketDataProvider: IMarketDataProvider,
    newsProvider: INewsProvider,
  ) {
    this.config = config;
    this.playheadTime = new Date();
    this.marketDataProvider = marketDataProvider;
    this.newsProvider = newsProvider;
  }

  // ==================== Time management ====================

  getPlayheadTime(): Date {
    return new Date(this.playheadTime);
  }

  setPlayheadTime(time: Date): void {
    this.playheadTime = new Date(time);
  }

  // ==================== Market data ====================

  /**
   * Batch fetch the latest OHLCV candlesticks
   */
  async getLatestOHLCV(symbols: string[]) {
    return await Promise.all(
      symbols.map(async (symbol) => {
        const marketData = await this.marketDataProvider.getMarketData(
          this.playheadTime,
          symbol,
        );
        return { ...marketData, interval: this.config.timeframe };
      }),
    );
  }

  async getNewsV2(options: Omit<GetNewsV2Options, 'endTime'>): Promise<NewsItem[]> {
    return await this.newsProvider.getNewsV2({
      ...options,
      endTime: this.playheadTime,
    });
  }

  /**
   * Return all available symbols in the dataset (asset/currency format)
   */
  getAvailableSymbols(): string[] {
    return this.marketDataProvider.getAvailableSymbols();
  }

  /**
   * Search symbols by asset name
   * e.g. "BTC" -> ["BTC/USD"], "BTC/USD" -> ["BTC/USD"]
   */
  searchSymbols(query: string): string[] {
    const q = query.toUpperCase();
    return this.marketDataProvider.getAvailableSymbols().filter(s => {
      const asset = s.split('/')[0];
      return asset === q || s === q;
    });
  }

  // ==================== Utility methods ====================

  /**
   * Calculate the start time for looking back N candlesticks based on lookback
   */
  calculatePreviousTime(lookback: number): Date {
    const timeframe = this.config.timeframe;
    const startTime = new Date(this.playheadTime);

    if (timeframe.endsWith('d')) {
      const days = parseInt(timeframe.replace('d', ''));
      startTime.setDate(startTime.getDate() - lookback * days);
    } else if (timeframe.endsWith('h')) {
      const hours = parseInt(timeframe.replace('h', ''));
      startTime.setHours(startTime.getHours() - lookback * hours);
    } else if (timeframe.endsWith('m')) {
      const minutes = parseInt(timeframe.replace('m', ''));
      startTime.setMinutes(startTime.getMinutes() - lookback * minutes);
    } else {
      throw new Error(`Unsupported timeframe: ${timeframe}`);
    }

    return startTime;
  }
}
