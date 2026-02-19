/**
 * Securities Wallet interface definitions
 *
 * Git-like state management interfaces for securities trading
 */

import type {
  CommitHash,
  Operation,
  AddResult,
  CommitPrepareResult,
  PushResult,
  WalletStatus,
  WalletCommit,
  CommitLogEntry,
  WalletExportState,
  PriceChangeInput,
  SimulatePriceChangeResult,
  OrderStatusUpdate,
  SyncResult,
  WalletState,
} from './types';

export interface ISecWallet {
  // ==================== Git-style three-phase workflow ====================

  add(operation: Operation): AddResult;
  commit(message: string): CommitPrepareResult;
  push(): Promise<PushResult>;

  // ==================== Queries ====================

  log(options?: { limit?: number; symbol?: string }): CommitLogEntry[];
  show(hash: CommitHash): WalletCommit | null;
  status(): WalletStatus;

  // ==================== Sync ====================

  sync(updates: OrderStatusUpdate[], currentState: WalletState): Promise<SyncResult>;
  getPendingOrderIds(): Array<{ orderId: string; symbol: string }>;

  // ==================== Serialization ====================

  exportState(): WalletExportState;
  setCurrentRound(round: number): void;

  // ==================== Simulation ====================

  simulatePriceChange(
    priceChanges: PriceChangeInput[],
  ): Promise<SimulatePriceChangeResult>;
}

export interface SecWalletConfig {
  executeOperation: (operation: Operation) => Promise<unknown>;
  getWalletState: () => Promise<WalletState>;
  onCommit?: (state: WalletExportState) => void | Promise<void>;
}
