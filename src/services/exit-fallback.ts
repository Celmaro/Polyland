/**
 * Exit-liquidity fallback for DRY_RUN: when a long position's own token book
 * has no live bid, price the paper exit via the complement (NO) side.
 *
 * Selling YES at price P is economically equivalent to buying NO at (1 − P).
 * So if the NO side has an executable ASK at A_no, the maximum executable
 * price for our YES position is (1 − A_no) — a real, priceable exit that
 * unblocks positions the current exit pass strands forever as
 * `exit_liquidity_blocked` (verified in prod: 550× in one window, 91/92
 * positions never settled → streak stuck at 1W).
 *
 * Paper-only. LIVE must never sell at a synthetic price — a real order needs
 * an actual YES bid (or a real complement order). This module is purely the
 * price derivation; the caller decides mode.
 */
export interface BookSide {
  price: number;
  size: number;
}

/** Minimum synthetic exit price; below this we consider the complement too thin. */
export const MIN_SYNTHETIC_EXIT = 0.01;
/** Clamp synthetic prices into (0,1); never allow a sell above 1 or at/below 0. */
export const MAX_SYNTHETIC_EXIT = 0.99;

/**
 * Derive the synthetic exit price for a long position from the complement
 * (NO) side's best ask. Returns null when no usable ask exists or the
 * resulting price is degenerate.
 *
 * @param complementAsks  asks from the complement (NO) token's book, ascending
 * @param takerFeeBps     taker fee to subtract (mirrors real sell math)
 */
export function complementExitPrice(
  complementAsks: BookSide[],
  takerFeeBps = 0,
): number | null {
  if (!Array.isArray(complementAsks) || complementAsks.length === 0) return null;
  const bestNoAsk = Math.min(...complementAsks.map((l) => Number(l.price)));
  if (!(bestNoAsk > 0) || bestNoAsk >= 1) return null;
  // Selling YES ~= buying NO at (1 − bestNoAsk); subtract the taker fee.
  const synthetic = 1 - bestNoAsk - takerFeeBps / 10_000;
  if (synthetic <= MIN_SYNTHETIC_EXIT) return null;
  return Math.min(synthetic, MAX_SYNTHETIC_EXIT);
}
