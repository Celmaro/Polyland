import { describe, expect, it } from 'vitest';
import { CopyPlanner, executableVwap, takerFeePerShare, binaryKellyFraction, type CopyBook, type LeaderSignal, type MarketMeta } from './copy-planner.js';

const NOW = Date.now();
const book: CopyBook = {
  bids: [
    { price: 0.48, size: 500 },
    { price: 0.47, size: 800 },
  ],
  asks: [
    { price: 0.505, size: 200 },
    { price: 0.51, size: 400 },
  ],
  ageMs: 50,
};
const meta: MarketMeta = { tickSize: 0.01, minNotional: 1, takerFeeRateBps: 70, acceptingOrders: true };
const cfg = {
  maxSlippagePct: 0.02,
  maxBookAgeMs: 500,
  fractionalKelly: 0.25,
  capitalUsd: 10_000,
  basketHeadroomUsd: 2_000,
  maxSizeUsd: 500,
  reliabilityFloor: 0.4,
  defaultOrderType: 'FAK' as const,
};
const signal: LeaderSignal = {
  wallet: '0xwallet',
  conditionId: 'cond-1',
  tokenId: 'token-1',
  side: 'BUY',
  size: 100,
  price: 0.50,
  timestamp: NOW - 1000,
  fairProb: 0.60,
  reliability: 0.8,
  executionConfidence: 0.9,
  independenceAdjustment: 1,
};

describe('CopyPlanner', () => {
  it('executableVwap consumes the book from best level', () => {
    expect(executableVwap([{ price: 0.5, size: 100 }, { price: 0.6, size: 100 }], 150)).toEqual({ price: (0.5 * 100 + 0.6 * 50) / 150, filled: 150 });
    expect(executableVwap([], 10)).toBeNull();
    expect(executableVwap([{ price: 0.5, size: 10 }], 0)).toBeNull();
  });

  it('computes the price-dependent taker fee', () => {
    expect(takerFeePerShare(0.5, 70)).toBeCloseTo(0.007 * 0.25, 6); // rate 70bps = 0.007 × p(1−p) = 0.25
    expect(takerFeePerShare(0.5, 0)).toBe(0);
    expect(takerFeePerShare(0.95, 40)).toBeCloseTo(0.004 * 0.0475, 6);
  });

  it('binaryKellyFraction blends belief with the market price', () => {
    expect(binaryKellyFraction(0.6, 0.5)).toBeCloseTo(0.2, 6);
    expect(binaryKellyFraction(0.5, 0.5)).toBe(0);
    expect(binaryKellyFraction(0.4, 0.5)).toBe(0);
    expect(binaryKellyFraction(0.9, 0.5)).toBeCloseTo(0.8, 6);
  });

  it('plans a BUY from the executable ask VWAP, quantized, with edge and capped size', () => {
    const p = new CopyPlanner(cfg);
    const d = p.plan(signal, book, meta);
    expect(d.accepted).toBe(true);
    if (!d.accepted) return;
    expect(d.plan.shares).toBeGreaterThan(0);
    // vwap of first 100 shares: all 100 at 0.505
    expect(d.plan.executablePrice).toBeCloseTo(0.505, 6);
    expect(d.plan.price).toBeLessThanOrEqual(d.plan.executablePrice + 1e-9);
    expect(d.plan.orderType).toBe('FAK');
    expect(d.plan.costUsd).toBeGreaterThan(0);
  });

  it('rejects when the executable price drifted beyond tolerance', () => {
    const p = new CopyPlanner(cfg);
    const badBook: CopyBook = { ...book, asks: [{ price: 0.60, size: 500 }], ageMs: 50 };
    const d = p.plan(signal, badBook, meta);
    expect(d.accepted).toBe(false);
    if (!d.accepted) expect(d.reason).toBe('drift');
  });

  it('rejects stale books, closed markets, low reliability, and bad input', () => {
    const p = new CopyPlanner(cfg);
    expect(p.plan(signal, { ...book, ageMs: 10_000 }, meta)).toMatchObject({ accepted: false, reason: 'stale_book' });
    expect(p.plan(signal, book, { ...meta, acceptingOrders: false })).toMatchObject({ accepted: false, reason: 'market_closed' });
    expect(p.plan({ ...signal, reliability: 0.1 }, book, meta)).toMatchObject({ accepted: false, reason: 'low_reliability' });
    expect(p.plan(null as unknown as LeaderSignal, book, meta)).toMatchObject({ accepted: false, reason: 'bad_input' });
  });

  it('rejects when there is no edge after fee and slippage buffer', () => {
    const p = new CopyPlanner(cfg);
    const noEdge = p.plan({ ...signal, fairProb: 0.505 }, book, meta);
    expect(noEdge.accepted).toBe(false);
    if (!noEdge.accepted) expect(noEdge.reason).toBe('no_edge');
  });

  it('rejects when basket headroom or capital caps size to zero', () => {
    const p = new CopyPlanner(cfg);
    const capped = p.plan(signal, book, { ...meta, minNotional: 10_000 });
    expect(capped.accepted).toBe(false);
    if (!capped.accepted) expect(capped.reason).toBe('below_min');
  });

  it('plans a SELL from the executable bid VWAP for the exit engine', () => {
    const p = new CopyPlanner(cfg);
    const sellSig: LeaderSignal = { ...signal, side: 'SELL', price: 0.485, fairProb: 0.4 };
    const d = p.plan(sellSig, book, meta);
    expect(d.accepted).toBe(true);
    if (!d.accepted) return;
    expect(d.plan.side).toBe('SELL');
    // best bid 0.48 must pass the drift gate: 0.48 >= 0.485 * (1-0.02)=0.4753
    expect(d.plan.price).toBeLessThanOrEqual(0.48 + 1e-9);
    expect(d.plan.shares).toBe(100);
  });
});