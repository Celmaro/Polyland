/**
 * ClobMarketWsService observability (P1) — integrity snapshot reads only.
 */
import { describe, it, expect } from 'vitest';
import { ClobMarketWsService } from './clob-market-ws.js';

describe('ClobMarketWsService integrity snapshot (P1)', () => {
  it('returns a zeroed, bounded integrity state before any connection', () => {
    const ws = new ClobMarketWsService();
    const state = ws.getIntegrityState();
    expect(state).toEqual({
      sequenceGaps: 0,
      resyncs: 0,
      invalidBooks: 0,
      lastDataMessageAt: 0,
      bufferedAmount: 0,
      backpressure: false,
      connectionState: 'disconnected',
      outageHalted: false,
      quarantinedFrames: 0,
      quarantineByReason: {},
    });
  });
  it('reports backpressure when bufferedAmount crosses the threshold', () => {
    const ws = new ClobMarketWsService({ backpressureBytes: 1024 });
    // Simulate a buffered socket without connecting (observability read only).
    (ws as unknown as { bufferedAmountBytes: number }).bufferedAmountBytes = 2048;
    const state = ws.getIntegrityState();
    expect(state.bufferedAmount).toBe(2048);
    expect(state.backpressure).toBe(true);
  });
});