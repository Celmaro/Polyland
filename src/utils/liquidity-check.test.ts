/**
 * Liquidity check unit tests.
 */

import { describe, it, expect } from 'vitest';
import { buildOrderBookSummary } from './liquidity-check.js';

describe('buildOrderBookSummary', () => {
  it('parses bids and asks correctly', () => {
    const summary = buildOrderBookSummary({
      bids: [
        { price: '0.49', size: '100' },
        { price: '0.48', size: '200' },
      ],
      asks: [
        { price: '0.51', size: '150' },
        { price: '0.52', size: '250' },
      ],
    });
    expect(summary.bestBid).toBe(0.49);
    expect(summary.bestAsk).toBe(0.51);
    expect(summary.mid).toBeCloseTo(0.5, 6);
    expect(summary.spread).toBeCloseTo(0.02, 6);
    expect(summary.bidLiquidityUsdc).toBeCloseTo(100 * 0.49 + 200 * 0.48, 6);
    expect(summary.askLiquidityUsdc).toBeCloseTo(150 * 0.51 + 250 * 0.52, 6);
  });

  it('handles empty book gracefully', () => {
    const summary = buildOrderBookSummary({});
    expect(summary.bestBid).toBe(0);
    expect(summary.bestAsk).toBe(0);
    expect(summary.mid).toBe(0);
  });

  it('drops invalid levels (price<=0 or size<=0)', () => {
    const summary = buildOrderBookSummary({
      bids: [
        { price: '0', size: '100' },
        { price: '0.49', size: '0' },
        { price: '0.49', size: '100' },
      ],
      asks: [],
    });
    expect(summary.bids.length).toBe(1);
  });

  describe('hasSufficientLiquidity (2x rule)', () => {
    it('rejects BUY on empty book', () => {
      const summary = buildOrderBookSummary({ bids: [], asks: [] });
      const result = summary.hasSufficientLiquidity({
        side: 'BUY',
        shares: 100,
        price: 0.5,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/empty_book/);
    });

    it('passes when book has > 2x the required notional', () => {
      const summary = buildOrderBookSummary({
        bids: [],
        asks: [
          { price: '0.50', size: '1000' }, // $500 at top
        ],
      });
      // Need 100 shares * 0.50 = $50, * 2 = $100 → 1000 shares at 0.50 = $500 > $100 ✓
      const result = summary.hasSufficientLiquidity({
        side: 'BUY',
        shares: 100,
        price: 0.5,
        multiplier: 2,
      });
      expect(result.ok).toBe(true);
      expect(result.unfilledShares).toBe(0);
    });

    it('rejects when book is exactly at the threshold (not 2x)', () => {
      const summary = buildOrderBookSummary({
        bids: [],
        asks: [
          { price: '0.50', size: '50' }, // $25 at top
        ],
      });
      // Need 100 shares * 0.50 = $50, * 2 = $100 → $25 < $100 ✗
      const result = summary.hasSufficientLiquidity({
        side: 'BUY',
        shares: 100,
        price: 0.5,
        multiplier: 2,
      });
      expect(result.ok).toBe(false);
    });

    it('walks multiple levels to fill larger orders', () => {
      const summary = buildOrderBookSummary({
        bids: [],
        asks: [
          { price: '0.50', size: '50' },  // $25
          { price: '0.55', size: '100' }, // $55
          { price: '0.60', size: '200' }, // $120
        ],
      });
      // The actual 200-share fill crosses levels: $25 + $55 + $30 = $110;
      // the 2x requirement is $220, while the complete book has $200.
      // The price-aware check must reject this thin book.
      const result = summary.hasSufficientLiquidity({
        side: 'BUY',
        shares: 200,
        price: 0.5,
        multiplier: 2,
      });
      expect(result.ok).toBe(false);
      expect(result.unfilledShares).toBe(0);
    });

    it('SELL side uses bids, not asks', () => {
      const summary = buildOrderBookSummary({
        bids: [{ price: '0.40', size: '500' }], // $200 liquidity
        asks: [],
      });
      // SELL 100 shares at 0.40 = $40, * 2 = $80 → $200 > $80 ✓
      const result = summary.hasSufficientLiquidity({
        side: 'SELL',
        shares: 100,
        price: 0.4,
        multiplier: 2,
      });
      expect(result.ok).toBe(true);
    });

    it('computes VWAP correctly when walking the book', () => {
      const summary = buildOrderBookSummary({
        bids: [],
        asks: [
          { price: '0.50', size: '10' },
          { price: '0.60', size: '10' },
        ],
      });
      // Buy 20 shares: 10 at 0.50 + 10 at 0.60
      // VWAP = (10*0.50 + 10*0.60) / 20 = 11/20 = 0.55
      const result = summary.hasSufficientLiquidity({
        side: 'BUY',
        shares: 20,
        price: 0.55,
        multiplier: 1, // disable for this test
      });
      expect(result.vwap).toBeCloseTo(0.55, 6);
    });
  });
});
