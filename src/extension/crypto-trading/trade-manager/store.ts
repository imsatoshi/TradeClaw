/**
 * TradePlanStore — in-memory Map + JSON file persistence.
 *
 * Active plans → data/trade-plans/active.json
 * Completed/cancelled plans → data/trade-plans/history.json (append-only)
 */

import { readFile, writeFile, appendFile, mkdir } from 'fs/promises'
import { resolve } from 'path'
import type { TradePlan } from './types.js'

const DATA_DIR = resolve('data/trade-plans')
const ACTIVE_FILE = resolve(DATA_DIR, 'active.json')
const HISTORY_FILE = resolve(DATA_DIR, 'history.json')

export class TradePlanStore {
  private plans = new Map<string, TradePlan>()

  /** Load active plans from disk on startup. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(ACTIVE_FILE, 'utf-8')
      const arr: TradePlan[] = JSON.parse(raw)
      for (const plan of arr) {
        // Migrate legacy SL status: 'placed' via CCXT → 'monitoring' via price check
        if (plan.stopLoss.status === 'placed') {
          plan.stopLoss.status = 'monitoring'
          delete plan.stopLoss.orderId
        }
        this.plans.set(plan.id, plan)
      }
      console.log(`trade-plan-store: restored ${arr.length} active plan(s) from disk`)
    } catch {
      // File not found or invalid — start fresh
    }
  }

  get(id: string): TradePlan | undefined {
    return this.plans.get(id)
  }

  getAll(): TradePlan[] {
    return [...this.plans.values()]
  }

  getBySymbol(symbol: string): TradePlan[] {
    return this.getAll().filter(p => p.symbol === symbol)
  }

  /** Save or update a plan (persists to disk). */
  async save(plan: TradePlan): Promise<void> {
    plan.updatedAt = new Date().toISOString()
    this.plans.set(plan.id, plan)
    await this.flush()
  }

  /** Remove a plan from active set and archive to history. */
  async archive(plan: TradePlan): Promise<void> {
    this.plans.delete(plan.id)
    await this.flush()
    await this.appendHistory(plan)
  }

  /** Persist all active plans to disk. */
  private async flush(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true })
    const arr = this.getAll()
    await writeFile(ACTIVE_FILE, JSON.stringify(arr, null, 2))
  }

  /** Append a completed/cancelled plan to history file. */
  private async appendHistory(plan: TradePlan): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true })
    const line = JSON.stringify(plan) + '\n'
    await appendFile(HISTORY_FILE, line)
  }
}
