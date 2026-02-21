/**
 * In-memory store for pending trade proposals awaiting user confirmation.
 *
 * Flow:
 *   1. AI calls proposeTradeWithButtons tool → stores proposal here
 *   2. Telegram sends message with ✅/❌ inline buttons
 *   3. User clicks ✅ → handleCallbackQuery retrieves proposal and executes via engine
 *   4. User clicks ❌ → proposal is discarded
 *
 * Proposals auto-expire after EXPIRY_MS (default 10 minutes).
 */

export interface PendingTradeProposal {
  id: string
  createdAt: Date
  expiresAt: Date
  /** Human-readable summary for display */
  summary: string
  /** Prompt to feed the AI when user confirms — tells it to execute the trade */
  confirmationPrompt: string
}

const EXPIRY_MS = 10 * 60 * 1000  // 10 minutes
const pending = new Map<string, PendingTradeProposal>()

function purgeExpired(): void {
  const now = Date.now()
  for (const [id, p] of pending.entries()) {
    if (p.expiresAt.getTime() < now) pending.delete(id)
  }
}

export function generateProposalId(): string {
  return `tp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

export function storePendingProposal(proposal: Omit<PendingTradeProposal, 'createdAt' | 'expiresAt'>): PendingTradeProposal {
  purgeExpired()
  const now = new Date()
  const full: PendingTradeProposal = {
    ...proposal,
    createdAt: now,
    expiresAt: new Date(now.getTime() + EXPIRY_MS),
  }
  pending.set(proposal.id, full)
  return full
}

/** Retrieve and remove a proposal (one-time use). Returns undefined if not found or expired. */
export function takePendingProposal(id: string): PendingTradeProposal | undefined {
  const proposal = pending.get(id)
  if (!proposal) return undefined
  if (proposal.expiresAt.getTime() < Date.now()) {
    pending.delete(id)
    return undefined
  }
  pending.delete(id)
  return proposal
}

export function getPendingCount(): number {
  purgeExpired()
  return pending.size
}
