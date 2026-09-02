/**
 * Maker/taker detection unit tests.
 */

import { describe, it, expect } from 'vitest';
import { inferMakerTaker, aggregateMakerTaker, makerRateScoreBonus } from './maker-taker.js';

describe('maker-taker', () => {
  describe('inferMakerTaker', () => {
    it('returns "taker" when cashPnl is missing (conservative)', () => {
      const result = inferMakerTaker(
        { avgPrice: 0.5, realizedPnl: 10, totalBought: 100 },
        200,
      );
      expect(result).toBe('taker');
    });

    it('returns "maker" when cashPnl > realizedPnl + expected-fee (rebate)', () => {
      // 100 shares @ 0.5 = $50 notional
      // Expected fee: 50 * 0.02 = $1
      // cashPnl exceeds realizedPnl by > $0.5 → maker (rebate)
      const result = inferMakerTaker(
        {
          avgPrice: 0.5,
          realizedPnl: 5,
          cashPnl: 6.0, // $1 higher than realizedPnl → rebate
          totalBought: 100,
        },
        200,
      );
      expect(result).toBe('maker');
    });

    it('returns "taker" when cashPnl ≈ realizedPnl (full fee paid)', () => {
      const result = inferMakerTaker(
        {
          avgPrice: 0.5,
          realizedPnl: 5,
          cashPnl: 4.0, // $1 less than realizedPnl → fee
          totalBought: 100,
        },
        200,
      );
      expect(result).toBe('taker');
    });
  });

  describe('aggregateMakerTaker', () => {
    it('handles empty position list', () => {
      const stats = aggregateMakerTaker([], 200);
      expect(stats.makerFills).toBe(0);
      expect(stats.takerFills).toBe(0);
      expect(stats.makerRate).toBe(0);
    });

    it('aggregates maker/taker counts and rates', () => {
      // 2 makers (rebates → cashPnl > realizedPnl), 2 takers (fees → cashPnl < realizedPnl)
      const positions = [
        { avgPrice: 0.5, realizedPnl: 5, cashPnl: 6.0, totalBought: 100 },  // maker
        { avgPrice: 0.5, realizedPnl: 5, cashPnl: 6.0, totalBought: 100 },  // maker
        { avgPrice: 0.5, realizedPnl: 5, cashPnl: 4.0, totalBought: 100 },  // taker (paid $1 fee)
        { avgPrice: 0.5, realizedPnl: 0, totalBought: 100 },                 // taker (no cashPnl, treated as taker)
      ];
      const stats = aggregateMakerTaker(positions, 200);
      expect(stats.makerFills).toBe(2);
      expect(stats.takerFills).toBe(2);
      expect(stats.makerRate).toBe(0.5);
      // Taker fees only (makers pay no fees — they earn rebates which we don't count).
      // Total notional = 4 * 100 * 0.5 = $200
      // Total fees = (5-4) = $1 (only the 1 with cashPnl < realizedPnl)
      // avgFeeBps = 1/200 * 10000 = 50 bps
      expect(stats.avgFeeBps).toBeCloseTo(50, 6);
    });
  });

  describe('makerRateScoreBonus', () => {
    it('returns 0 for very low maker rate (no bonus)', () => {
      expect(makerRateScoreBonus(0.02)).toBe(0);
      expect(makerRateScoreBonus(0)).toBe(0);
    });

    it('returns 0.05 (max) for very high maker rate', () => {
      expect(makerRateScoreBonus(0.7)).toBe(0.05);
      expect(makerRateScoreBonus(1.0)).toBe(0.05);
    });

    it('scales linearly between 0.05 and 0.6', () => {
      // At 0.3: (0.3 - 0.05) * 0.1 = 0.025
      expect(makerRateScoreBonus(0.3)).toBeCloseTo(0.025, 6);
    });
  });
});
