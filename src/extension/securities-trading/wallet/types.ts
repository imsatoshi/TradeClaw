/**
 * Securities Wallet type definitions
 *
 * Git-like wallet state management for tracking securities trading operation history
 */

import type { SecHolding, SecOrder } from '../interfaces';

// ==================== Commit Hash ====================

export type CommitHash = string;

// ==================== Operation ====================

export type OperationAction =
  | 'placeOrder'
  | 'closePosition'
  | 'cancelOrder'
  | 'syncOrders';

export interface Operation {
  action: OperationAction;
  params: Record<string, unknown>;
}

// ==================== Operation Result ====================

export type OperationStatus = 'filled' | 'pending' | 'rejected' | 'cancelled' | 'partially_filled';

export interface OperationResult {
  action: OperationAction;
  success: boolean;
  orderId?: string;
  status: OperationStatus;
  filledPrice?: number;
  filledQty?: number;
  error?: string;
  raw?: unknown;
}

// ==================== Wallet State ====================

export interface WalletState {
  cash: number;
  equity: number;
  portfolioValue: number;
  unrealizedPnL: number;
  realizedPnL: number;
  holdings: SecHolding[];
  pendingOrders: SecOrder[];
}

// ==================== Wallet Commit ====================

export interface WalletCommit {
  hash: CommitHash;
  parentHash: CommitHash | null;
  message: string;
  operations: Operation[];
  results: OperationResult[];
  stateAfter: WalletState;
  timestamp: string;
  round?: number;
}

// ==================== API Results ====================

export interface AddResult {
  staged: true;
  index: number;
  operation: Operation;
}

export interface CommitPrepareResult {
  prepared: true;
  hash: CommitHash;
  message: string;
  operationCount: number;
}

export interface PushResult {
  hash: CommitHash;
  message: string;
  operationCount: number;
  filled: OperationResult[];
  pending: OperationResult[];
  rejected: OperationResult[];
}

export interface WalletStatus {
  staged: Operation[];
  pendingMessage: string | null;
  head: CommitHash | null;
  commitCount: number;
}

export interface OperationSummary {
  symbol: string;
  action: OperationAction;
  change: string;
  status: OperationStatus;
}

export interface CommitLogEntry {
  hash: CommitHash;
  parentHash: CommitHash | null;
  message: string;
  timestamp: string;
  round?: number;
  operations: OperationSummary[];
}

// ==================== Export State ====================

export interface WalletExportState {
  commits: WalletCommit[];
  head: CommitHash | null;
}

// ==================== Sync ====================

export interface OrderStatusUpdate {
  orderId: string;
  symbol: string;
  previousStatus: OperationStatus;
  currentStatus: OperationStatus;
  filledPrice?: number;
  filledQty?: number;
}

export interface SyncResult {
  hash: CommitHash;
  updatedCount: number;
  updates: OrderStatusUpdate[];
}

// ==================== Simulate Price Change ====================

export interface PriceChangeInput {
  symbol: string;
  change: string;
}

export interface SimulationHoldingCurrent {
  symbol: string;
  side: 'long' | 'short';
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  marketValue: number;
}

export interface SimulationHoldingAfter {
  symbol: string;
  side: 'long' | 'short';
  qty: number;
  avgEntryPrice: number;
  simulatedPrice: number;
  unrealizedPnL: number;
  marketValue: number;
  pnlChange: number;
  priceChangePercent: string;
}

export interface SimulatePriceChangeResult {
  success: boolean;
  error?: string;
  currentState: {
    equity: number;
    unrealizedPnL: number;
    totalPnL: number;
    holdings: SimulationHoldingCurrent[];
  };
  simulatedState: {
    equity: number;
    unrealizedPnL: number;
    totalPnL: number;
    holdings: SimulationHoldingAfter[];
  };
  summary: {
    totalPnLChange: number;
    equityChange: number;
    equityChangePercent: string;
    worstCase: string;
  };
}
