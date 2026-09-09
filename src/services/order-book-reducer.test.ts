import { describe, it, expect } from 'vitest';
import { OrderBookReducer, type BookState } from './order-book-reducer.js';

const L = (price: number, size: number) => ({ price, size });

describe('OrderBookReducer', () => {
  it('snapshot replaces both sides and computes mid/best', () => {
    const r = new OrderBookReducer();
    r.applySnapshot('asks', [L(0.53, 10), L(0.54, 20)]);
    r.applySnapshot('bids', [L(0.51, 30)]);
    expect(r.state).toBe('VALID');
    expect(r.bestAsk()).toBeCloseTo(0.53, 6);
    expect(r.bestBid()).toBeCloseTo(0.51, 6);
    expect(r.mid()).toBeCloseTo(0.52, 6);
  });

  it('a new snapshot replaces the previous levels entirely', () => {
    const r = new OrderBookReducer();
    r.applySnapshot('asks', [L(0.53, 10), L(0.54, 20)]);
    r.applySnapshot('asks', [L(0.60, 5)]); // replacement, not additive
    expect(r.bestAsk()).toBeCloseTo(0.60, 6);
    expect(r.levels('asks').size).toBe(1);
  });

  it('delta with size <= 0 deletes the level', () => {
    const r = new OrderBookReducer();
    r.applySnapshot('bids', [L(0.51, 30), L(0.50, 40)]);
    r.applyDelta('bids', 0.51, 0); // remove best bid
    expect(r.bestBid()).toBeCloseTo(0.50, 6);
    r.applyDelta('bids', 0.50, -5); // negative size also removes
    expect(r.bestBid()).toBeNull();
  });

  it('rejects malformed levels (non-finite, non-positive price)', () => {
    const r = new OrderBookReducer();
    r.applySnapshot('asks', [L(Number.NaN, 10), L(-1, 5), L(0, 3), L(0.53, 10)]);
    expect(r.bestAsk()).toBeCloseTo(0.53, 6); // only the valid one landed
    expect(r.invalidInputs).toBe(3);
  });

  it('tracks monotonic sequence and flags a gap', () => {
    const r = new OrderBookReducer();
    expect(r.applyDelta('asks', 0.53, 10, 5)).toBe(true);
    expect(r.applyDelta('asks', 0.53, 11, 6)).toBe(true);
    // Out-of-order / stale sequence is rejected, not applied
    expect(r.applyDelta('asks', 0.53, 12, 5)).toBe(false);
    expect(r.levels('asks').get(0.53)).toBeCloseTo(11, 6);
  });

  it('state transitions: VALID → STALE → RESYNCING → INVALID', () => {
    const r = new OrderBookReducer();
    expect(r.state).toBe('INVALID'); // no data yet
    r.applySnapshot('asks', [L(0.53, 10)]);
    expect(r.state).toBe('VALID');
    r.markStale();
    expect(r.state).toBe('STALE');
    r.beginResync();
    expect(r.state).toBe('RESYNCING');
    r.invalidate('sequence_gap');
    expect(r.state).toBe('INVALID');
    expect(r.lastInvalidationReason).toBe('sequence_gap');
  });

  it('a snapshot received while RESYNCING returns to VALID', () => {
    const r = new OrderBookReducer();
    r.applySnapshot('asks', [L(0.53, 10)]);
    r.beginResync();
    r.applySnapshot('asks', [L(0.53, 20)]);
    expect(r.state).toBe('VALID');
  });

  it('computes depth USD and N-level imbalance', () => {
    const r = new OrderBookReducer();
    r.applySnapshot('asks', [L(0.53, 10), L(0.54, 20)]);
    r.applySnapshot('bids', [L(0.51, 30), L(0.50, 10)]);
    expect(r.depthUsd()).toBeCloseTo(0.53 * 10 + 0.54 * 20 + 0.51 * 30 + 0.50 * 10, 6);
    const imb = r.imbalance(1); // bids0 - asks0 / (bids0 + asks0)
    const bid0 = 0.51 * 30, ask0 = 0.53 * 10;
    expect(imb).toBeCloseTo((bid0 - ask0) / (bid0 + ask0), 6);
  });

  it('rejects an unknown side', () => {
    const r = new OrderBookReducer();
    expect(() => r.applySnapshot('middle' as 'asks', [L(0.5, 1)])).toThrow();
  });
});

describe('book state type surface', () => {
  it('exposes the BookState union for metrics', () => {
    const states: BookState[] = ['VALID', 'STALE', 'RESYNCING', 'INVALID'];
    expect(states).toHaveLength(4);
  });
});