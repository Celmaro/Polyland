/**
 * Entry-quality + exit tests (D1–D5): composite entry score, graded sizing,
 * R-normalized sizing, post-entry microstructure invalidation, trailing TP/SL,
 * and effective stop-loss.
 */
import { describe, it, expect } from 'vitest';
import {
  computeEntryQualityScore,
  resolveEdgeSizeMultiplier,
  applyRiskAdjustedAmount,
  shouldPostEntryInvalidate,
  trailingExitState,
  effectiveStopLoss,
} from './execution-quality.js';

describe('D1 — composite entry-quality score', () => {
  it('scores a clean entry high and a bad entry low', () => {
    const good = computeEntryQualityScore({ signalEdgeBps: 300, spreadBps: 15, minTopDepth: 500, ageSeconds: 10, weights: { edge: 0.4, spread: 0.3, depth: 0.2, freshness: 0.1 } });
    const bad = computeEntryQualityScore({ signalEdgeBps: 0, spreadBps: 1000, minTopDepth: 5, ageSeconds: 9000, weights: { edge: 0.4, spread: 0.3, depth: 0.2, freshness: 0.1 } });
    expect(good.score).toBeGreaterThan(bad.score);
    expect(good.score).toBeLessThanOrEqual(100);
  });
});

describe('D1 — graded margin sizing', () => {
  it('sizes full at the full-edge band and half otherwise', () => {
    expect(resolveEdgeSizeMultiplier(300, { fullBps: 250, floorBps: 100 }).multiplier).toBe(1);
    expect(resolveEdgeSizeMultiplier(150, { fullBps: 250, floorBps: 100 }).multiplier).toBe(0.5);
  });
});

describe('D2 — risk-normalized R sizing', () => {
  it('caps size so loss-to-stop ≈ risk budget', () => {
    const r = applyRiskAdjustedAmount({ baseUsdc: 1000, entryPrice: 0.5, stopLossPrice: 0.4, targetRiskUsdc: 20 });
    // riskPct = (0.5-0.4)/0.5 = 0.2 -> cap = 20/0.2 = 100
    expect(r.amountUsdc).toBeCloseTo(100, 4);
    expect(r.adjusted).toBe(true);
  });
  it('keeps base size when the cap is not binding', () => {
    const r = applyRiskAdjustedAmount({ baseUsdc: 100, entryPrice: 0.5, stopLossPrice: 0.4, targetRiskUsdc: 20 });
    expect(r.amountUsdc).toBe(100);
    expect(r.adjusted).toBe(false);
  });
});

describe('D3 — post-entry microstructure invalidation', () => {
  it('invalidates when spread blows past the cap for N confirmation ticks', () => {
    const r = shouldPostEntryInvalidate({ spreadBps: 900, minTopDepth: 50, maxSpreadBps: 500, minTopOfBookShares: 100, confirmationTicks: 2, tick: 2 });
    expect(r).toBe(true);
  });
  it('does not invalidate on a single transient tick (needs confirmation)', () => {
    const r = shouldPostEntryInvalidate({ spreadBps: 900, minTopDepth: 50, maxSpreadBps: 500, minTopOfBookShares: 100, confirmationTicks: 3, tick: 1 });
    expect(r).toBe(false);
  });
});

describe('D4 — trailing take-profit / stop-loss', () => {
  it('arms trailing TP after profit threshold and gives back a stage', () => {
    const s = trailingExitState({
      entry: 0.5, current: 0.65, peak: 0.68, minHoldMs: 30_000, holdMs: 60_000,
      armProfitPct: 0.20, stage1GivebackPct: 0.25, stage2TriggerPct: 0.30, stage2GivebackPct: 0.15,
    });
    // profit = (0.65-0.5)/0.5 = 0.30 >= arm 0.20 -> armed
    expect(s.armed).toBe(true);
    expect(s.stage).toBeGreaterThanOrEqual(1);
  });
  it('does not arm before the minimum hold', () => {
    const s = trailingExitState({
      entry: 0.5, current: 0.65, peak: 0.68, minHoldMs: 30_000, holdMs: 5_000,
      armProfitPct: 0.20, stage1GivebackPct: 0.25, stage2TriggerPct: 0.30, stage2GivebackPct: 0.15,
    });
    expect(s.armed).toBe(false);
  });
});

describe('D5 — effective stop-loss with floor + high-price scaling', () => {
  it('applies an absolute floor', () => {
    const stop = effectiveStopLoss({ entryPrice: 0.5, stopPct: 0.35, absoluteFloor: 0.36 });
    // relative = 0.5*0.65 = 0.325 < floor 0.36 -> floor wins
    expect(stop).toBeCloseTo(0.36, 4);
  });
  it('uses a steeper stop for high-price entries', () => {
    const normal = effectiveStopLoss({ entryPrice: 0.5, stopPct: 0.35, highPriceThreshold: 0.7, highPricePct: 0.45 });
    const high = effectiveStopLoss({ entryPrice: 0.8, stopPct: 0.35, highPriceThreshold: 0.7, highPricePct: 0.45 });
    // high entry uses 45% loss allowance vs normal 35%; its stop is lower
    // relative to entry, though the absolute price is higher.
    expect((0.8 - high) / 0.8).toBeGreaterThan((0.5 - normal) / 0.5);
  });
});