/**
 * ClobMarketWsService book sequence-gap tests (P0-6).
 *
 * Safe semantics: gap detection only when the feed actually carries a
 * sequence field for that asset. A feed with NO sequence field is observed
 * (unsequenced counter) but never falsely invalidated; a feed that HAD
 * sequences and then gaps/misses one IS invalidated and triggers resync.
 */
import { describe, expect, it } from 'vitest';
import { ClobMarketWsService } from './clob-market-ws.js';

function bookUpdate(assetId: string, over: Record<string, unknown> = {}) {
  return {
    asset_id: assetId,
    bids: [['0.50', '10']] as [string, string][],
    asks: [['0.51', '10']] as [string, string][],
    ...over,
  };
}

describe('ClobMarketWsService book sequence integrity (P0-6)', () => {
  it('accepts contiguous sequenced updates without invalidation', () => {
    const ws = new ClobMarketWsService();
    ws.handleBookUpdate(bookUpdate('a', { sequence: 1 }));
    ws.handleBookUpdate(bookUpdate('a', { sequence: 2 }));
    const state = ws.getIntegrityState();
    expect(state.sequenceGaps).toBe(0);
    expect(state.invalidBooks).toBe(0);
    expect(state.resyncs).toBe(0);
  });

  it('invalidates + requests resync on a sequence gap', () => {
    const resyncs: string[] = [];
    const ws = new ClobMarketWsService({ onResync: (r) => resyncs.push(`${r.assetId}:${r.reason}`) });
    ws.handleBookUpdate(bookUpdate('a', { sequence: 10 }));
    ws.handleBookUpdate(bookUpdate('a', { sequence: 12 })); // gap: expected 11
    const state = ws.getIntegrityState();
    expect(state.sequenceGaps).toBe(1);
    expect(state.invalidBooks).toBe(1);
    expect(state.resyncs).toBe(1);
    expect(resyncs).toEqual(['a:sequence_gap']);
    // The invalidated book must be cleared (a later update starts a new baseline).
    ws.handleBookUpdate(bookUpdate('a', { sequence: 100 }));
    expect(ws.getIntegrityState().invalidBooks).toBe(1);
  });

  it('does NOT invalidate a feed that never carries a sequence field', () => {
    const ws = new ClobMarketWsService();
    ws.handleBookUpdate(bookUpdate('a'));
    ws.handleBookUpdate(bookUpdate('a'));
    ws.handleBookUpdate(bookUpdate('a'));
    const state = ws.getIntegrityState();
    expect(state.sequenceGaps).toBe(0);
    expect(state.invalidBooks).toBe(0); // unsequenced feed must not false-invalidate
  });

  it('invalidates when a previously-sequenced asset loses its sequence field', () => {
    const ws = new ClobMarketWsService();
    ws.handleBookUpdate(bookUpdate('a', { sequence: 5 }));
    ws.handleBookUpdate(bookUpdate('a', { sequence: 6 }));
    ws.handleBookUpdate(bookUpdate('a')); // sequence vanished
    expect(ws.getIntegrityState().invalidBooks).toBe(1);
  });

  it('tolerates a malformed sequence value on an unsequenced feed (observability only)', () => {
    const ws = new ClobMarketWsService();
    ws.handleBookUpdate(bookUpdate('a', { sequence: 'not-a-number' }));
    ws.handleBookUpdate(bookUpdate('a', { sequence: {} }));
    expect(ws.getIntegrityState().invalidBooks).toBe(0);
  });
});