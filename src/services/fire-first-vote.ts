/**
 * R1 — fire-on-first-vote confirm window (post-hoc reversal detection).
 *
 * With quorum configurable to 1, a basket can fire on the first qualified
 * vote. The confirm window then watches for a second vote: if it agrees,
 * confidence is confirmed; if it contradicts (opposite side on the same
 * outcome, or a flip to the opposite outcome) within the window, the fire is
 * flagged as reversal risk for a paper reversal / hedging decision.
 *
 * Pure function — caller decides what "reversal_risk" does (paper flag,
 * ledger note, or hedge). Kept additive; no changes to the existing quorum
 * or tiered-fire semantics.
 */
export interface VoteRef {
  wallet: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  price: number;
  ts: number;
}

export interface ConfirmWindowInput {
  firstVote: VoteRef;
  secondVote?: VoteRef;
  confirmWindowMs: number;
}

export type ConfirmAction =
  | 'no_second_vote'
  | 'confirm'
  | 'reversal_risk'
  | 'outside_window';

export interface ConfirmResult {
  action: ConfirmAction;
  reason: string;
}

/** Evaluate whether a second vote confirms or contradicts the first fire. */
export function evaluateConfirmWindow(input: ConfirmWindowInput): ConfirmResult {
  const { firstVote, secondVote, confirmWindowMs } = input;
  if (!secondVote) {
    return { action: 'no_second_vote', reason: 'no second vote observed in window' };
  }
  if (secondVote.ts - firstVote.ts > confirmWindowMs) {
    return { action: 'outside_window', reason: `second vote ${secondVote.ts - firstVote.ts}ms after first exceeds ${confirmWindowMs}ms window` };
  }

  // Flip to the opposite outcome = reversal risk.
  if (secondVote.outcome !== firstVote.outcome) {
    return { action: 'reversal_risk', reason: `contradict: second voted ${secondVote.side} ${secondVote.outcome} vs first ${firstVote.side} ${firstVote.outcome}` };
  }
  // Same outcome, opposite side (leader SELLs what we just bought) = contradict.
  if (secondVote.side !== firstVote.side) {
    return { action: 'reversal_risk', reason: `contradict: second ${secondVote.side} on ${secondVote.outcome} vs first ${firstVote.side}` };
  }
  // Same outcome, same side = aligned confirmation.
  return { action: 'confirm', reason: `aligned: second ${secondVote.side} ${secondVote.outcome} @ ${secondVote.price}` };
}