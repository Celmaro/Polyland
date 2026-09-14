import { describe, it, expect } from 'vitest';
import { reconcileLiveResting, type LiveVenueOrder } from './live-reconcile.js';
import type { RestingOrder } from './resting-order.js';

const base = (id: string, over: Partial<RestingOrder> = {}): RestingOrder => ({
  id, conditionId: 'cond', tokenId: 'tok', outcome: 'Yes', side: 'BUY',
  ceiling: 0.6, size: 10, placedAt: 1000, ttlMs: 60000, ...over,
});

const venue = (id: string, over: Partial<LiveVenueOrder> = {}): LiveVenueOrder => ({
  id, isOpen: true, ...over,
});

describe('reconcileLiveResting', () => {
  it('open match: book order open on venue with aligned shares → open_match', () => {
    const r = reconcileLiveResting({ bookOrders: [base('o1')], venueOrders: [venue('o1')], now: 2000 });
    expect(r[0].verdict.action).toBe('open_match');
  });

  it('venue_missing_cancel: book open but venue has no such order (ambiguous submit) — never assume fill', () => {
    const r = reconcileLiveResting({ bookOrders: [base('o1')], venueOrders: [], now: 2000 });
    expect(r[0].verdict.action).toBe('venue_missing_cancel');
  });

  it('venue_filled_confirm: venue closed with matched shares → confirm filled at venue count', () => {
    const r = reconcileLiveResting({
      bookOrders: [base('o1')],
      venueOrders: [venue('o1', { isOpen: false, filledShares: 7, originalSize: 10 })],
      now: 2000,
    });
    const v = r[0].verdict;
    expect(v.action).toBe('venue_filled_confirm');
    if (v.action === 'venue_filled_confirm') expect(v.filledShares).toBe(7);
  });

  it('venue_missing_cancel when venue closed with no matched shares', () => {
    const r = reconcileLiveResting({
      bookOrders: [base('o1')],
      venueOrders: [venue('o1', { isOpen: false, filledShares: 0 })],
      now: 2000,
    });
    expect(r[0].verdict.action).toBe('venue_missing_cancel');
  });

  it('partial_fill: venue matched more than the book recorded → update to venue', () => {
    const r = reconcileLiveResting({
      bookOrders: [base('o1', { filledShares: 3 })],
      venueOrders: [venue('o1', { filledShares: 6 })],
      now: 2000,
    });
    const v = r[0].verdict;
    expect(v.action).toBe('partial_fill');
    if (v.action === 'partial_fill') expect(v.filledShares).toBe(6);
  });

  it('expired_cancel: past TTL regardless of venue state', () => {
    const r = reconcileLiveResting({
      bookOrders: [base('o1')], // placedAt 1000, ttl 60000 → expires at 61000
      venueOrders: [venue('o1')],
      now: 70_000,
    });
    expect(r[0].verdict.action).toBe('expired_cancel');
  });

  it('handles an empty set cleanly', () => {
    const r = reconcileLiveResting({ bookOrders: [], venueOrders: [], now: 2000 });
    expect(r).toEqual([]);
  });
});
