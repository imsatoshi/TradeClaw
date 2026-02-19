import { describe, it, expect, beforeEach } from 'vitest';
import { Sandbox } from './Sandbox';
import { MockDataProvider } from '../data/MockDataProvider';
import { SandboxConfig } from './interfaces';

describe('Sandbox', () => {
  let sandbox: Sandbox;
  let mockDataProvider: MockDataProvider;

  const createValidConfig = (
    overrides?: Partial<SandboxConfig>,
  ): SandboxConfig => ({
    timeframe: '1h',
    ...overrides,
  });

  beforeEach(() => {
    mockDataProvider = new MockDataProvider();
  });

  describe('constructor', () => {
    it('should create sandbox with valid config', () => {
      const config = createValidConfig();
      sandbox = new Sandbox(config, mockDataProvider, mockDataProvider);

      expect(sandbox).toBeDefined();
      expect(sandbox.getPlayheadTime()).toBeInstanceOf(Date);
    });

    it('should discover available symbols from data provider', () => {
      const config = createValidConfig();
      sandbox = new Sandbox(config, mockDataProvider, mockDataProvider);
      const symbols = sandbox.getAvailableSymbols();
      expect(symbols).toContain('BTC/USD');
      expect(symbols).toContain('ETH/USD');
    });

    it('should search symbols by asset name', () => {
      const config = createValidConfig();
      sandbox = new Sandbox(config, mockDataProvider, mockDataProvider);
      expect(sandbox.searchSymbols('BTC')).toEqual(['BTC/USD']);
      expect(sandbox.searchSymbols('btc')).toEqual(['BTC/USD']);
      expect(sandbox.searchSymbols('UNKNOWN')).toEqual([]);
    });
  });

  describe('playhead time', () => {
    beforeEach(() => {
      sandbox = new Sandbox(createValidConfig(), mockDataProvider, mockDataProvider);
    });

    it('should set and get playhead time', () => {
      const fixedTime = new Date('2025-06-01T12:00:00Z');
      sandbox.setPlayheadTime(fixedTime);
      expect(sandbox.getPlayheadTime()).toEqual(fixedTime);
    });

    it('should return a copy of playhead time', () => {
      const fixedTime = new Date('2025-06-01T12:00:00Z');
      sandbox.setPlayheadTime(fixedTime);

      const t1 = sandbox.getPlayheadTime();
      const t2 = sandbox.getPlayheadTime();
      expect(t1).toEqual(t2);
      expect(t1).not.toBe(t2); // different object
    });
  });

  describe('market data tools', () => {
    beforeEach(() => {
      sandbox = new Sandbox(createValidConfig(), mockDataProvider, mockDataProvider);
      sandbox.setPlayheadTime(new Date('2025-01-01T00:00:00Z'));
    });

    it('should get latest OHLCV data', async () => {
      const data = await sandbox.getLatestOHLCV(['BTC/USD']);

      expect(data).toHaveLength(1);
      expect(data[0]).toHaveProperty('symbol', 'BTC/USD');
      expect(data[0]).toHaveProperty('open');
      expect(data[0]).toHaveProperty('high');
      expect(data[0]).toHaveProperty('low');
      expect(data[0]).toHaveProperty('close');
      expect(data[0]).toHaveProperty('volume');
      expect(data[0]).toHaveProperty('interval', '1h');
    });

    it('should get available symbols from data provider', () => {
      const symbols = sandbox.getAvailableSymbols();
      expect(symbols).toContain('BTC/USD');
    });
  });

});
