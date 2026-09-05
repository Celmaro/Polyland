/**
 * Order book liquidity check (the "2× liquidity" rule).
 *
 * Source: polymarket-trade-trade-engine/engine/early-bird.ts:
 *   requiredLiquidity = order.shares * order.price * 2
 *
 * The 2× rule prevents the bot from placing an FOK order against a thin
 * book that could be partially filled at the desired price, only to leave
 * the bot holding illiquid inventory. By requiring 2× the desired notional
 * in the relevant side of the book, we ensure a margin of safety.
 *
 * Implementation:
 *  - Fetch the order book for the token
 *  - Walk the relevant side (asks for BUY, bids for SELL)
 *  - Sum size*price until we hit `requiredLiquidity`
 *  - If we run out of book before reaching it → reject
 */

import type { RateLimiter, ApiType } from '../core/rate-limiter.js';

// ============================================================================
// Types
// ============================================================================

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBookSummary {
  bids: OrderBookLevel[];   // sorted desc by price
  asks: OrderBookLevel[];   // sorted asc by price
  bestBid: number;
  bestAsk: number;
  mid: number;
  spread: number;
  /** Total liquidity on the side in USDC (sum of size*price across levels). */
  bidLiquidityUsdc: number;
  askLiquidityUsdc: number;
  /** Whether liquidity at the top of the relevant side covers the requested notional. */
  hasSufficientLiquidity: (params: LiquidityCheckParams) => LiquidityCheckResult;
}

export interface LiquidityCheckParams {
  /** Trade side. */
  side: 'BUY' | 'SELL';
  /** Number of shares we want to fill. */
  shares: number;
  /** Target price in probability space (0-1). */
  price: number;
  /** Multiplier on required notional; default 2 (the early-bird rule). */
  multiplier?: number;
}

export interface LiquidityCheckResult {
  ok: boolean;
  /** Total notional (in USDC) required to fill at this price. */
  requiredNotional: number;
  /** Notional available at the top of the relevant side up to our size. */
  availableNotional: number;
  /** Top-of-book price (worst we'd cross to). */
  topPrice: number;
  /** VWAP if we walked the book to fill `shares`. */
  vwap: number;
  /** Slipped shares: how many we couldn't fill within the side. */
  unfilledShares: number;
  /** True if the side has more than enough liquidity at the desired price. */
  reason?: string;
}

// ============================================================================
// Liquidity book representation
// ============================================================================

interface RawBookLevel {
  price: string;
  size: string;
}

interface RawBook {
  bids?: RawBookLevel[];
  asks?: RawBookLevel[];
}

// ============================================================================
// Builder
// ============================================================================

/**
 * Build an OrderBookSummary from the raw CLOB response.
 * Sorts bids desc by price, asks asc by price.
 */
export function buildOrderBookSummary(raw: RawBook): OrderBookSummary {
  const bids: OrderBookLevel[] = (raw.bids ?? [])
    .map(l => ({ price: Number(l.price), size: Number(l.size) }))
    .filter(l => l.price > 0 && l.size > 0)
    .sort((a, b) => b.price - a.price);

  const asks: OrderBookLevel[] = (raw.asks ?? [])
    .map(l => ({ price: Number(l.price), size: Number(l.size) }))
    .filter(l => l.price > 0 && l.size > 0)
    .sort((a, b) => a.price - b.price);

  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : 0;
  const spread = bestBid && bestAsk ? bestAsk - bestBid : 0;

  const bidLiquidityUsdc = bids.reduce((s, l) => s + l.size * l.price, 0);
  const askLiquidityUsdc = asks.reduce((s, l) => s + l.size * l.price, 0);

  return {
    bids,
    asks,
    bestBid,
    bestAsk,
    mid,
    spread,
    bidLiquidityUsdc,
    askLiquidityUsdc,
    hasSufficientLiquidity: (params: LiquidityCheckParams) =>
      checkLiquidity(bids, asks, params),
  };
}

// ============================================================================
// Liquidity check
// ============================================================================

/**
 * Check whether the order book can support our desired fill at >=2×
 * the notional we want.
 *
 * The "2× rule" means: the *available* notional on the relevant side of
 * the book must be at least 2× our desired notional. This protects
 * against partial fills on a thin book.
 */
function checkLiquidity(
  bids: OrderBookLevel[],
  asks: OrderBookLevel[],
  params: LiquidityCheckParams
): LiquidityCheckResult {
  const side = params.side;
  const levels = side === 'BUY' ? asks : bids;
  const desiredNotional = params.shares * params.price;
  // Required notional is based on the actual levels crossed, not the target
  // price, which can understate cost when the spread is wide.
  let targetRemaining = params.shares;
  let targetNotional = 0;
  for (const level of levels) {
    if (targetRemaining <= 0) break;
    const take = Math.min(level.size, targetRemaining);
    targetNotional += take * level.price;
    targetRemaining -= take;
  }
  const requiredNotional = (targetRemaining > 0 ? desiredNotional : targetNotional) * (params.multiplier ?? 2);

  if (levels.length === 0) {
    return {
      ok: false,
      requiredNotional,
      availableNotional: 0,
      topPrice: 0,
      vwap: 0,
      unfilledShares: params.shares,
      reason: 'empty_book',
    };
  }

  const topPrice = levels[0].price;
  // Total notional available on the relevant side.
  const totalAvailable = levels.reduce((s, l) => s + l.size * l.price, 0);

  // Walk the book to fill the desired size.
  let filledShares = 0;
  let filledNotional = 0;
  let remaining = params.shares;
  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(level.size, remaining);
    filledShares += take;
    filledNotional += take * level.price;
    remaining -= take;
  }

  const vwap = filledShares > 0 ? filledNotional / filledShares : topPrice;
  const unfilledShares = params.shares - filledShares;
  // OK if we filled the full size AND total book had >= 2x our notional.
  const ok = unfilledShares <= 0 && totalAvailable >= requiredNotional;

  return {
    ok,
    requiredNotional,
    availableNotional: filledNotional,
    topPrice,
    vwap,
    unfilledShares,
    reason: ok ? undefined : unfilledShares > 0
      ? `insufficient_size ${filledShares.toFixed(0)}/${params.shares.toFixed(0)}`
      : `insufficient_notional $${filledNotional.toFixed(2)}<$${requiredNotional.toFixed(2)}`,
  };
}

// ============================================================================
// Fetcher
// ============================================================================

/**
 * Minimal interface for a CLOB client that can fetch an order book.
 * Both ClobClient from @polymarket/clob-client and a simulated
 * backtest client can satisfy this.
 */
export interface BookFetcher {
  getOrderBook(tokenId: string): Promise<RawBook>;
}

/**
 * Convenience: fetch a book through a rate limiter and return the summary.
 */
export async function fetchBook(
  fetcher: BookFetcher,
  tokenId: string,
  rateLimiter: RateLimiter,
  apiType: ApiType
): Promise<OrderBookSummary | null> {
  try {
    const raw = await rateLimiter.execute(apiType, () => fetcher.getOrderBook(tokenId));
    return buildOrderBookSummary(raw);
  } catch {
    return null;
  }
}
