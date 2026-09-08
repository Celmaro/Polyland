/**
 * tests for replay-mode — re-run the exit ladder's evaluateExit()
 * over historical fired signals and compare the recorded vs.
 * simulated exit prices/PnL. This is the offline answer to "is the
 * new exit logic better than last week's?"
 */
import { describe, it, expect } from 'vitest';
import { replaySettlements, type ReplayConfig } from './replay.js';
import type { FiredSignal } from './signal-audit-store.js';

function sig(p: Partial<FiredSignal>): FiredSignal {
  return {
    id: p.id ?? 'sig-1',
    conditionId: p.conditionId ?? 'cond-1',
    marketSlug: p.marketSlug ?? 'mkt',
    outcome: p.outcome ?? 'Yes',
    side: p.side ?? 'BUY',
    pricePaid: p.pricePaid ?? 0.5,
    size: p.size ?? 10,
    feePerShare: p.feePerShare ?? 0.02,
    expectedEdge: p.expectedEdge ?? 0.1,
    winRate: p.winRate ?? 0.6,
    basket: p.basket ?? 'crypto',
    wallets: p.wallets ?? ['0xw1'],
    firedAt: p.firedAt ?? 0,
    settledAt: p.settledAt,
    realizedEdge: p.realizedEdge,
    resolved: p.resolved,
    exitedAt: p.exitedAt,
    exitPrice: p.exitPrice,
    exitReason: p.exitReason,
    cluster: p.cluster ?? 'cond-1',
  };
}

describe('replaySettlements', () => {
  it('returns the same PnL for an unresolved signal', () => {
    const sigs: FiredSignal[] = [
      sig({ id: '1', pricePaid: 0.5, size: 10, firedAt: 1000, settledAt: 5000, resolved: 1, realizedEdge: 0.5 }),
    ];
    const r = replaySettlements(sigs, {} as ReplayConfig);
    // resolved=1 (won), exit = min(1, 0.5+0.05) = 0.55 → simulated = 0.55 - 0.5 = 0.05/share
    // × 10 shares = 0.5, matching recorded.
    expect(r.entries[0].simulatedPnl).toBeCloseTo(0.5, 4);
    expect(r.entries[0].delta).toBeCloseTo(0, 4);
  });

  it('classifies buckets by category', () => {
    const sigs: FiredSignal[] = [
      sig({ id: '1', basket: 'crypto', pricePaid: 0.5, resolved: 1, realizedEdge: 5, settledAt: 1 }),
      sig({ id: '2', basket: 'sports', pricePaid: 0.5, resolved: 0, realizedEdge: -5, settledAt: 2 }),
      sig({ id: '3', basket: 'crypto', pricePaid: 0.5, resolved: 0, realizedEdge: -3, settledAt: 3 }),
    ];
    const r = replaySettlements(sigs, {} as ReplayConfig);
    expect(r.byCategory['crypto'].n).toBe(2);
    expect(r.byCategory['crypto'].totalPnl).toBeCloseTo(2, 4);
    expect(r.byCategory['sports'].n).toBe(1);
    expect(r.byCategory['sports'].totalPnl).toBeCloseTo(-5, 4);
  });

  it('flags slippage outliers where simulated != recorded by >5¢', () => {
    const sigs: FiredSignal[] = [
      // Recorded says +0.5 (matching audit), but aggressive profile
      // (stops tighter) would have produced less.
      sig({ id: '1', pricePaid: 0.5, size: 10, resolved: 1, realizedEdge: 1.5, settledAt: 1 }),
    ];
    const r = replaySettlements(sigs, { exitConfig: 'aggressive' } as ReplayConfig);
    // aggressive: tp=0.03 → simulated 0.03*10 = 0.3; recorded 1.5; delta = -1.2 (>0.05*10=0.5).
    expect(r.entries[0].slippageFlag).toBe(true);
  });
});
