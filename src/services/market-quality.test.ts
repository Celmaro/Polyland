import { describe, it, expect } from 'vitest';
import { MarketQualityTracker } from './market-quality.js';
import type { FillBook } from './fill-engine.js';

const book = (asks: { price: number; size: number }[], bids: { price: number; size: number }[], ts = Date.now()): FillBook => ({
  asks, bids, minOrderSize: 0, tickSize: 0.01, timestamp: ts,
});

describe('MarketQualityTracker', () => {
  it('rejects an asset with no observations (minTicks)', () => {
    const t = new MarketQualityTracker({ minTicks: 3 });
    expect(t.assess('t1', { minTicks: 3 }).ok).toBe(false);
  });

  it('accepts a fresh, liquid, tight-spread asset', () => {
    const t = new MarketQualityTracker({ minTicks: 3 });
    const now = Date.now();
    [0.5, 0.51, 0.52].forEach((p, i) => t.record('t1', p, now - (10 - i) * 1000));
    const r = t.assess('t1', { minTicks: 3, maxTickAgeMs: 60_000, minDepthUsd: 20, maxSpreadBps: 1000 }, book(
      [{ price: 0.53, size: 100 }], [{ price: 0.51, size: 100 }], now,
    ));
    expect(r.ok).toBe(true);
    expect(r.features.depthUsd).toBeGreaterThan(0);
    expect(r.features.spreadBps).toBeLessThan(400);
  });

  it('rejects a stale tick older than maxTickAgeMs', () => {
    const t = new MarketQualityTracker({ minTicks: 1 });
    t.record('t1', 0.5, Date.now() - 300_000);
    const r = t.assess('t1', { maxTickAgeMs: 60_000 });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('stale');
  });

  it('rejects a book with insufficient depth (thin-market gate)', () => {
    const t = new MarketQualityTracker({ minTicks: 1 });
    t.record('t1', 0.5, Date.now());
    const r = t.assess('t1', { minDepthUsd: 50 }, book([{ price: 0.51, size: 1 }], [{ price: 0.49, size: 1 }]));
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('depth');
  });

  it('rejects a book with an excessive spread', () => {
    const t = new MarketQualityTracker({ minTicks: 1 });
    t.record('t1', 0.5, Date.now());
    const r = t.assess('t1', { maxSpreadBps: 300 }, book([{ price: 0.60, size: 100 }], [{ price: 0.40, size: 100 }]));
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('spread');
  });

  it('computes chop (Σ|Δp|) and signed movement with direction', () => {
    const t = new MarketQualityTracker({ minTicks: 5 });
    const now = Date.now();
    // Chop: up 0.05 then down 0.05 → Σ|Δp| = 0.10
    [0.50, 0.55, 0.50].forEach((p, i) => t.record('t1', p, now - (20 - i) * 1000));
    // Signed move over the buffer: last 0.50 - first 0.50 = 0
    const f = t.features('t1');
    expect(f).not.toBeNull();
    expect(f!.chop).toBeCloseTo(0.10, 9);
    expect(f!.signedMove).toBeCloseTo(0, 9);
    // New uptrend: 0.50 → 0.60 → signed move +0.10
    t.record('t1', 0.55, now - 5_000);
    t.record('t1', 0.60, now);
    const f2 = t.features('t1')!;
    expect(f2.signedMove).toBeCloseTo(0.10, 9);
  });

  it('chop reduces the execution size multiplier (risk modifier, clamped)', () => {
    const t = new MarketQualityTracker({ minTicks: 3, chopPenalty: 2 });
    const now = Date.now();
    [0.50, 0.60, 0.50].forEach((p, i) => t.record('t1', p, now - (10 - i) * 1000));
    const mul = t.sizeMultiplier('t1');
    expect(mul).toBeGreaterThanOrEqual(0.1);
    expect(mul).toBeLessThan(1);
    // A quiet asset keeps the full multiplier
    const t2 = new MarketQualityTracker({ minTicks: 3 });
    [0.50, 0.50, 0.50].forEach((p, i) => t2.record('t2', p, now - (10 - i) * 1000));
    expect(t2.sizeMultiplier('t2')).toBe(1);
  });

  it('computes depth-N imbalance from the book (top 1/3/5 levels)', () => {
    const t = new MarketQualityTracker({ minTicks: 1 });
    const now = Date.now();
    t.record('t1', 0.5, now);
    const f = t.bookFeatures(book(
      [{ price: 0.53, size: 10 }, { price: 0.54, size: 30 }, { price: 0.55, size: 60 }],
      [{ price: 0.51, size: 100 }, { price: 0.50, size: 50 }, { price: 0.49, size: 20 }],
      now,
    ));
    const bid1 = 0.51 * 100, ask1 = 0.53 * 10;
    expect(f.imbalance1).toBeCloseTo((bid1 - ask1) / (bid1 + ask1), 6);
    const bid3 = 0.51 * 100 + 0.50 * 50 + 0.49 * 20;
    const ask3 = 0.53 * 10 + 0.54 * 30 + 0.55 * 60;
    expect(f.imbalance3).toBeCloseTo((bid3 - ask3) / (bid3 + ask3), 6);
    expect(f.imbalance5).not.toBeNull();
  });

  it('computes slippage bps to fill a target size (asks VWAP vs mid)', () => {
    const t = new MarketQualityTracker({ minTicks: 1 });
    const now = Date.now();
    t.record('t1', 0.5, now);
    // 15 shares: 10 @ 0.53 + 5 @ 0.54 → VWAP (5.3+2.7)/15 = 0.5333 vs mid 0.52
    const f2 = t.bookFeatures(book(
      [{ price: 0.53, size: 10 }, { price: 0.54, size: 30 }],
      [{ price: 0.51, size: 100 }],
      now,
    ));
    const vwap = (0.53 * 10 + 0.54 * 5) / 15;
    const mid = 0.52;
    expect(f2.slippageBpsForSize15).toBeCloseTo(((vwap - mid) / mid) * 10_000, 2);
    // Insufficient depth for the target → null (thin-market gate)
    const shallow = t.bookFeatures(book(
      [{ price: 0.53, size: 10 }],
      [{ price: 0.51, size: 100 }],
      now,
    ));
    expect(shallow.slippageBpsForSize15).toBeNull();
  });

  it('exposes Tremor-style 5m intensity from the retained price buffer', () => {
    const t = new MarketQualityTracker({ minTicks: 3 });
    const now = Date.now();
    // 0.50 → 0.58 across 4 ticks within the last minute → +8pp in 5m window
    [0.50, 0.52, 0.55, 0.58].forEach((p, i) => t.record('t1', p, now - (4 - i) * 10_000));
    const f = t.features('t1')!;
    expect(f.intensity5m).not.toBeNull();
    expect(f.intensity5m!).toBeGreaterThan(0);
    expect(f.intensity1h).not.toBeNull();
    // no ticks within the 24h window → 24h intensity stays null (never a guessed 0)
    const t2 = new MarketQualityTracker({ minTicks: 3 });
    t2.record('t2', 0.5, now - 25 * 3_600_000);
    t2.record('t2', 0.6, now);
    expect(t2.features('t2')!.intensity24h).toBeNull();
  });
});