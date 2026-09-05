/**
 * Maker/taker detection from closed positions and on-chain fills.
 *
 * Source: leolopez007/polymarket-trade-tracker/script.py
 *   - Reads on-chain transaction receipts to determine maker/taker.
 *   - The `OrderFilled` event on the CTF Exchange emits a `maker/taker` flag.
 *
 * For backtesting/screening we don't have on-chain receipt access, so
 * we infer maker/taker from the closed-position metadata that the
 * Data API exposes:
 *
 *   - If a closed position was opened with a BUY limit order that was
 *     posted (not immediately filled), it was a maker.
 *   - If the position was opened by crossing the spread (market order or
 *     marketable limit), it was a taker.
 *
 * Polymarket's `ClosedPosition` does not directly expose the maker/taker
 * flag, but the `realizedPnl` shape combined with `cashPnl` and the entry
 * price lets us infer it statistically:
 *
 *   - Maker orders have a non-zero chance of a rebate (Polymarket has
 *     historical rebate programs). `cashPnl` will be slightly higher
 *     than `realizedPnl` for maker orders.
 *   - Taker orders always have a negative fee contribution.
 *
 * For 100% accuracy we'd need on-chain parsing; this module provides
 * a best-effort estimate that we can use to weight CopyScore.
 */

// ============================================================================
// Types
// ============================================================================

export interface ClosedPositionLike {
  /** When the position was opened (unix seconds). */
  openedAt?: number;
  /** When the position was closed (unix seconds). */
  closedAt?: number;
  /** Average entry price (0-1). */
  avgPrice: number;
  /** Take/realized PnL. */
  realizedPnl: number;
  /** Cash PnL (realized PnL minus fees, sometimes inclusive of rebates). */
  cashPnl?: number;
  /** Total bought (shares). */
  totalBought: number;
}

export interface MakerTakerStats {
  /** Estimated number of maker fills. */
  makerFills: number;
  /** Estimated number of taker fills. */
  takerFills: number;
  /** makerFills / total. */
  makerRate: number;
  /** Total realized fees (positive number, USDC). */
  totalFees: number;
  /** Average fee rate per fill (bps). */
  avgFeeBps: number;
}

// ============================================================================
// Inference
// ============================================================================

/**
 * Infer maker/taker from a single closed position.
 * Heuristic:
 *   - If cashPnl > realizedPnl by more than expected fee threshold, treat as maker (rebate).
 *   - Otherwise, treat as taker.
 *
 * @param pos Closed position data
 * @param feeRateBps Market fee rate in basis points
 * @returns 'maker' | 'taker'
 */
export function inferMakerTaker(
  pos: ClosedPositionLike,
  feeRateBps: number
): 'maker' | 'taker' {
  if (pos.cashPnl === undefined) {
    // No fee breakdown → assume taker (conservative; we lose maker credit
    // if it existed but wasn't reported).
    return 'taker';
  }
  // Maker orders get a small rebate (typically 25-50% of fee) — so cashPnl
  // would be higher than realizedPnl.
  // Taker orders pay the full fee — realizedPnl reflects the deduction.
  const feeExpected = (pos.totalBought * pos.avgPrice * (1 - pos.avgPrice) * feeRateBps) / 10_000;
  const cashVsRealized = pos.cashPnl - pos.realizedPnl;
  // If cashPnl exceeds realizedPnl by more than half the expected fee, the
  // order was a maker (rebate > fee paid).
  if (cashVsRealized > feeExpected * 0.5) {
    return 'maker';
  }
  return 'taker';
}

/**
 * Aggregate maker/taker stats from a wallet's closed positions.
 */
export function aggregateMakerTaker(
  positions: ClosedPositionLike[],
  feeRateBps: number
): MakerTakerStats {
  let makerFills = 0;
  let takerFills = 0;
  let totalFees = 0;

  for (const p of positions) {
    const role = inferMakerTaker(p, feeRateBps);
    if (role === 'maker') makerFills++;
    else takerFills++;

    if (p.cashPnl !== undefined) {
      const feeThisFill = p.realizedPnl - p.cashPnl; // negative for taker
      totalFees += Math.max(0, feeThisFill);
    }
  }

  const total = makerFills + takerFills;
  const totalNotional = positions.reduce(
    (s, p) => s + p.totalBought * p.avgPrice, 0
  );
  const avgFeeBps = totalNotional > 0
    ? (totalFees / totalNotional) * 10_000
    : 0;

  return {
    makerFills,
    takerFills,
    makerRate: total > 0 ? makerFills / total : 0,
    totalFees,
    avgFeeBps,
  };
}

// ============================================================================
// CopyScore weighting
// ============================================================================

/**
 * Convert maker-rate into a CopyScore bonus/penalty.
 *
 * Rationale: maker orders earn rebates and indicate a wallet providing
 * liquidity (less copy-snipeable). High maker rate → small bonus.
 * Low maker rate (pure taker) → no bonus, no penalty.
 *
 * @param makerRate 0-1
 * @returns -0.05 to +0.05 contribution to CopyScore
 */
export function makerRateScoreBonus(makerRate: number): number {
  if (makerRate < 0.05) return 0;          // not enough data
  if (makerRate > 0.6) return 0.05;         // LP-style wallet, small bonus
  return (makerRate - 0.05) * 0.1;         // linear ramp 0.05→0.6
}
