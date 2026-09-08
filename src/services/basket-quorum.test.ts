/**
 * BasketQuorumService restart-recovery tests (P0-5/P0-7): open-position
 * snapshot/restore round-trip and the reconciliation gate flag.
 */
import { describe, expect, it } from 'vitest';
import { BasketQuorumService, type BasketQuorumConfig } from './basket-quorum-service.js';
import type { TradingService } from './trading-service.js';

function quorum(): BasketQuorumService {
  return new BasketQuorumService({} as TradingService, {
    defaultQuorum: 3,
    defaultWindowMs: 3_600_000,
    maxPriceDrift: 0.05,
    fireCooldownMs: 0,
    dryRun: true,
    sizeScale: 0.5,
    maxSizePerTrade: 500,
    maxSlippage: 0.03,
    orderType: 'FAK',
    minTradeSize: 10,
    baskets: [],
  } as unknown as BasketQuorumConfig);
}

describe('BasketQuorumService restart recovery (P0-5/P0-7)', () => {
  it('round-trips open positions through the durable record snapshot', () => {
    const q = quorum();
    const rec = {
      tokenId: 'tok-1', usdc: 100, size: 50, entryPrice: 0.5,
      marketSlug: 'will-x', outcome: 'Yes', conditionId: 'c1',
      basketName: 'Crypto Quorum', basketCategory: 'crypto' as const,
    };
    const restored = q.restoreOpenPositions([rec]);
    expect(restored).toBe(1);
    const snap = q.getOpenPositionRecords();
    expect(snap).toHaveLength(1);
    expect(snap[0].tokenId).toBe('tok-1');
    expect(snap[0].size).toBe(50);
  });

  it('ignores malformed restore records without corrupting the snapshot', () => {
    const q = quorum();
    const restored = q.restoreOpenPositions([
      { tokenId: 'ok-1', usdc: 100, size: 10, entryPrice: 0.5, conditionId: 'c1', marketSlug: 'm', outcome: 'Yes', basketName: 'B', basketCategory: 'crypto' as const },
      { tokenId: '', size: 10 } as never,
      null as never,
      { tokenId: 'bad', usdc: 0, size: 0 } as never,
    ]);
    expect(restored).toBe(1);
    expect(q.getOpenPositionRecords()).toHaveLength(1);
  });

  it('defaults to blocked (not reconciled) and gates on setReconciled', () => {
    const q = quorum();
    expect(q.isReconciled()).toBe(false);
    q.setReconciled(true);
    expect(q.isReconciled()).toBe(true);
  });
});