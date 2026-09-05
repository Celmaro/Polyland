/** Point-in-time invariants. */
import { describe, expect, it } from 'vitest';
import {
  assertNoLookahead,
  effectiveAtSegment,
  isBeforeResolution,
  isTimeInRange,
  stripFutureFields,
} from './point-in-time.js';
describe('point-in-time helpers', () => {
  it('checks an inclusive time range', () => {
    expect(isTimeInRange(10, 10, 20)).toBe(true);
    expect(isTimeInRange(20, 10, 20)).toBe(true);
    expect(isTimeInRange(21, 10, 20)).toBe(false);
  });
  it('reports adjacent replay gaps and preserves segment timestamps', () => {
    expect(effectiveAtSegment(1000, 1100, 1300, 1400, 1700)).toEqual({
      maxGapMs: 300,
      segments: [
        { name: 'trade', tsMs: 1000 },
        { name: 'discovery', tsMs: 1100 },
        { name: 'decision', tsMs: 1300 },
        { name: 'order', tsMs: 1400 },
        { name: 'fill', tsMs: 1700 },
      ],
    });
  });
  it('omits absent timestamps from the segment timeline', () => {
    expect(effectiveAtSegment(1000, undefined, 1600, undefined, 2000)).toEqual({
      maxGapMs: 600,
      segments: [
        { name: 'trade', tsMs: 1000 },
        { name: 'decision', tsMs: 1600 },
        { name: 'fill', tsMs: 2000 },
      ],
    });
  });
  it('checks resolution strictly', () => {
    expect(isBeforeResolution(99, 100)).toBe(true);
    expect(isBeforeResolution(100, 100)).toBe(false);
    expect(isBeforeResolution(100, undefined)).toBe(true);
  });
  it('strips resolution and future-derived fields', () => {
    const record = {
      candidateId: 'c1', wallet: 'w', price: 0.4, resolution: 'YES',
      settlementPnl: 2, followerExecutablePnl: 1, leaderboardRank: 3,
      category: 'politics', discoveredAt: 10,
    };
    expect(stripFutureFields(record)).toEqual({
      candidateId: 'c1', wallet: 'w', price: 0.4, discoveredAt: 10,
    });
  });
  it('flags future timestamps and outcome fields', () => {
    expect(assertNoLookahead({ decidedAt: 200, resolvedAt: 300 }, 250)).toEqual({
      ok: false,
      violations: ['resolvedAt is after resolution'],
    });
    expect(assertNoLookahead({ settlementPnl: 1 }, 250).ok).toBe(false);
    expect(assertNoLookahead({ decidedAt: 200 }, 250)).toEqual({ ok: true, violations: [] });
  });
});
