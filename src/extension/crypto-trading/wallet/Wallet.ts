/**
 * Wallet implementation
 *
 * Git-like wallet state management, tracking trading operation history
 */

import { createHash } from 'crypto';
import type { IWallet, WalletConfig } from './interfaces';
import type {
  CommitHash,
  Operation,
  OperationResult,
  AddResult,
  CommitPrepareResult,
  PushResult,
  WalletStatus,
  WalletCommit,
  WalletState,
  CommitLogEntry,
  WalletExportState,
  OperationSummary,
  PriceChangeInput,
  SimulatePriceChangeResult,
  OrderStatusUpdate,
  SyncResult,
} from './types';

/**
 * Generate Commit Hash
 *
 * Uses SHA-256 to hash the content, taking the first 8 characters
 */
function generateCommitHash(content: object): CommitHash {
  const hash = createHash('sha256')
    .update(JSON.stringify(content))
    .digest('hex');
  return hash.slice(0, 8);
}

/**
 * Wallet - Git-like wallet state management
 *
 * Usage:
 * 1. add() to stage operations
 * 2. commit() to add a message
 * 3. push() to execute and record
 */
export class Wallet implements IWallet {
  // Staging area
  private stagingArea: Operation[] = [];
  private pendingMessage: string | null = null;
  private pendingHash: CommitHash | null = null;

  // History
  private commits: WalletCommit[] = [];
  private head: CommitHash | null = null;

  // Current round
  private currentRound: number | undefined = undefined;

  // Configuration
  private readonly config: WalletConfig;

  constructor(config: WalletConfig) {
    this.config = config;
  }

  // ==================== Git three-stage ====================

  add(operation: Operation): AddResult {
    this.stagingArea.push(operation);
    return {
      staged: true,
      index: this.stagingArea.length - 1,
      operation,
    };
  }

  commit(message: string): CommitPrepareResult {
    if (this.stagingArea.length === 0) {
      throw new Error('Nothing to commit: staging area is empty');
    }

    // Pre-generate hash (based on message + operations + timestamp)
    const timestamp = new Date().toISOString();
    this.pendingHash = generateCommitHash({
      message,
      operations: this.stagingArea,
      timestamp,
      parentHash: this.head,
    });
    this.pendingMessage = message;

    return {
      prepared: true,
      hash: this.pendingHash,
      message,
      operationCount: this.stagingArea.length,
    };
  }

  async push(): Promise<PushResult> {
    if (this.stagingArea.length === 0) {
      throw new Error('Nothing to push: staging area is empty');
    }

    if (this.pendingMessage === null || this.pendingHash === null) {
      throw new Error('Nothing to push: please commit first');
    }

    const operations = [...this.stagingArea];
    const message = this.pendingMessage;
    const hash = this.pendingHash;

    // Execute all operations
    const results: OperationResult[] = [];
    for (const op of operations) {
      try {
        const raw = await this.config.executeOperation(op);
        const result = this.parseOperationResult(op, raw);
        results.push(result);
      } catch (error) {
        results.push({
          action: op.action,
          success: false,
          status: 'rejected',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Get current wallet state
    const stateAfter = await this.config.getWalletState();

    // Create commit
    const commit: WalletCommit = {
      hash,
      parentHash: this.head,
      message,
      operations,
      results,
      stateAfter,
      timestamp: new Date().toISOString(),
      round: this.currentRound,
    };

    // Update history
    this.commits.push(commit);
    this.head = hash;

    // Persist
    await this.config.onCommit?.(this.exportState());

    // Clear staging area
    this.stagingArea = [];
    this.pendingMessage = null;
    this.pendingHash = null;

    // Categorize results
    const filled = results.filter((r) => r.status === 'filled');
    const pending = results.filter((r) => r.status === 'pending');
    const rejected = results.filter(
      (r) => r.status === 'rejected' || !r.success,
    );

    return {
      hash,
      message,
      operationCount: operations.length,
      filled,
      pending,
      rejected,
    };
  }

  // ==================== Query ====================

  /**
   * View commit history (similar to git log --stat)
   *
   * @param options.limit - Number of commits to return (default 10)
   * @param options.symbol - Filter commits by symbol (similar to git log -- file)
   */
  log(options: { limit?: number; symbol?: string } = {}): CommitLogEntry[] {
    const { limit = 10, symbol } = options;

    // From newest to oldest
    let commits = this.commits.slice().reverse();

    // If a symbol is specified, only keep commits containing that symbol
    if (symbol) {
      commits = commits.filter((commit) =>
        commit.operations.some((op) => op.params.symbol === symbol),
      );
    }

    // Limit count
    commits = commits.slice(0, limit);

    return commits.map((commit) => ({
      hash: commit.hash,
      parentHash: commit.parentHash,
      message: commit.message,
      timestamp: commit.timestamp,
      round: commit.round,
      operations: this.buildOperationSummaries(commit, symbol),
    }));
  }

  /**
   * Build operation summaries (similar to file changes in git log --stat)
   */
  private buildOperationSummaries(
    commit: WalletCommit,
    filterSymbol?: string,
  ): OperationSummary[] {
    const summaries: OperationSummary[] = [];

    for (let i = 0; i < commit.operations.length; i++) {
      const op = commit.operations[i];
      const result = commit.results[i];
      const symbol = (op.params.symbol as string) || 'unknown';

      // If symbol filter is specified, skip non-matching entries
      if (filterSymbol && symbol !== filterSymbol) {
        continue;
      }

      const change = this.formatOperationChange(op, result);
      summaries.push({
        symbol,
        action: op.action,
        change,
        status: result?.status || 'rejected',
      });
    }

    return summaries;
  }

  /**
   * Format operation change description
   */
  private formatOperationChange(op: Operation, result?: OperationResult): string {
    const { action, params } = op;

    switch (action) {
      case 'placeOrder': {
        const side = params.side as string;
        const usdSize = params.usd_size as number | undefined;
        const size = params.size as number | undefined;
        const sizeStr = usdSize ? `$${usdSize}` : `${size}`;
        const direction = side === 'buy' ? 'long' : 'short';

        if (result?.status === 'filled') {
          const price = result.filledPrice ? ` @${result.filledPrice}` : '';
          return `${direction} +${sizeStr}${price}`;
        }
        return `${direction} +${sizeStr} (${result?.status || 'unknown'})`;
      }

      case 'closePosition': {
        const size = params.size as number | undefined;
        if (result?.status === 'filled') {
          const price = result.filledPrice ? ` @${result.filledPrice}` : '';
          const sizeStr = size ? ` (partial: ${size})` : '';
          return `closed${sizeStr}${price}`;
        }
        return `close (${result?.status || 'unknown'})`;
      }

      case 'cancelOrder': {
        return `cancelled order ${params.orderId}`;
      }

      case 'adjustLeverage': {
        const newLev = params.newLeverage as number;
        return `leverage → ${newLev}x`;
      }

      case 'syncOrders': {
        const status = result?.status || 'unknown';
        const price = result?.filledPrice ? ` @${result.filledPrice}` : '';
        return `synced → ${status}${price}`;
      }

      default:
        return `${action}`;
    }
  }

  show(hash: CommitHash): WalletCommit | null {
    return this.commits.find((c) => c.hash === hash) ?? null;
  }

  status(): WalletStatus {
    return {
      staged: [...this.stagingArea],
      pendingMessage: this.pendingMessage,
      head: this.head,
      commitCount: this.commits.length,
    };
  }

  // ==================== Serialization ====================

  exportState(): WalletExportState {
    return {
      commits: [...this.commits],
      head: this.head,
    };
  }

  /**
   * Restore Wallet from exported state
   */
  static restore(state: WalletExportState, config: WalletConfig): Wallet {
    const wallet = new Wallet(config);
    wallet.commits = [...state.commits];
    wallet.head = state.head;
    return wallet;
  }

  setCurrentRound(round: number): void {
    this.currentRound = round;
  }

  // ==================== Sync ====================

  /**
   * Fetch latest order statuses from exchange and record changes (similar to git pull)
   *
   * Bypasses the staging area to directly create a sync commit
   */
  async sync(updates: OrderStatusUpdate[], currentState: WalletState): Promise<SyncResult> {
    if (updates.length === 0) {
      return { hash: this.head ?? '', updatedCount: 0, updates: [] };
    }

    const hash = generateCommitHash({
      updates,
      timestamp: new Date().toISOString(),
      parentHash: this.head,
    });

    const commit: WalletCommit = {
      hash,
      parentHash: this.head,
      message: `[sync] ${updates.length} order(s) updated`,
      operations: [{ action: 'syncOrders', params: { orderIds: updates.map(u => u.orderId) } }],
      results: updates.map(u => ({
        action: 'syncOrders' as const,
        success: true,
        orderId: u.orderId,
        status: u.currentStatus,
        filledPrice: u.filledPrice,
        filledSize: u.filledSize,
      })),
      stateAfter: currentState,
      timestamp: new Date().toISOString(),
      round: this.currentRound,
    };

    this.commits.push(commit);
    this.head = hash;

    // Persist
    await this.config.onCommit?.(this.exportState());

    return { hash, updatedCount: updates.length, updates };
  }

  /**
   * Get all order IDs that are still in pending status
   *
   * Scans commit history from newest to oldest, finding pending orders not updated by subsequent syncs
   */
  getPendingOrderIds(): Array<{ orderId: string; symbol: string }> {
    // Scan from newest to oldest, recording the latest known status of each orderId
    const orderStatus = new Map<string, string>();

    for (let i = this.commits.length - 1; i >= 0; i--) {
      for (const result of this.commits[i].results) {
        if (result.orderId && !orderStatus.has(result.orderId)) {
          orderStatus.set(result.orderId, result.status);
        }
      }
    }

    // Find orders that are still pending
    const pending: Array<{ orderId: string; symbol: string }> = [];
    const seen = new Set<string>();

    for (const commit of this.commits) {
      for (let j = 0; j < commit.results.length; j++) {
        const result = commit.results[j];
        if (
          result.orderId &&
          !seen.has(result.orderId) &&
          orderStatus.get(result.orderId) === 'pending'
        ) {
          const symbol = (commit.operations[j]?.params?.symbol as string) ?? 'unknown';
          pending.push({ orderId: result.orderId, symbol });
          seen.add(result.orderId);
        }
      }
    }

    return pending;
  }

  // ==================== Simulation ====================

  /**
   * Simulate the impact of price changes on the portfolio (Dry Run)
   */
  async simulatePriceChange(
    priceChanges: PriceChangeInput[],
  ): Promise<SimulatePriceChangeResult> {
    // Get current state
    const state = await this.config.getWalletState();
    const { positions, equity, unrealizedPnL, balance } = state;

    // Calculate current totalPnL
    const currentTotalPnL =
      balance > 0 ? ((equity - balance) / balance) * 100 : 0;

    if (positions.length === 0) {
      return {
        success: true,
        currentState: {
          equity,
          unrealizedPnL,
          totalPnL: currentTotalPnL,
          positions: [],
        },
        simulatedState: {
          equity,
          unrealizedPnL,
          totalPnL: currentTotalPnL,
          positions: [],
        },
        summary: {
          totalPnLChange: 0,
          equityChange: 0,
          equityChangePercent: '0.0%',
          worstCase: 'No positions to simulate.',
        },
      };
    }

    // Parse price changes
    const priceMap = new Map<string, number>(); // symbol -> new price

    for (const { symbol, change } of priceChanges) {
      const parsed = this.parsePriceChange(change);
      if (!parsed.success) {
        return {
          success: false,
          error: `Invalid change format for ${symbol}: "${change}". Use "@88000" for absolute or "+10%" / "-5%" for relative.`,
          currentState: {
            equity,
            unrealizedPnL,
            totalPnL: currentTotalPnL,
            positions: [],
          },
          simulatedState: {
            equity,
            unrealizedPnL,
            totalPnL: currentTotalPnL,
            positions: [],
          },
          summary: {
            totalPnLChange: 0,
            equityChange: 0,
            equityChangePercent: '0.0%',
            worstCase: '',
          },
        };
      }

      if (symbol === 'all') {
        // Apply to all positions
        for (const pos of positions) {
          const newPrice = this.applyPriceChange(
            pos.markPrice,
            parsed.type,
            parsed.value,
          );
          priceMap.set(pos.symbol, newPrice);
        }
      } else {
        // Apply to the specified trading pair
        const pos = positions.find((p) => p.symbol === symbol);
        if (pos) {
          const newPrice = this.applyPriceChange(
            pos.markPrice,
            parsed.type,
            parsed.value,
          );
          priceMap.set(symbol, newPrice);
        }
      }
    }

    // Calculate current state
    const currentPositions = positions.map((pos) => ({
      symbol: pos.symbol,
      side: pos.side,
      size: pos.size,
      entryPrice: pos.entryPrice,
      currentPrice: pos.markPrice,
      unrealizedPnL: pos.unrealizedPnL,
      positionValue: pos.positionValue,
    }));

    // Calculate simulated state
    let simulatedUnrealizedPnL = 0;
    const simulatedPositions = positions.map((pos) => {
      const simulatedPrice = priceMap.get(pos.symbol) ?? pos.markPrice;
      const priceChange = simulatedPrice - pos.markPrice;
      const priceChangePercent =
        pos.markPrice > 0 ? (priceChange / pos.markPrice) * 100 : 0;

      // Calculate new unrealized PnL
      // Long: (newPrice - entryPrice) * size
      // Short: (entryPrice - newPrice) * size
      const newUnrealizedPnL =
        pos.side === 'long'
          ? (simulatedPrice - pos.entryPrice) * pos.size
          : (pos.entryPrice - simulatedPrice) * pos.size;

      const pnlChange = newUnrealizedPnL - pos.unrealizedPnL;
      simulatedUnrealizedPnL += newUnrealizedPnL;

      return {
        symbol: pos.symbol,
        side: pos.side,
        size: pos.size,
        entryPrice: pos.entryPrice,
        simulatedPrice,
        unrealizedPnL: newUnrealizedPnL,
        positionValue: simulatedPrice * pos.size,
        pnlChange,
        priceChangePercent: `${priceChangePercent >= 0 ? '+' : ''}${priceChangePercent.toFixed(2)}%`,
      };
    });

    // Calculate simulated account state
    const pnlDiff = simulatedUnrealizedPnL - unrealizedPnL;
    const simulatedEquity = equity + pnlDiff;
    const simulatedTotalPnL =
      balance > 0 ? ((simulatedEquity - balance) / balance) * 100 : 0;

    const equityChangePercent = equity > 0 ? (pnlDiff / equity) * 100 : 0;

    // Find the position with the largest loss
    const worstPosition = simulatedPositions.reduce(
      (worst, pos) => (pos.pnlChange < worst.pnlChange ? pos : worst),
      simulatedPositions[0],
    );

    const worstCase =
      worstPosition.pnlChange < 0
        ? `${worstPosition.symbol} would lose $${Math.abs(worstPosition.pnlChange).toFixed(2)} (${worstPosition.priceChangePercent})`
        : 'All positions would profit or break even.';

    return {
      success: true,
      currentState: {
        equity,
        unrealizedPnL,
        totalPnL: currentTotalPnL,
        positions: currentPositions,
      },
      simulatedState: {
        equity: simulatedEquity,
        unrealizedPnL: simulatedUnrealizedPnL,
        totalPnL: simulatedTotalPnL,
        positions: simulatedPositions,
      },
      summary: {
        totalPnLChange: pnlDiff,
        equityChange: pnlDiff,
        equityChangePercent: `${equityChangePercent >= 0 ? '+' : ''}${equityChangePercent.toFixed(2)}%`,
        worstCase,
      },
    };
  }

  /**
   * Parse price change string
   */
  private parsePriceChange(
    change: string,
  ):
    | { success: true; type: 'absolute' | 'relative'; value: number }
    | { success: false } {
    const trimmed = change.trim();

    // Absolute value: @88000
    if (trimmed.startsWith('@')) {
      const value = parseFloat(trimmed.slice(1));
      if (isNaN(value) || value <= 0) {
        return { success: false };
      }
      return { success: true, type: 'absolute', value };
    }

    // Relative value: +10% or -5%
    if (trimmed.endsWith('%')) {
      const valueStr = trimmed.slice(0, -1);
      const value = parseFloat(valueStr);
      if (isNaN(value)) {
        return { success: false };
      }
      return { success: true, type: 'relative', value };
    }

    return { success: false };
  }

  /**
   * Apply price change
   */
  private applyPriceChange(
    currentPrice: number,
    type: 'absolute' | 'relative',
    value: number,
  ): number {
    if (type === 'absolute') {
      return value;
    } else {
      // relative: +10% means 1.1x, -5% means 0.95x
      return currentPrice * (1 + value / 100);
    }
  }

  // ==================== Internal methods ====================

  /**
   * Parse operation execution result
   *
   * Converts the raw result returned by the engine into a standardized OperationResult
   */
  private parseOperationResult(op: Operation, raw: unknown): OperationResult {
    // raw is the result returned by TradingEngine, format similar to:
    // { success: true, order: { id, status, filledPrice, ... } }
    // or { success: false, error: '...' }

    const rawObj = raw as Record<string, unknown>;

    if (!rawObj || typeof rawObj !== 'object') {
      return {
        action: op.action,
        success: false,
        status: 'rejected',
        error: 'Invalid response from trading engine',
        raw,
      };
    }

    const success = rawObj.success === true;
    const order = rawObj.order as Record<string, unknown> | undefined;

    if (!success) {
      return {
        action: op.action,
        success: false,
        status: 'rejected',
        error: (rawObj.error as string) ?? 'Unknown error',
        raw,
      };
    }

    if (!order) {
      // Some operations may not have an order (e.g. adjustLeverage)
      return {
        action: op.action,
        success: true,
        status: 'filled',
        raw,
      };
    }

    const status = order.status as string;
    const isFilled = status === 'filled';
    const isPending = status === 'pending';

    return {
      action: op.action,
      success: true,
      orderId: order.id as string | undefined,
      status: isFilled ? 'filled' : isPending ? 'pending' : 'rejected',
      filledPrice: isFilled ? (order.filledPrice as number) : undefined,
      filledSize: isFilled
        ? ((order.filledQuantity ?? order.size) as number)
        : undefined,
      raw,
    };
  }
}
