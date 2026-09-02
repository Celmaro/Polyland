/**
 * Polymarket fee math.
 *
 * Sources:
 *  - https://docs.polymarket.com/#fees (public fee formula)
 *  - https://polygon-marketplace-dns/polymarket/clob-market-info → feeRateBps per market
 *
 * Maker orders: 0% fee.
 * Taker orders: fee_per_share = feeRateBps × price × (1 - price)
 *   where price is the trade price in probability space (0-1).
 *
 * This utility centralizes the fee math so:
 *  - Edge accounting is consistent across screening, execution, and audit
 *  - Maker/taker detection produces a stable maker-rebate-aware edge
 *  - Backtests use the exact same formula as live trading
 */

// ============================================================================
// Constants
// ============================================================================

/** Taker fee rate is stored as basis points (1 bp = 0.01%) on each market. */
export type FeeRateBps = number;

/** Default feeRateBps when market info unavailable. ~2% taker fee at 50c. */
export const DEFAULT_FEE_RATE_BPS = 200;

/** Maker orders are zero-fee on Polymarket. We tag this explicitly so the
 *  fee math downstream treats maker fills as free. */
export const MAKER_FEE_BPS = 0;

// ============================================================================
// Fee computation
// ============================================================================

/**
 * Compute the taker fee per share in USDC (probability units, 0-1 scale).
 *
 * Polymarket formula: fee = feeRateBps × price × (1 - price)
 * At price=0.5, feeRateBps=200: fee = 0.02 × 0.25 = 0.005 ($0.005/share)
 *
 * @param price Trade price in probability space (0-1)
 * @param feeRateBps Market fee rate in basis points (e.g. 200 for 2%)
 * @returns Fee per share in USDC, 0-1 scale
 */
export function takerFeePerShare(price: number, feeRateBps: FeeRateBps): number {
  if (price <= 0 || price >= 1) return 0;
  const feeRate = feeRateBps / 10_000;
  return feeRate * price * (1 - price);
}

/**
 * Compute the fee per share for a given side/maker flag.
 * - Maker: 0
 * - Taker: takerFeePerShare(price, feeRateBps)
 */
export function feePerShare(
  price: number,
  feeRateBps: FeeRateBps,
  isMaker: boolean
): number {
  return isMaker ? 0 : takerFeePerShare(price, feeRateBps);
}

/**
 * Compute fee-adjusted edge for a BUY signal.
 *
 *   expectedEdge = P(win) × (1 - price) − (1 - P(win)) × price − takerFee
 *               = P(win) − price − takerFee
 *
 * Equivalent to the canonical "edge = winProb − impliedProb − fee" formula.
 * Use this to decide if a quorum signal is actually profitable.
 *
 * @param winRate Model probability (0-1) the YES side wins
 * @param price YES price (0-1)
 * @param feeRateBps Market taker fee in bps
 * @param isMaker If true, fee contribution is 0
 * @returns Net edge per share in USDC, 0-1 scale
 */
export function expectedEdgeBuy(
  winRate: number,
  price: number,
  feeRateBps: FeeRateBps,
  isMaker = false
): number {
  const fee = feePerShare(price, feeRateBps, isMaker);
  return winRate - price - fee;
}

/**
 * Compute fee-adjusted edge for a SELL (or NO) signal.
 *
 *   expectedEdge = (1 - P(win)) − (1 - price) − takerFee
 *               = price − P(win) − takerFee
 */
export function expectedEdgeSell(
  winRate: number,
  price: number,
  feeRateBps: FeeRateBps,
  isMaker = false
): number {
  const fee = feePerShare(price, feeRateBps, isMaker);
  return price - winRate - fee;
}

/**
 * Round-trip taker cost (open + close as taker both sides).
 * Useful for sizing: a 3% round-trip taker cost must be covered by edge.
 */
export function roundTripTakerCost(price: number, feeRateBps: FeeRateBps): number {
  return 2 * takerFeePerShare(price, feeRateBps);
}

/**
 * Compute the minimum win-rate needed for a profitable BUY at the given price.
 *   Break-even: winRate − price − fee = 0
 *             ⇒ winRate = price + fee
 */
export function breakEvenWinRate(
  price: number,
  feeRateBps: FeeRateBps,
  isMaker = false
): number {
  return price + feePerShare(price, feeRateBps, isMaker);
}
