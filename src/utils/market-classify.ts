/**
 * market-classify.ts — cheap slug/text classification utilities.
 *
 * Adopted patterns:
 *   - livetennisapi/polymarket-tennis discovery.py:35-38 — tennis-universe
 *     slug regex gives a free tour dimension (atp|wta|itf|challenger|ch).
 *   - settlement-rules.md:106-117 — non-plain resolution texts
 *     (walkover/retired/withdrew/abandoned) signal markets that must NOT
 *     settle as a hard 1/0.
 *
 * Polyland's worst segment is thin ITF — per-tour classification is the
 * hook for per-tour risk tiers and market-quality gates.
 */

export type TennisTour = 'atp' | 'wta' | 'itf' | 'challenger' | 'other';

const TOUR_RE = /(?:^|[-_/])(atp|wta|itf|challenger|ch)(?:[-_/]|$)/i;

/** Tour dimension from a market slug. 'other' when not tennis. */
export function classifyTennisTour(slug: string): TennisTour {
  const m = TOUR_RE.exec(slug ?? '');
  if (!m) return 'other';
  const tag = m[1].toLowerCase();
  if (tag === 'ch') return 'challenger';
  if (tag === 'atp' || tag === 'wta' || tag === 'itf' || tag === 'challenger') return tag as TennisTour;
  return 'other';
}

/** True when the slug is any tennis tour market. */
export function isTennisMarket(slug: string): boolean {
  return classifyTennisTour(slug) !== 'other';
}

const NON_PLAIN_RE = /walkover|retired|withdrew|abandoned|(?:^|[\s-])default(?:[\s-]|$)/i;

/**
 * True when a title/description/outcome text hints at a non-plain
 * resolution (walkover, retirement, withdrawal, abandonment, default).
 * Such markets must not be settled as a hard 1/0 — payout is 50-50 for
 * a pre-start walkover, and 1/0 positions are wrong for retirements.
 */
export function isNonPlainResolutionText(text: string): boolean {
  return NON_PLAIN_RE.test(text ?? '');
}