/**
 * settlement-matrix.ts — non-plain resolution handling for ALL markets.
 *
 * Adopted pattern (livetennisapi/polymarket-tennis settlement-rules.md),
 * generalized: the walkover 50-50 rule is ONE instance of a general
 * Polymarket fact — every market's description defines its resolution
 * rules. So instead of hard-coding tennis hints, we scan rule language on
 * EVERY market:
 *   - a closed market with non-pure prices + non-plain text (walkover /
 *     retired / withdrew / abandoned / default) is NEVER settled as a hard
 *     1/0 — hold conservatively (unresolved);
 *   - if the description states a specific zero-payout / uniform-payout
 *     rule (e.g. "resolves 50-50", "resolves to 0"), apply it;
 *   - plain binary markets (winner-take-all, prices [1,0]) are unaffected.
 *
 * "Unresolved" is a real answer; guessing 1/0 is the bug.
 */
import { isTennisMarket, isNonPlainResolutionText } from '../utils/market-classify.js';

export type SettlementKind = 'plain' | 'half_walkover' | 'void' | 'unresolved';

/** A per-market resolution rule stated in the description. */
export interface PayoutRule {
  /** Regex matched against the market description/question. */
  pattern: RegExp;
  /** Uniform payout to apply when the rule fires (e.g. 0.5, 0). */
  payout: 0 | 0.5;
  /** Why this rule exists (for the audit trail). */
  label: string;
}

/** Built-in rule set: the well-known Polymarket "no clear winner" texts. */
export const DEFAULT_PAYOUT_RULES: PayoutRule[] = [
  {
    pattern: /(?:50-50|50\/50|fifty|split(?:s|ted)? (?:the )?(?:payout|pot)|no (?:clear|official) winner)/i,
    payout: 0.5,
    label: 'stated 50-50 payout',
  },
  {
    pattern: /(?:resolves? (?:to )?no|void|no winner|cancelled|invalidate)/i,
    payout: 0,
    label: 'stated no-payout / void',
  },
];

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
  /** Extra resolution rules beyond the built-ins (per-market overrides). */
  extraRules?: PayoutRule[];
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
 *  3. Closed + non-pure prices + non-plain resolution text:
 *       - tennis (walkover/retirement) → HALF (0.5) — the 50-50 rule;
 *       - any market whose description states a payout rule (50-50, void)
 *         → that uniform payout;
 *       - otherwise → unresolved (never invent a winner).
 *  4. Anything else → unresolved.
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
  // Non-pure prices on a closed market: the market did not resolve cleanly.
  // A stated resolution rule in the description is authoritative (applies to
  // EVERY market, tennis or not); otherwise treat a non-plain hint as a
  // conservative hold.
  const hints = [slug, ...textHints].filter(Boolean);
  const tennis = isTennisMarket(slug);
  const nonPlain = hints.some((h) => isNonPlainResolutionText(h));
  const rules = [...DEFAULT_PAYOUT_RULES, ...(input.extraRules ?? [])];
  const rule = rules.find((r) => hints.some((h) => r.pattern.test(h)));
  if (rule) {
    return uniformPayout(outcomes, rule.payout, `stated rule (${rule.label}) → ${rule.payout === 0.5 ? '50-50' : 'void'} payout`);
  }
  if (nonPlain) {
    // Tennis rule (Polymarket settlement-rules.md): a pre-start walkover
    // pays 50-50; an in-play retirement pays the advance-win outcome. Without
    // a listed-outcome signal we settle HALF conservatively.
    if (tennis) {
      return uniformPayout(outcomes, 0.5, 'tennis non-plain resolution (walkover/retirement) → 50-50 payout');
    }
    return {
      kind: 'unresolved',
      payoutByOutcome: null,
      payout: null,
      reason: `non-plain resolution text detected (${hints[0]}) and no stated payout rule — holding (never guess)`,
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

/** Build a uniform-payout verdict (0.5 → half_walkover kind; 0 → void). */
function uniformPayout(
  outcomes: string[],
  payout: 0 | 0.5,
  reason: string,
): SettlementVerdict {
  const payoutByOutcome: Record<string, 0 | 0.5 | 1> = {};
  outcomes.forEach((o) => { payoutByOutcome[o] = payout; });
  return {
    kind: payout === 0.5 ? 'half_walkover' : 'void',
    payoutByOutcome,
    payout,
    reason,
  };
}
