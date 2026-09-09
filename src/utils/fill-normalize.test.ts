import { describe, it, expect } from 'vitest';
import { tradeUsdFromLegs, fillPriceFromUsdAndShares, sharesFromFill, normalizeFill } from './fill-normalize.js';

describe('tradeUsdFromLegs', () => {
  it('uses the LEAST of the two legs (both legs are USDC-notional at fill)', () => {
    expect(tradeUsdFromLegs(1_250_000n, 1_250_000n)).toBeCloseTo(1.25, 9);
    expect(tradeUsdFromLegs(2_000_000n, 1_500_000n)).toBeCloseTo(1.50, 9);
  });
  it('handles 0 legs as 0', () => {
    expect(tradeUsdFromLegs(0n, 5n)).toBe(0);
  });
  it('scaled float inputs bypass the 6-decimal conversion', () => {
    expect(tradeUsdFromLegs(100, 100, true)).toBeCloseTo(100, 9);
  });
});

describe('fillPriceFromUsdAndShares', () => {
  it('price = collateral USD / share count', () => {
    expect(fillPriceFromUsdAndShares(100, 200)).toBeCloseTo(0.50, 9);
    expect(fillPriceFromUsdAndShares(25.5, 100)).toBeCloseTo(0.255, 9);
  });
  it('returns null when shares are non-positive', () => {
    expect(fillPriceFromUsdAndShares(100, 0)).toBeNull();
    expect(fillPriceFromUsdAndShares(100, -1)).toBeNull();
  });
});

describe('sharesFromFill', () => {
  it('derives shares from usd size and price', () => {
    expect(sharesFromFill(10, 0.50)).toBeCloseTo(20, 9);
  });
  it('returns 0 for price <= 0', () => {
    expect(sharesFromFill(10, 0)).toBe(0);
  });
});

describe('normalizeFill', () => {
  it('canonicalizes a maker BUY: collateral leg + decoded share count', () => {
    // Maker pays 100 USDC (100e6 6-dec) for 200 shares → price 0.50
    const f = normalizeFill({ makerAmountFilled: 100_000_000n, takerAmountFilled: 100_000_000n, shares: 200, makerSide: 'BUY' });
    expect(f).not.toBeNull();
    expect(f!.price).toBeCloseTo(0.50, 9);
    expect(f!.usd).toBeCloseTo(100, 9);
    expect(f!.shares).toBeCloseTo(200, 9);
  });
  it('canonicalizes a maker SELL with the same model', () => {
    // Maker delivers 200 shares, receives 100 USDC
    const f = normalizeFill({ makerAmountFilled: 100_000_000n, takerAmountFilled: 100_000_000n, shares: 200, makerSide: 'SELL' });
    expect(f!.price).toBeCloseTo(0.50, 9);
    expect(f!.usd).toBeCloseTo(100, 9);
    expect(f!.shares).toBeCloseTo(200, 9);
  });
  it('accepts scaled float legs', () => {
    const f = normalizeFill({ makerAmountFilled: 100, takerAmountFilled: 100, shares: 100, makerSide: 'BUY', scaled: true });
    expect(f!.price).toBeCloseTo(1, 9);
    expect(f!.usd).toBeCloseTo(100, 9);
  });
  it('returns null when legs are missing or degenerate', () => {
    expect(normalizeFill({ makerAmountFilled: undefined, takerAmountFilled: 5n, shares: 5, makerSide: 'BUY' })).toBeNull();
    expect(normalizeFill({ makerAmountFilled: 0n, takerAmountFilled: 5n, shares: 5, makerSide: 'BUY' })).toBeNull();
    expect(normalizeFill({ makerAmountFilled: 100n, takerAmountFilled: 100n, shares: 0, makerSide: 'BUY' })).toBeNull();
  });
});