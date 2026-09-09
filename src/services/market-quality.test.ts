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
});