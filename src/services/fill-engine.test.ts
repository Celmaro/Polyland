/**
 * fill-engine tests — the ONE depth-consumption model shared by replay and
 * live execution (P1-5). Live dry-run and historical replay must price fills
 * identically: level-by-level depth walk, min-order-size respect, VWAP,
 * partial-fill detection, and an optional price cap (limit ceiling).
 */
import { describe, it, expect } from 'vitest';
import { executeAgainstBook, type FillBook } from './fill-engine.js';

const BOOK: FillBook = {
  asks: [
    { price: 0.60, size: 100 },
    { price: 0.61, size: 50 },
    { price: 0.62, size: 200 },
  ],
  bids: [
    { price: 0.58, size: 100 },
    { price: 0.57, size: 50 },
  ],
  minOrderSize: 1,
  tickSize: 0.01,
  timestamp: 1_700_000_000_000,
};

describe('executeAgainstBook (shared fill engine)', () => {
  it('walks the book level by level and returns the executable VWAP', () => {
    const r = executeAgainstBook({ side: 'BUY', size: 120 }, BOOK);
    expect(r.verdict).toBe('filled');
    expect(r.fills).toEqual([
      { price: 0.60, shares: 100 },
      { price: 0.61, shares: 20 },
    ]);
    expect(r.executableSize).toBe(120);
    // (0.60*100 + 0.61*20) / 120
    expect(r.executableVwap).toBeCloseTo(0.6016667, 6);
    expect(r.partiallyFillable).toBe(false);
  });

  it('detects a partial fill when depth is insufficient', () => {
    const r = executeAgainstBook({ side: 'BUY', size: 400 }, BOOK);
    expect(r.verdict).toBe('filled');
    expect(r.executableSize).toBe(350);
    expect(r.partiallyFillable).toBe(true);
  });

  it('uses bids for SELL orders', () => {
    const r = executeAgainstBook({ side: 'SELL', size: 80 }, BOOK);
    expect(r.verdict).toBe('filled');
    expect(r.fills[0]).toEqual({ price: 0.58, shares: 80 });
    expect(r.executableVwap).toBeCloseTo(0.58, 6);
  });

  it('returns no_levels when the executable side is empty', () => {
    const r = executeAgainstBook({ side: 'BUY', size: 10 }, { ...BOOK, asks: [] });
    expect(r.verdict).toBe('no_levels');
    expect(r.executableSize).toBe(0);
  });

  it('skips levels below min order size and blocks when none qualify', () => {
    const r = executeAgainstBook({ side: 'BUY', size: 10 }, { ...BOOK, asks: [{ price: 0.60, size: 0.5 }], minOrderSize: 1 });
    expect(r.verdict).toBe('below_min_order');
    expect(r.executableSize).toBe(0);
  });

  it('does not consume levels beyond an optional max price cap (limit ceiling)', () => {
    const r = executeAgainstBook({ side: 'BUY', size: 1000, maxPrice: 0.61 }, BOOK);
    expect(r.executableSize).toBe(150); // 100 @ 0.60 + 50 @ 0.61; 0.62 skipped
    expect(r.executableVwap).toBeCloseTo((0.60 * 100 + 0.61 * 50) / 150, 6);
    expect(r.partiallyFillable).toBe(true);
  });
});