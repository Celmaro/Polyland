/**
 * Fee math unit tests.
 */

import { describe, it, expect } from 'vitest';
import {
  takerFeePerShare,
  feePerShare,
  expectedEdgeBuy,
  expectedEdgeSell,
  roundTripTakerCost,
  breakEvenWinRate,
  DEFAULT_FEE_RATE_BPS,
  MAKER_FEE_BPS,
} from './fee-math.js';

describe('fee-math', () => {
  describe('takerFeePerShare', () => {
    it('returns 0 at price=0 or price=1 (edge cases)', () => {
      expect(takerFeePerShare(0, 200)).toBe(0);
      expect(takerFeePerShare(1, 200)).toBe(0);
    });

    it('maximizes at price=0.5 (Polymarket quadratic curve)', () => {
      const feeAt50 = takerFeePerShare(0.5, 200);
      const feeAt25 = takerFeePerShare(0.25, 200);
      const feeAt75 = takerFeePerShare(0.75, 200);
      expect(feeAt50).toBeGreaterThan(feeAt25);
      expect(feeAt50).toBeGreaterThan(feeAt75);
      // At price=0.5, feeRate=200bps: 0.02 * 0.5 * 0.5 = 0.005
      expect(feeAt50).toBeCloseTo(0.005, 6);
    });

    it('symmetric around 0.5', () => {
      expect(takerFeePerShare(0.3, 200)).toBeCloseTo(
        takerFeePerShare(0.7, 200), 6
      );
    });

    it('scales linearly with fee rate', () => {
      const fee100 = takerFeePerShare(0.5, 100);
      const fee300 = takerFeePerShare(0.5, 300);
      expect(fee300 / fee100).toBeCloseTo(3, 6);
    });
  });

  describe('feePerShare', () => {
    it('is 0 for maker orders', () => {
      expect(feePerShare(0.5, 200, true)).toBe(0);
    });

    it('matches taker fee for taker orders', () => {
      expect(feePerShare(0.5, 200, false)).toBe(
        takerFeePerShare(0.5, 200)
      );
    });
  });

  describe('expectedEdgeBuy', () => {
    it('is positive when win rate beats implied + fee', () => {
      const edge = expectedEdgeBuy(0.7, 0.5, 200, false);
      // 0.7 - 0.5 - 0.005 = 0.195
      expect(edge).toBeCloseTo(0.195, 6);
    });

    it('is zero at break-even', () => {
      const price = 0.5;
      const fee = takerFeePerShare(price, 200);
      const edge = expectedEdgeBuy(price + fee, price, 200, false);
      expect(edge).toBeCloseTo(0, 6);
    });

    it('is negative for sure-loss trades', () => {
      const edge = expectedEdgeBuy(0.4, 0.5, 200, false);
      expect(edge).toBeLessThan(0);
    });

    it('maker edge > taker edge (revenue vs fee)', () => {
      const makerEdge = expectedEdgeBuy(0.7, 0.5, 200, true);
      const takerEdge = expectedEdgeBuy(0.7, 0.5, 200, false);
      expect(makerEdge).toBeGreaterThan(takerEdge);
    });
  });

  describe('expectedEdgeSell', () => {
    it('mirrors BUY math for SELL', () => {
      const price = 0.6;
      const fee = takerFeePerShare(price, 200);
      // For SELL: edge = price - winRate - fee
      // To be profitable: winRate < price - fee
      const edge = expectedEdgeSell(0.3, price, 200, false);
      // 0.6 - 0.3 - 0.0048 = 0.2952
      expect(edge).toBeCloseTo(0.2952, 4);
    });
  });

  describe('roundTripTakerCost', () => {
    it('is 2x the one-way taker fee', () => {
      const rt = roundTripTakerCost(0.5, 200);
      expect(rt).toBeCloseTo(2 * takerFeePerShare(0.5, 200), 6);
    });

    it('at 200bps taker rate and 50c price, round-trip is 1%', () => {
      expect(roundTripTakerCost(0.5, 200)).toBeCloseTo(0.01, 6);
    });
  });

  describe('breakEvenWinRate', () => {
    it('matches the formula winRate = price + fee', () => {
      const ber = breakEvenWinRate(0.5, 200, false);
      expect(ber).toBeCloseTo(0.5 + takerFeePerShare(0.5, 200), 6);
    });

    it('maker break-even is just the price (no fee)', () => {
      expect(breakEvenWinRate(0.5, 200, true)).toBeCloseTo(0.5, 6);
    });
  });

  describe('constants', () => {
    it('DEFAULT_FEE_RATE_BPS is 200', () => {
      expect(DEFAULT_FEE_RATE_BPS).toBe(200);
    });

    it('MAKER_FEE_BPS is 0', () => {
      expect(MAKER_FEE_BPS).toBe(0);
    });
  });
});
