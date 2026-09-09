/**
 * settlement-matrix.ts — non-plain resolution handling (tennis first).
 *
 * Adopted pattern (livetennisapi/polymarket-tennis settlement-rules.md):
 *   - a pre-start walkover resolves 50-50 on Polymarket (BOTH sides pay
 *     $0.50), NOT a hard 1/0;
 *   - retirements/walkovers/withdrawals/abandonments must never be
 *     settled as plain win/loss — mark them conservatively;
 *   - "unresolved" is a real answer; guessing 1/0 is the bug.
 *
 * Plain binary markets (winner-take-all, prices [1,0]) are unaffected.
 */
import { isTennisMarket, isNonPlainResolutionText } from '../utils/market-classify.js';

export type SettlementKind = 'plain' | 'half_walkover' | 'unresolved';

export interface SettlementInput {
  /** Market closed (Gamma `closed === true` or CLOB closed). */
  closed: boolean;
  /** Final outcome prices (index-aligned with outcomes). */
  prices?: number[];
  /** Outcome names (index-aligned with prices). */
  outcomes?: string[];
  /** Market slug (used for tennis classification). */
  slug?: string;
  /** Free-text hints: market question/description/outcome strings. */
  textHints?: string[];
}

export interface SettlementVerdict {
  kind: SettlementKind;
  /** Per-outcome payout. 1 = winner, 0 = loser, 0.5 = half (walkover). */
  payoutByOutcome: Record<string, 0 | 0.5 | 1> | null;
  /** Uniform payout when the matrix resolves every outcome to the same value. */
  payout: 0 | 0.5 | 1 | null;
  /** Human-readable reason. */
  reason: string;
}

/**
 * Resolve a closed market to per-outcome payouts.
 *
 * Rules (in order):
 *  1. Not closed → unresolved.
 *  2. Closed + pure prices (max ≥ 0.99) → plain winner-take-all.
 *  3. Closed + tennis slug + non-pure prices + non-plain text hint
 *     (walkover/retired/withdrew/abandoned/default) → HALF (0.5) for all
 *     outcomes — the 50-50 Polymarket walkover rule.
 *  4. Anything else → unresolved (never invent a winner).
 */
export function resolvePayout(input: SettlementInput): SettlementVerdict {
  const { closed, prices = [], outcomes = [], slug = '', textHints = [] } = input;
  if (!closed) {
    return { kind: 'unresolved', payoutByOutcome: null, payout: null, reason: 'market open' };
  }
  const maxP = prices.length ? Math.max(...prices) : 0;
  if (maxP >= 0.99) {
    const payoutByOutcome: Record<string, 0 | 0.5 | 1> = {};
    const winnerIdx = prices.indexOf(maxP);
    outcomes.forEach((o, i) => { payoutByOutcome[o] = i === winnerIdx ? 1 : 0; });
    return {
      kind: 'plain',
      payoutByOutcome,
      payout: null,
      reason: `plain winner-take-all (winner=${outcomes[winnerIdx] ?? 'unknown'})`,
    };
  }
  // Non-pure prices on a closed market: only a tennis market with a
  // non-plain text hint gets the conservative 0.5 treatment.
  const hints = [slug, ...textHints].filter(Boolean);
  const tennis = isTennisMarket(slug);
  const nonPlain = hints.some((h) => isNonPlainResolutionText(h));
  if (tennis && nonPlain) {
    const payoutByOutcome: Record<string, 0 | 0.5 | 1> = {};
    outcomes.forEach((o) => { payoutByOutcome[o] = 0.5; });
    return {
      kind: 'half_walkover',
      payoutByOutcome,
      payout: 0.5,
      reason: 'tennis non-plain resolution (walkover/retirement) → 50-50 payout',
    };
  }
  return {
    kind: 'unresolved',
    payoutByOutcome: null,
    payout: null,
    reason: tennis
      ? 'closed tennis with ambiguous prices and no non-plain hint — holding (never guess)'
      : 'closed market with non-pure prices — holding (never guess)',
  };
}
