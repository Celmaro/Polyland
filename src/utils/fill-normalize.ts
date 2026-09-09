/**
 * fill-normalize.ts — canonical fill math for Polymarket fills.
 *
 * Physical model (nahrek/polyledger storage.py + antflow queries):
 * on-chain OrdersMatched carries TWO legs (maker/taker) that are BOTH
 * USDC-notional (6-decimal) and equal for a clean fill — so:
 *   - usdSize = LEAST(maker, taker) / 1e6
 *   - price = collateral USD / shares, where the share count must be
 *     decoded from the share leg (ERC-1155 conditional tokens).
 * The maker's side decides which leg is collateral; the side is stated
 * explicitly, never inferred from a single ambiguous `side` column.
 */

export interface FillLegs {
  /** Maker amount filled (6-decimal USDC units, unless `scaled`). */
  makerAmountFilled?: bigint | number;
  /** Taker amount filled (6-decimal USDC units, unless `scaled`). */
  takerAmountFilled?: bigint | number;
  /** Share count exchanged (decoded from the share leg). */
  shares?: number;
  /** Maker's side — which leg is collateral (BUY: maker collateral). */
  makerSide?: 'BUY' | 'SELL';
  /** True when legs are already scaled USD floats (not 6-decimal ints). */
  scaled?: boolean;
}

export interface NormalizedFill {
  /** Fill price in $/share (0-1 probability space). */
  price: number;
  /** USDC size of the trade = LEAST(maker, taker). */
  usd: number;
  /** Shares exchanged (decoded share count). */
  shares: number;
  /** Maker side preserved (explicit, never inferred). */
  makerSide: 'BUY' | 'SELL';
}

const SCALE = 1_000_000n;

/** Convert a raw leg to scaled USD float. */
function toUsd(leg: bigint | number | undefined, scaled: boolean): number {
  if (leg === undefined) return Number.NaN;
  return scaled ? Number(leg) : Number(leg) / Number(SCALE);
}

/** USDC size of a fill: the LEAST of the two legs (equal at a clean fill). */
export function tradeUsdFromLegs(maker: bigint | number, taker: bigint | number, scaled = false): number {
  const m = scaled ? Number(maker) : Number(maker) / Number(SCALE);
  const t = scaled ? Number(taker) : Number(taker) / Number(SCALE);
  if (m <= 0 || t <= 0) return 0;
  return Math.min(m, t);
}

/** price = collateral USD / shares. Null when shares are non-positive. */
export function fillPriceFromUsdAndShares(usd: number, shares: number): number | null {
  if (!(shares > 0) || !(usd > 0) || !Number.isFinite(usd)) return null;
  return usd / shares;
}

/** Shares from usd size and price. 0 when price is non-positive. */
export function sharesFromFill(usd: number, price: number): number {
  if (!(price > 0) || !Number.isFinite(usd) || usd <= 0) return 0;
  return usd / price;
}

/**
 * Canonical {price, shares, usd} from raw CTF legs + decoded share count.
 * Null when any input is missing/degenerate (never guess a price).
 */
export function normalizeFill(legs: FillLegs): NormalizedFill | null {
  const { makerAmountFilled, takerAmountFilled, makerSide, scaled = false } = legs;
  if (makerAmountFilled === undefined || takerAmountFilled === undefined || makerSide === undefined) return null;
  const m = toUsd(makerAmountFilled, scaled);
  const t = toUsd(takerAmountFilled, scaled);
  if (!(m > 0) || !(t > 0)) return null;
  const usd = Math.min(m, t);
  const shares = legs.shares ?? 0;
  const price = fillPriceFromUsdAndShares(usd, shares);
  if (price === null || !(price > 0) || price > 2) return null; // >2 degenerate (never in prob space)
  return { price, usd, shares, makerSide };
}