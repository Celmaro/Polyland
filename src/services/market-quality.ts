/**
 * market-quality.ts — market-quality feature tracking and gates.
 *
 * Adopted patterns:
 *   - acyclops/polymarket-lens leaderboards.js:22-51,161-183 — chop
 *     (Σ|Δp|), whiplash, and spread/depth features computed from
 *     observations; sparse markets must NOT rank high (minTicks guard);
 *   - lens fetchMarkets.js:148-160 + livetennisapi liquidity gate — a
 *     market needs minimum observations, fresh ticks, liquidity (depth)
 *     and a bounded spread before it may contribute to basket quorum;
 *   - lens leaderboards.js:94-124 — signed movement (NOT the directionless
 *     "momentum ratio"): did price move toward or away from the copied
 *     side over a horizon?
 *
 * The tracker is fed passively (CLOB mid prices + book snapshots); assess()
 * is the gate; sizeMultiplier() is the chop-based execution risk modifier.
 */
import type { FillBook } from './fill-engine.js';
import { scoreTimeframes } from './intensity-scoring.js';

export interface QualityFeatures {
  tickCount: number;
  lastTickAgeMs: number;
  /** Σ|Δp| over the retained price buffer (chop). */
  chop: number;
  /** Σ|Δp| capped for ratio math. */
  whiplash: number;
  /** Signed price change over the whole buffer (last − first). */
  signedMove: number;
  /** Best-ask − best-bid in bps of mid (null when no 2-sided book). */
  spreadBps: number | null;
  /** USD depth on the executable side at the best level. */
  depthUsd: number;
  /** Top-of-book imbalance (bidUsd − askUsd)/(bidUsd + askUsd), -1..1. */
  imbalance: number | null;
  /** Depth-N imbalance (1/3/5 levels) + target-size slippage (P21, marketlens). */
  imbalance1: number | null;
  imbalance3: number | null;
  imbalance5: number | null;
  /** bps slippage to fill 15 shares (BUY vs mid); null when depth insufficient. */
  slippageBpsForSize15: number | null;
  /** Tremor-style multi-timeframe intensity (5m/1h/24h); null when sparse. */
  intensity5m: number | null;
  intensity1h: number | null;
  intensity24h: number | null;
}

export interface QualityOptions {
  minTicks?: number;
  maxTickAgeMs?: number;
  maxSpreadBps?: number;
  minDepthUsd?: number;
  /** chop → size-multiplier penalty slope (default 2.0). */
  chopPenalty?: number;
  /** Floor for the size multiplier (default 0.1). */
  minSizeMultiplier?: number;
  /** Max retained prices per asset (default 200). */
  bufferSize?: number;
}

export interface QualityAssess {
  ok: boolean;
  reasons: string[];
  features: QualityFeatures;
}

const DEFAULTS: Required<QualityOptions> = {
  minTicks: 3,
  maxTickAgeMs: 60_000,
  maxSpreadBps: 1500,
  minDepthUsd: 5,
  chopPenalty: 2.0,
  minSizeMultiplier: 0.1,
  bufferSize: 200,
};

interface Tick {
  price: number;
  ts: number;
}

export class MarketQualityTracker {
  private readonly opts: Required<QualityOptions>;
  private readonly prices = new Map<string, Tick[]>();

  constructor(options: QualityOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /** Feed a price observation (CLOB mid, last trade, etc.). */
  record(assetId: string, price: number, ts: number = Date.now()): void {
    if (!Number.isFinite(price) || price <= 0) return;
    let buf = this.prices.get(assetId);
    if (!buf) { buf = []; this.prices.set(assetId, buf); }
    buf.push({ price, ts });
    if (buf.length > this.opts.bufferSize) buf.splice(0, buf.length - this.opts.bufferSize);
  }

  /** Feed a book snapshot (used for spread/depth/imbalance features). */
  recordBook(assetId: string, book: FillBook, ts: number = Date.now()): void {
    // Mirror the book's mid into the price buffer so features stay fresh
    // even when the CLOB mid event is not wired.
    const bestAsk = book.asks[0]?.price;
    const bestBid = book.bids[0]?.price;
    if (bestAsk !== undefined && bestAsk > 0) this.record(assetId, bestAsk, book.timestamp || ts);
    else if (bestBid !== undefined && bestBid > 0) this.record(assetId, bestBid, book.timestamp || ts);
  }

  /** Current features for an asset (null when no observations). */
  features(assetId: string, book?: FillBook): QualityFeatures | null {
    const buf = this.prices.get(assetId);
    if (!buf || buf.length === 0) return null;
    const now = Date.now();
    const last = buf[buf.length - 1];
    const first = buf[0];
    let chop = 0;
    for (let i = 1; i < buf.length; i++) chop += Math.abs(buf[i].price - buf[i - 1].price);
    const spreadBps = book && book.asks[0] && book.bids[0] && book.asks[0].price > 0 && book.bids[0].price > 0
      ? ((book.asks[0].price - book.bids[0].price) / ((book.asks[0].price + book.bids[0].price) / 2)) * 10_000
      : null;
    const depthUsd = book
      ? (book.asks[0]?.price ?? 0) * (book.asks[0]?.size ?? 0) + (book.bids[0]?.price ?? 0) * (book.bids[0]?.size ?? 0)
      : 0;
    const bidUsd = book?.bids[0] ? book.bids[0].price * book.bids[0].size : 0;
    const askUsd = book?.asks[0] ? book.asks[0].price * book.asks[0].size : 0;
    const imbalance = bidUsd + askUsd > 0 ? (bidUsd - askUsd) / (bidUsd + askUsd) : null;
    const bookF = book ? this.bookFeatures(book) : null;
    const tf = scoreTimeframes(buf.map((t) => ({ price: t.price, ts: t.ts })), now);
    return {
      tickCount: buf.length,
      lastTickAgeMs: Math.max(0, now - last.ts),
      chop,
      whiplash: chop,
      signedMove: last.price - first.price,
      spreadBps,
      depthUsd,
      imbalance,
      imbalance1: bookF?.imbalance1 ?? null,
      imbalance3: bookF?.imbalance3 ?? null,
      imbalance5: bookF?.imbalance5 ?? null,
      slippageBpsForSize15: bookF?.slippageBpsForSize15 ?? null,
      intensity5m: tf.intensity5m,
      intensity1h: tf.intensity1h,
      intensity24h: tf.intensity24h,
    };
  }

  /**
   * Depth-N imbalance (1/3/5) and target-size slippage from a book, independent
   * of the price buffer. `slippageBpsForSize{15}` uses the asks VWAP to fill
   * 15 shares vs the mid; null when depth is insufficient (thin-market gate).
   */
  bookFeatures(book: FillBook): {
    imbalance1: number | null;
    imbalance3: number | null;
    imbalance5: number | null;
    slippageBpsForSize15: number | null;
  } {
    const askDepth = (n: number) => book.asks.slice(0, n).reduce((x, l) => x + l.price * l.size, 0);
    const bidDepth = (n: number) => book.bids.slice(0, n).reduce((x, l) => x + l.price * l.size, 0);
    const imb = (n: number) => {
      const b = bidDepth(n), a = askDepth(n);
      return b + a > 0 ? (b - a) / (b + a) : null;
    };
    const bestAsk = book.asks[0]?.price ?? null;
    const bestBid = book.bids[0]?.price ?? null;
    const mid = bestAsk !== null && bestBid !== null ? (bestAsk + bestBid) / 2 : null;
    let slip: number | null = null;
    if (bestAsk !== null && mid !== null && mid > 0) {
      const target = 15;
      let remaining = target;
      let cost = 0;
      for (const l of book.asks) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, l.size);
        cost += take * l.price;
        remaining -= take;
      }
      if (remaining <= 0) slip = ((cost / target - mid) / mid) * 10_000;
    }
    return { imbalance1: imb(1), imbalance3: imb(3), imbalance5: imb(5), slippageBpsForSize15: slip };
  }

  /**
   * Gate: a market is tradable only when it clears every floor.
   * reasons[] lists the violated gates (empty = ok).
   */
  assess(assetId: string, overrides: QualityOptions = {}, book?: FillBook): QualityAssess {
    const opts = { ...this.opts, ...overrides };
    const features = this.features(assetId, book);
    if (!features) return { ok: false, reasons: ['no_observations'], features: this.emptyFeatures() };
    const reasons: string[] = [];
    if (features.tickCount < opts.minTicks) reasons.push('min_ticks');
    if (features.lastTickAgeMs > opts.maxTickAgeMs) reasons.push('stale');
    if (book && opts.maxSpreadBps < Infinity && features.spreadBps !== null && features.spreadBps > opts.maxSpreadBps) reasons.push('spread');
    if (book && opts.minDepthUsd > 0 && features.depthUsd < opts.minDepthUsd) reasons.push('depth');
    return { ok: reasons.length === 0, reasons, features };
  }

  /**
   * Chop-based execution size multiplier (lens #3, risk modifier):
   * high chop → smaller size. Quiet market → 1.0. Clamped to the floor.
   */
  sizeMultiplier(assetId: string, overrides: QualityOptions = {}): number {
    const opts = { ...this.opts, ...overrides };
    const features = this.features(assetId);
    if (!features || features.tickCount < 2) return 1;
    const reduction = features.chop * opts.chopPenalty;
    return Math.max(opts.minSizeMultiplier, 1 - reduction);
  }

  private emptyFeatures(): QualityFeatures {
    return {
      tickCount: 0, lastTickAgeMs: Number.POSITIVE_INFINITY, chop: 0, whiplash: 0,
      signedMove: 0, spreadBps: null, depthUsd: 0, imbalance: null,
      imbalance1: null, imbalance3: null, imbalance5: null, slippageBpsForSize15: null,
      intensity5m: null, intensity1h: null, intensity24h: null,
    };
  }
}
