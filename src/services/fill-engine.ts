/**
 * fill-engine.ts — the ONE depth-consumption model shared by replay and live
 * execution (P1-5). Both the historical ReplayEvaluator and the dry-run
 * ExecutionEngine price fills through this function so research evidence and
 * paper behavior are produced by identical rules:
 *
 *   - BUY walks ask levels ascending; SELL walks bid levels descending.
 *   - Each level contributes min(remaining, level.size) shares.
 *   - A level smaller than the market's minOrderSize cannot be hit by one
 *     market order and is skipped while nothing has filled yet.
 *   - An optional maxPrice (BUY limit ceiling) / minPrice (SELL floor) stops
 *     consumption at the cap — levels beyond it are never touched.
 *   - executableVwap is the size-weighted average of the levels actually
 *     consumed; partiallyFillable is true when depth ran out first.
 */
export interface FillBookLevel {
  price: number;
  size: number;
}
export interface FillBook {
  asks: FillBookLevel[];
  bids: FillBookLevel[];
  minOrderSize: number;
  tickSize: number | string;
  timestamp: number;
}
export interface FillOrder {
  side: 'BUY' | 'SELL';
  size: number;
  /** BUY: ignore ask levels strictly above this limit. SELL: ignore bids below. */
  maxPrice?: number;
}
export interface FillResult {
  /** (price, shares) pairs actually consumed, in book order. */
  fills: { price: number; shares: number }[];
  /** Total shares consumed across all filled levels. */
  executableSize: number;
  /** Size-weighted average price of the consumed levels. */
  executableVwap: number;
  /** True when the requested size exceeds available executable depth. */
  partiallyFillable: boolean;
  verdict: 'filled' | 'no_levels' | 'below_min_order';
}

export function executeAgainstBook(order: FillOrder, book: FillBook): FillResult {
  const empty: FillResult = {
    fills: [],
    executableSize: 0,
    executableVwap: 0,
    partiallyFillable: true,
    verdict: 'no_levels',
  };
  const usable = order.side === 'BUY' ? book.asks : book.bids;
  if (!usable || usable.length === 0) return empty;

  const fills: { price: number; shares: number }[] = [];
  let remaining = order.size;
  for (const level of usable) {
    if (remaining <= 0) break;
    if (order.maxPrice !== undefined) {
      if (order.side === 'BUY' && level.price > order.maxPrice) break;
      if (order.side === 'SELL' && level.price < order.maxPrice) break;
    }
    const take = Math.min(remaining, level.size);
    // A single market order cannot hit a level below the market minimum.
    if (book.minOrderSize > 0 && take < book.minOrderSize && fills.length === 0) {
      continue;
    }
    fills.push({ price: level.price, shares: take });
    remaining -= take;
  }
  if (fills.length === 0) return { ...empty, verdict: 'below_min_order' };

  const executableSize = fills.reduce((acc, f) => acc + f.shares, 0);
  const executableVwap =
    fills.reduce((acc, f) => acc + f.price * f.shares, 0) / (executableSize || 1);
  return {
    fills,
    executableSize,
    executableVwap,
    partiallyFillable: executableSize < order.size,
    verdict: 'filled',
  };
}