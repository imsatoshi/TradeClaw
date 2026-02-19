/**
 * Wallet type definitions
 *
 * Git-like wallet state management for tracking trading operation history
 */

import type { CryptoPosition, CryptoOrder } from '../interfaces';

// ==================== Commit Hash ====================

/** Commit Hash - 8-character short hash, used for indexing */
export type CommitHash = string;

// ==================== Operation ====================

/** Supported operation types */
export type OperationAction =
  | 'placeOrder'
  | 'closePosition'
  | 'cancelOrder'
  | 'adjustLeverage'
  | 'syncOrders';

/** Staged operation */
export interface Operation {
  action: OperationAction;
  params: Record<string, unknown>;
}

// ==================== Operation Result ====================

/** Operation execution status */
export type OperationStatus = 'filled' | 'pending' | 'rejected' | 'cancelled';

/** Operation execution result */
export interface OperationResult {
  action: OperationAction;
  success: boolean;
  orderId?: string;
  status: OperationStatus;
  // Fill information (when filled)
  filledPrice?: number;
  filledSize?: number;
  // Error information (when rejected)
  error?: string;
  // Raw response (preserves complete information)
  raw?: unknown;
}

// ==================== Wallet State ====================

/** Wallet state snapshot */
export interface WalletState {
  balance: number;
  equity: number;
  unrealizedPnL: number;
  realizedPnL: number;
  positions: CryptoPosition[];
  pendingOrders: CryptoOrder[];
}

// ==================== Wallet Commit ====================

/** Wallet Commit - Complete record of a single commit */
export interface WalletCommit {
  // Identifiers
  hash: CommitHash;
  parentHash: CommitHash | null;

  // Content
  message: string;
  operations: Operation[];
  results: OperationResult[];

  // State snapshot (wallet state after commit)
  stateAfter: WalletState;

  // Metadata
  timestamp: string; // ISO timestamp
  round?: number; // Associated round (optional)
}

// ==================== API Results ====================

/** add() return value */
export interface AddResult {
  staged: true;
  index: number;
  operation: Operation;
}

/** commit() return value */
export interface CommitPrepareResult {
  prepared: true;
  hash: CommitHash; // Pre-generated hash
  message: string;
  operationCount: number;
}

/** push() return value */
export interface PushResult {
  hash: CommitHash;
  message: string;
  operationCount: number;
  filled: OperationResult[];
  pending: OperationResult[];
  rejected: OperationResult[];
}

/** status() return value */
export interface WalletStatus {
  staged: Operation[];
  pendingMessage: string | null;
  head: CommitHash | null;
  commitCount: number;
}

/** Operation summary (similar to file changes in git log --stat) */
export interface OperationSummary {
  symbol: string;
  action: OperationAction;
  /** Change description, e.g. "long +$1000" or "closed (pnl: +$50)" */
  change: string;
  /** Execution status */
  status: OperationStatus;
}

/** Commit info returned by log() (with operation summaries) */
export interface CommitLogEntry {
  hash: CommitHash;
  parentHash: CommitHash | null;
  message: string;
  timestamp: string;
  round?: number;
  /** List of operation summaries (similar to git log --stat) */
  operations: OperationSummary[];
}

// ==================== Export State ====================

/** Wallet export state (saved to snapshot) */
export interface WalletExportState {
  commits: WalletCommit[];
  head: CommitHash | null;
}

// ==================== Sync ====================

/** Order status update (used by walletSync) */
export interface OrderStatusUpdate {
  orderId: string;
  symbol: string;
  previousStatus: OperationStatus;
  currentStatus: OperationStatus;
  filledPrice?: number;
  filledSize?: number;
}

/** sync() return value */
export interface SyncResult {
  hash: CommitHash;
  updatedCount: number;
  updates: OrderStatusUpdate[];
}

// ==================== Simulate Price Change ====================

/** Price change input */
export interface PriceChangeInput {
  /** Trading pair (e.g. "BTC/USD") or "all" */
  symbol: string;
  /** Price change: "@88000" (absolute) or "+10%" / "-5%" (relative) */
  change: string;
}

/** Current position state (for simulation) */
export interface SimulationPositionCurrent {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  positionValue: number;
}

/** Position state after simulation */
export interface SimulationPositionAfter {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  simulatedPrice: number;
  unrealizedPnL: number;
  positionValue: number;
  pnlChange: number;
  priceChangePercent: string;
}

/** Simulation result */
export interface SimulatePriceChangeResult {
  success: boolean;
  error?: string;
  currentState: {
    equity: number;
    unrealizedPnL: number;
    totalPnL: number;
    positions: SimulationPositionCurrent[];
  };
  simulatedState: {
    equity: number;
    unrealizedPnL: number;
    totalPnL: number;
    positions: SimulationPositionAfter[];
  };
  summary: {
    totalPnLChange: number;
    equityChange: number;
    equityChangePercent: string;
    worstCase: string;
  };
}
