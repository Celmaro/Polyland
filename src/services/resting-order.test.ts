/**
 * RestingOrderBook tests — the fired=0 fix.
 *
 * Root cause (verified in prod logs): the leader's trade consumes the asks;
 * by the time our fire re-queries the book, bestAsk=0.99 and nothing fills.
 * Fix: place a RESTING limit order at the consensus ceiling, and a periodic
 * refill pass fills it when asks return INTO the band (the leader's own fill
 * proves they do). Dry-run simulates this exactly like the shared fill-engine.
 */
import { describe, it, expect } from 'vitest';
import { RestingOrderBook, type RestingOrder } from './resting-order.js';

const T0 = 1_700_000_000_000;

function restingOrder(over: Partial<RestingOrder> = {}): RestingOrder {
  return {
    id: 'ro-1',
    conditionId: 'c1',
    tokenId: 'tok-1',
    outcome: 'Yes',
    side: 'BUY',
    ceiling: 0.60,
    size: 10,
    placedAt: T0,
    ttlMs: 3_600_000,
    signalId: 'sig-1',
    ...over,
  };
}

describe('RestingOrderBook — place/query', () => {
  it('places an order and reports it open', () => {
    const book = new RestingOrderBook();
    const o = restingOrder();
    book.place(o);
    expect(book.openOrders().map((x) => x.id)).toEqual(['ro-1']);
  });

  it('rejects a duplicate order id (idempotent placement)', () => {
    const book = new RestingOrderBook();
    book.place(restingOrder());
    book.place(restingOrder()); // same id -> no-op
    expect(book.openOrders()).toHaveLength(1);
  });
});

describe('RestingOrderBook — refill pass (the fired=0 fix)', () => {
  it('fills when the best ask returns to or below the ceiling', () => {
    const book = new RestingOrderBook();
    book.place(restingOrder()); // ceiling 0.60, size 10
    const now = T0 + 5_000;
    // Ask returns to 0.58 (leader's band) with depth.
    const fills = book.refill(
      { tokenId: 'tok-1', asks: [{ price: 0.58, size: 100 }], bids: [] },
      now,
    );
    expect(fills).toHaveLength(1);
    expect(fills[0].orderId).toBe('ro-1');
    expect(fills[0].price).toBeCloseTo(0.58, 6);
    expect(fills[0].shares).toBe(10);
    expect(book.openOrders()).toHaveLength(0); // fully filled -> closed
    expect(book.closedOrders()).toHaveLength(1);
  });

  it('partially fills when depth is insufficient and keeps the remainder resting', () => {
    const book = new RestingOrderBook();
    book.place(restingOrder({ size: 10 }));
    const fills = book.refill(
      { tokenId: 'tok-1', asks: [{ price: 0.58, size: 4 }], bids: [] },
      T0 + 1_000,
    );
    expect(fills[0].shares).toBe(4);
    const remaining = book.openOrders()[0];
    expect(remaining.size - (remaining.filledShares ?? 0)).toBe(6); // rest still resting
  });

  it('does NOT fill above the ceiling (only fills inside the band)', () => {
    const book = new RestingOrderBook();
    book.place(restingOrder({ ceiling: 0.60 }));
    const fills = book.refill(
      { tokenId: 'tok-1', asks: [{ price: 0.99, size: 100 }], bids: [] },
      T0 + 1_000,
    );
    expect(fills).toHaveLength(0);
    expect(book.openOrders()).toHaveLength(1);
  });

  it('expires an order past its TTL (no zombie resting orders)', () => {
    const book = new RestingOrderBook();
    book.place(restingOrder({ ttlMs: 60_000 }));
    const fills = book.refill(
      { tokenId: 'tok-1', asks: [{ price: 0.58, size: 100 }], bids: [] },
      T0 + 120_000,
    );
    expect(fills).toHaveLength(0); // expired before it could fill
    expect(book.openOrders()).toHaveLength(0);
    expect(book.expiredCount()).toBe(1);
  });

  it('survives restart (durable restore)', () => {
    const book = new RestingOrderBook();
    book.place(restingOrder());
    const snapshot = book.snapshot();
    const book2 = new RestingOrderBook();
    book2.restore(snapshot);
    expect(book2.openOrders()).toHaveLength(1);
  });
});