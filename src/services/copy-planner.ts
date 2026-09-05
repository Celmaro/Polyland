/**
 * CopyPlanner — executable copy planner for Polyland (replacement layer).
 *
 * A copied trade is an intent, not the leader's printed price. This planner
 * turns a confirmed leader intent + live book + market metadata into an
 * executable plan (price, shares, cost, fee, edge, size) or an explicit
 * rejection reason.
 *
 * Research-driven policies:
 *  - executable VWAP from the live book (lowest asks for BUY, highest bids
 *    for SELL), never the leader's print or the midpoint;
 *  - taker fee = feeRate × p × (1 − p) — price-dependent, peaks at 0.50;
 *  - drift gate: reject when the executable price has moved beyond tolerance
 *    from the leader's price (copying after the move destroys edge);
 *  - tick quantization down and min-notional enforcement;
 *  - fractional-Kelly sizing blended with market belief, shrunk by
 *    reliability, execution confidence, and independence, and hard-capped by
 *    basket headroom and per-trade max;
 *  - FAK preferred (partial fills acceptable, remainder cancels); FOK when an
 *    all-or-nothing position is required.
 */
import { quantizeBuyPrice, tickSizeToEnum } from '../utils/price-utils.js';

export interface BookLevel {
  price: number;
  size: number;
}

export interface CopyBook {
  bids: BookLevel[];
  asks: BookLevel[];
  ageMs: number;
}

export interface MarketMeta {
  tickSize: number;
  minNotional: number;
  takerFeeRateBps: number;
  acceptingOrders: boolean;
}

export interface LeaderSignal {
  wallet: string;
  conditionId: string;
  tokenId?: string;
  side: 'BUY' | 'SELL';
  size: number;       // leader shares
  price: number;      // leader fill price
  timestamp: number;
  fairProb: number;   // calibrated basket probability of the directional thesis (0..1)
  reliability: number;          // 0..1
  executionConfidence: number;  // 0..1
  independenceAdjustment: number; // 0..1
}

export interface CopyPlannerConfig {
  maxSlippagePct: number;    // drift/impact allowance (e.g. 0.02)
  maxBookAgeMs: number;
  fractionalKelly: number;   // e.g. 0.25
  capitalUsd: number;        // total capital for allocation math
  basketHeadroomUsd: number; // remaining basket budget
  maxSizeUsd: number;        // hard per-trade cap
  reliabilityFloor: number;
  defaultOrderType: 'FAK' | 'FOK';
}

export interface CopyPlan {
  signalKey: string;
  side: 'BUY' | 'SELL';
  tokenId?: string;
  conditionId: string;
  executablePrice: number;   // raw VWAP of the book consumed
  price: number;             // tick-quantized limit price
  shares: number;
  costUsd: number;           // shares × price
  feeUsd: number;
  feePerShare: number;
  edge: number;              // fairProb − price − feePerShare − slippageBuffer (BUY)
  kellyFraction: number;     // 0..1
  allocationUsd: number;
  orderType: 'FAK' | 'FOK';
  driftOk: boolean;
}

export type CopyRejectReason =
  | 'no_book' | 'stale_book' | 'market_closed' | 'drift'
  | 'below_min' | 'no_edge' | 'low_reliability' | 'no_headroom'
  | 'bad_input' | 'unsupported_side';

export type CopyPlanDecision =
  | { accepted: true; plan: CopyPlan }
  | { accepted: false; reason: CopyRejectReason; detail?: string };

/** Executable VWAP for the requested notional against the book. */
export function executableVwap(levels: BookLevel[], requestedShares: number): { price: number; filled: number } | null {
  if (!levels || levels.length === 0 || requestedShares <= 0) return null;
  let remaining = requestedShares;
  let notional = 0;
  let filled = 0;
  for (const lvl of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lvl.size);
    notional += take * lvl.price;
    filled += take;
    remaining -= take;
  }
  if (filled <= 0) return null;
  return { price: notional / filled, filled };
}

/** Taker fee per share: feeRate × p × (1 − p). */
export function takerFeePerShare(p: number, feeRateBps: number): number {
  const rate = feeRateBps / 10_000;
  return rate * p * (1 - p);
}

/** Fractional-Kelly fraction for a binary bet bought at p_entry, fair prob p_fair. */
export function binaryKellyFraction(pFair: number, pEntry: number): number {
  if (pFair <= pEntry || pEntry >= 1 || pEntry <= 0) return 0;
  return Math.min(1, (pFair - pEntry) / (1 - pEntry));
}

export class CopyPlanner {
  constructor(private readonly config: CopyPlannerConfig) {}

  plan(signal: LeaderSignal, book: CopyBook, meta: MarketMeta): CopyPlanDecision {
    if (!signal || !book || !meta) return { accepted: false, reason: 'bad_input' };
    if (signal.side !== 'BUY' && signal.side !== 'SELL') return { accepted: false, reason: 'unsupported_side' };
    if (signal.reliability < this.config.reliabilityFloor) return { accepted: false, reason: 'low_reliability' };
    if (!meta.acceptingOrders) return { accepted: false, reason: 'market_closed' };
    if (book.ageMs > this.config.maxBookAgeMs) return { accepted: false, reason: 'stale_book' };

    const tick = tickSizeToEnum(meta.tickSize);
    const signalKey = `${signal.wallet.toLowerCase()}:${signal.conditionId.toLowerCase()}:${signal.side.toLowerCase()}`;

    if (signal.side === 'BUY') {
      // Executable price from the ask side.
      const levels = (book.asks ?? []).slice().sort((a, b) => a.price - b.price);
      const requested = signal.size;
      const v = executableVwap(levels, requested);
      if (!v || v.filled <= 0) return { accepted: false, reason: 'no_book' };

      // Drift gate: follower must not pay more than leader + tolerance.
      if (v.price > signal.price * (1 + this.config.maxSlippagePct)) {
        return { accepted: false, reason: 'drift', detail: `exec ${v.price.toFixed(4)} vs leader ${signal.price.toFixed(4)}` };
      }

      const price = quantizeBuyPrice(v.price, tick);
      const feePerShare = takerFeePerShare(price, meta.takerFeeRateBps);
      const slippageBuffer = this.config.maxSlippagePct * price;
      const edge = signal.fairProb - price - feePerShare - slippageBuffer;
      if (edge <= 0) return { accepted: false, reason: 'no_edge', detail: `edge ${edge.toFixed(4)}` };

      const kelly = binaryKellyFraction(signal.fairProb, price);
      if (kelly <= 0) return { accepted: false, reason: 'no_edge', detail: `kelly ${kelly.toFixed(4)}` };

      const alloc = Math.min(
        this.config.capitalUsd * this.config.fractionalKelly * kelly * signal.reliability * signal.executionConfidence * signal.independenceAdjustment,
        this.config.basketHeadroomUsd,
        this.config.maxSizeUsd,
      );
      if (alloc <= 0) return { accepted: false, reason: 'no_headroom' };

      const shares = Math.floor(alloc / price);
      const costUsd = shares * price;
      if (shares <= 0 || costUsd < Math.max(meta.minNotional, this.config.maxSizeUsd > 0 ? 1 : 1)) {
        return { accepted: false, reason: 'below_min', detail: `cost ${costUsd.toFixed(2)}` };
      }

      return {
        accepted: true,
        plan: {
          signalKey, side: 'BUY', tokenId: signal.tokenId, conditionId: signal.conditionId,
          executablePrice: v.price, price, shares, costUsd, feeUsd: feePerShare * shares, feePerShare,
          edge, kellyFraction: kelly, allocationUsd: costUsd, orderType: this.config.defaultOrderType, driftOk: true,
        },
      };
    }

    // SELL plan — used by the exit state machine; quantity is capped by caller.
    const levels = (book.bids ?? []).slice().sort((a, b) => b.price - a.price);
    const v = executableVwap(levels, signal.size);
    if (!v || v.filled <= 0) return { accepted: false, reason: 'no_book' };
    if (v.price < signal.price * (1 - this.config.maxSlippagePct)) {
      return { accepted: false, reason: 'drift', detail: `bid ${v.price.toFixed(4)} vs leader ${signal.price.toFixed(4)}` };
    }
    const price = quantizeBuyPrice(v.price, tick);
    const feePerShare = takerFeePerShare(price, meta.takerFeeRateBps);
    const shares = Math.floor(signal.size);
    const costUsd = shares * price;
    if (shares <= 0) return { accepted: false, reason: 'below_min' };
    return {
      accepted: true,
      plan: {
        signalKey, side: 'SELL', tokenId: signal.tokenId, conditionId: signal.conditionId,
        executablePrice: v.price, price, shares, costUsd, feeUsd: feePerShare * shares, feePerShare,
        edge: price - signal.fairProb, kellyFraction: 0, allocationUsd: costUsd, orderType: 'FAK', driftOk: true,
      },
    };
  }
}