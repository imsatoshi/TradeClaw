/**
 * Wallet interface definitions
 *
 * Git-like wallet state management interfaces
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

/**
 * IWallet - Wallet interface
 *
 * Provides Git three-stage operations:
 * - add: Stage an operation
 * - commit: Add a commit message
 * - push: Execute and record
 *
 * And query capabilities:
 * - log: View commit history
 * - show: View details of a specific commit
 * - status: View current state
 */
export interface IWallet {
  // ==================== Git three-stage ====================

  /**
   * git add - Stage an operation
   *
   * @param operation The operation to stage
   * @returns Staging result
   */
  add(operation: Operation): AddResult;

  /**
   * git commit -m - Add a commit message for staged operations
   *
   * @param message Commit message
   * @returns Prepared commit info
   */
  commit(message: string): CommitPrepareResult;

  /**
   * git push - Execute staged operations and record the commit
   *
   * @returns Execution result
   */
  push(): Promise<PushResult>;

  // ==================== Query ====================

  /**
   * git log - View commit history (similar to git log --stat)
   *
   * @param options.limit Maximum number of results (default 10)
   * @param options.symbol Filter commits by symbol (similar to git log -- file)
   * @returns Commit history (newest first), with operation summaries
   */
  log(options?: { limit?: number; symbol?: string }): CommitLogEntry[];

  /**
   * git show <hash> - View detailed information of a specific commit
   *
   * @param hash Commit hash
   * @returns Commit details, or null if not found
   */
  show(hash: CommitHash): WalletCommit | null;

  /**
   * git status - View current state
   *
   * @returns Current staging area and HEAD info
   */
  status(): WalletStatus;

  // ==================== Sync ====================

  /**
   * git pull - Fetch latest order statuses from exchange and record changes
   *
   * Bypasses the staging area to directly create a sync commit, recording order status updates
   *
   * @param updates List of order status changes
   * @param currentState Current wallet state snapshot
   * @returns Sync result
   */
  sync(updates: OrderStatusUpdate[], currentState: WalletState): Promise<SyncResult>;

  /**
   * Get all order IDs that are still in pending status
   *
   * Scans commit history to find all orders with status='pending' that haven't been updated by subsequent syncs
   */
  getPendingOrderIds(): Array<{ orderId: string; symbol: string }>;

  // ==================== Serialization ====================

  /**
   * Export state (for saving to snapshot)
   */
  exportState(): WalletExportState;

  /**
   * Set the current round (used for commit metadata)
   */
  setCurrentRound(round: number): void;

  // ==================== Simulation ====================

  /**
   * Simulate the impact of price changes on the portfolio (Dry Run)
   *
   * Allows AI to simulate "what if the price becomes X" scenarios before making decisions
   * Does not actually modify any state; only returns simulation results
   *
   * @param priceChanges Array of price changes
   *   - symbol: Trading pair (e.g. "BTC/USD") or "all"
   *   - change: Price change, supports:
   *     - Absolute: "@88000" means price becomes 88000
   *     - Relative: "+10%" or "-5%" for percentage change
   * @returns Simulation result
   */
  simulatePriceChange(
    priceChanges: PriceChangeInput[],
  ): Promise<SimulatePriceChangeResult>;
}

/**
 * Wallet constructor parameters
 */
export interface WalletConfig {
  /** Callback function for executing operations */
  executeOperation: (operation: Operation) => Promise<unknown>;

  /** Callback function for getting the current wallet state */
  getWalletState: () => Promise<import('./types').WalletState>;

  /** Called after each commit is persisted (push/sync), used for persistence */
  onCommit?: (state: import('./types').WalletExportState) => void | Promise<void>;
}
