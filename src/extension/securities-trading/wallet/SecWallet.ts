/**
 * Securities Wallet implementation
 *
 * Git-like state management, tracking securities trading operation history
 */

import { createHash } from 'crypto';
import type { ISecWallet, SecWalletConfig } from './interfaces';
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

function generateCommitHash(content: object): CommitHash {
  const hash = createHash('sha256')
    .update(JSON.stringify(content))
    .digest('hex');
  return hash.slice(0, 8);
}

export class SecWallet implements ISecWallet {
  private stagingArea: Operation[] = [];
  private pendingMessage: string | null = null;
  private pendingHash: CommitHash | null = null;
  private commits: WalletCommit[] = [];
  private head: CommitHash | null = null;
  private currentRound: number | undefined = undefined;
  private readonly config: SecWalletConfig;

  constructor(config: SecWalletConfig) {
    this.config = config;
  }

  // ==================== Git-style three-phase workflow ====================

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

    const stateAfter = await this.config.getWalletState();

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

    this.commits.push(commit);
    this.head = hash;

    await this.config.onCommit?.(this.exportState());

    this.stagingArea = [];
    this.pendingMessage = null;
    this.pendingHash = null;

    const filled = results.filter((r) => r.status === 'filled');
    const pending = results.filter((r) => r.status === 'pending');
    const rejected = results.filter(
      (r) => r.status === 'rejected' || !r.success,
    );

    return { hash, message, operationCount: operations.length, filled, pending, rejected };
  }

  // ==================== Queries ====================

  log(options: { limit?: number; symbol?: string } = {}): CommitLogEntry[] {
    const { limit = 10, symbol } = options;

    let commits = this.commits.slice().reverse();

    if (symbol) {
      commits = commits.filter((commit) =>
        commit.operations.some((op) => op.params.symbol === symbol),
      );
    }

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

  private buildOperationSummaries(
    commit: WalletCommit,
    filterSymbol?: string,
  ): OperationSummary[] {
    const summaries: OperationSummary[] = [];

    for (let i = 0; i < commit.operations.length; i++) {
      const op = commit.operations[i];
      const result = commit.results[i];
      const symbol = (op.params.symbol as string) || 'unknown';

      if (filterSymbol && symbol !== filterSymbol) {
        continue;
      }

      const change = this.formatOperationChange(op, result);
      summaries.push({ symbol, action: op.action, change, status: result?.status || 'rejected' });
    }

    return summaries;
  }

  private formatOperationChange(op: Operation, result?: OperationResult): string {
    const { action, params } = op;

    switch (action) {
      case 'placeOrder': {
        const side = params.side as string;
        const notional = params.notional as number | undefined;
        const qty = params.qty as number | undefined;
        const sizeStr = notional ? `$${notional}` : `${qty} shares`;

        if (result?.status === 'filled') {
          const price = result.filledPrice ? ` @$${result.filledPrice}` : '';
          return `${side} ${sizeStr}${price}`;
        }
        return `${side} ${sizeStr} (${result?.status || 'unknown'})`;
      }

      case 'closePosition': {
        const qty = params.qty as number | undefined;
        if (result?.status === 'filled') {
          const price = result.filledPrice ? ` @$${result.filledPrice}` : '';
          const qtyStr = qty ? ` (partial: ${qty})` : '';
          return `sold${qtyStr}${price}`;
        }
        return `sell (${result?.status || 'unknown'})`;
      }

      case 'cancelOrder': {
        return `cancelled order ${params.orderId}`;
      }

      case 'syncOrders': {
        const status = result?.status || 'unknown';
        const price = result?.filledPrice ? ` @$${result.filledPrice}` : '';
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
    return { commits: [...this.commits], head: this.head };
  }

  static restore(state: WalletExportState, config: SecWalletConfig): SecWallet {
    const wallet = new SecWallet(config);
    wallet.commits = [...state.commits];
    wallet.head = state.head;
    return wallet;
  }

  setCurrentRound(round: number): void {
    this.currentRound = round;
  }

  // ==================== Sync ====================

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
        filledQty: u.filledQty,
      })),
      stateAfter: currentState,
      timestamp: new Date().toISOString(),
      round: this.currentRound,
    };

    this.commits.push(commit);
    this.head = hash;

    await this.config.onCommit?.(this.exportState());

    return { hash, updatedCount: updates.length, updates };
  }

  getPendingOrderIds(): Array<{ orderId: string; symbol: string }> {
    const orderStatus = new Map<string, string>();

    for (let i = this.commits.length - 1; i >= 0; i--) {
      for (const result of this.commits[i].results) {
        if (result.orderId && !orderStatus.has(result.orderId)) {
          orderStatus.set(result.orderId, result.status);
        }
      }
    }

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

  async simulatePriceChange(
    priceChanges: PriceChangeInput[],
  ): Promise<SimulatePriceChangeResult> {
    const state = await this.config.getWalletState();
    const { holdings, equity, unrealizedPnL, cash } = state;

    const currentTotalPnL =
      cash > 0 ? ((equity - cash) / cash) * 100 : 0;

    if (holdings.length === 0) {
      return {
        success: true,
        currentState: { equity, unrealizedPnL, totalPnL: currentTotalPnL, holdings: [] },
        simulatedState: { equity, unrealizedPnL, totalPnL: currentTotalPnL, holdings: [] },
        summary: {
          totalPnLChange: 0,
          equityChange: 0,
          equityChangePercent: '0.0%',
          worstCase: 'No holdings to simulate.',
        },
      };
    }

    const priceMap = new Map<string, number>();

    for (const { symbol, change } of priceChanges) {
      const parsed = this.parsePriceChange(change);
      if (!parsed.success) {
        return {
          success: false,
          error: `Invalid change format for ${symbol}: "${change}". Use "@150" for absolute or "+10%" / "-5%" for relative.`,
          currentState: { equity, unrealizedPnL, totalPnL: currentTotalPnL, holdings: [] },
          simulatedState: { equity, unrealizedPnL, totalPnL: currentTotalPnL, holdings: [] },
          summary: { totalPnLChange: 0, equityChange: 0, equityChangePercent: '0.0%', worstCase: '' },
        };
      }

      if (symbol === 'all') {
        for (const h of holdings) {
          priceMap.set(h.symbol, this.applyPriceChange(h.currentPrice, parsed.type, parsed.value));
        }
      } else {
        const h = holdings.find((p) => p.symbol === symbol);
        if (h) {
          priceMap.set(symbol, this.applyPriceChange(h.currentPrice, parsed.type, parsed.value));
        }
      }
    }

    const currentHoldings = holdings.map((h) => ({
      symbol: h.symbol,
      side: h.side,
      qty: h.qty,
      avgEntryPrice: h.avgEntryPrice,
      currentPrice: h.currentPrice,
      unrealizedPnL: h.unrealizedPnL,
      marketValue: h.marketValue,
    }));

    let simulatedUnrealizedPnL = 0;
    const simulatedHoldings = holdings.map((h) => {
      const simulatedPrice = priceMap.get(h.symbol) ?? h.currentPrice;
      const priceChange = simulatedPrice - h.currentPrice;
      const priceChangePercent =
        h.currentPrice > 0 ? (priceChange / h.currentPrice) * 100 : 0;

      const newUnrealizedPnL =
        h.side === 'long'
          ? (simulatedPrice - h.avgEntryPrice) * h.qty
          : (h.avgEntryPrice - simulatedPrice) * h.qty;

      const pnlChange = newUnrealizedPnL - h.unrealizedPnL;
      simulatedUnrealizedPnL += newUnrealizedPnL;

      return {
        symbol: h.symbol,
        side: h.side,
        qty: h.qty,
        avgEntryPrice: h.avgEntryPrice,
        simulatedPrice,
        unrealizedPnL: newUnrealizedPnL,
        marketValue: simulatedPrice * h.qty,
        pnlChange,
        priceChangePercent: `${priceChangePercent >= 0 ? '+' : ''}${priceChangePercent.toFixed(2)}%`,
      };
    });

    const pnlDiff = simulatedUnrealizedPnL - unrealizedPnL;
    const simulatedEquity = equity + pnlDiff;
    const simulatedTotalPnL =
      cash > 0 ? ((simulatedEquity - cash) / cash) * 100 : 0;
    const equityChangePercent = equity > 0 ? (pnlDiff / equity) * 100 : 0;

    const worstHolding = simulatedHoldings.reduce(
      (worst, h) => (h.pnlChange < worst.pnlChange ? h : worst),
      simulatedHoldings[0],
    );

    const worstCase =
      worstHolding.pnlChange < 0
        ? `${worstHolding.symbol} would lose $${Math.abs(worstHolding.pnlChange).toFixed(2)} (${worstHolding.priceChangePercent})`
        : 'All holdings would profit or break even.';

    return {
      success: true,
      currentState: { equity, unrealizedPnL, totalPnL: currentTotalPnL, holdings: currentHoldings },
      simulatedState: {
        equity: simulatedEquity,
        unrealizedPnL: simulatedUnrealizedPnL,
        totalPnL: simulatedTotalPnL,
        holdings: simulatedHoldings,
      },
      summary: {
        totalPnLChange: pnlDiff,
        equityChange: pnlDiff,
        equityChangePercent: `${equityChangePercent >= 0 ? '+' : ''}${equityChangePercent.toFixed(2)}%`,
        worstCase,
      },
    };
  }

  private parsePriceChange(
    change: string,
  ):
    | { success: true; type: 'absolute' | 'relative'; value: number }
    | { success: false } {
    const trimmed = change.trim();

    if (trimmed.startsWith('@')) {
      const value = parseFloat(trimmed.slice(1));
      if (isNaN(value) || value <= 0) return { success: false };
      return { success: true, type: 'absolute', value };
    }

    if (trimmed.endsWith('%')) {
      const value = parseFloat(trimmed.slice(0, -1));
      if (isNaN(value)) return { success: false };
      return { success: true, type: 'relative', value };
    }

    return { success: false };
  }

  private applyPriceChange(
    currentPrice: number,
    type: 'absolute' | 'relative',
    value: number,
  ): number {
    return type === 'absolute' ? value : currentPrice * (1 + value / 100);
  }

  // ==================== Internal methods ====================

  private parseOperationResult(op: Operation, raw: unknown): OperationResult {
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
      return { action: op.action, success: true, status: 'filled', raw };
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
      filledQty: isFilled
        ? ((order.filledQty ?? order.qty) as number)
        : undefined,
      raw,
    };
  }
}
