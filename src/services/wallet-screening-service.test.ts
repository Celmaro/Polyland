import { describe, expect, it } from 'vitest';
import { WalletScreeningService } from './wallet-screening-service.js';
import type { WalletProfile } from './wallet-service.js';
import type { ClosedPosition } from '../clients/data-api.js';

const now = Date.now();

function profile(tradeCount: number, winRate: number): WalletProfile {
  return {
    address: '0x' + '1'.repeat(40),
    totalPnL: tradeCount,
    realizedPnL: tradeCount,
    unrealizedPnL: 0,
    avgPercentPnL: 0.2,
    positionCount: tradeCount,
    tradeCount,
    smartScore: 80,
    winRate,
    lastActiveAt: new Date(now),
    openConditionIds: [],
  };
}

function position(realizedPnl: number, timestamp = now): ClosedPosition {
  return {
    proxyWallet: '0x' + '1'.repeat(40),
    asset: 'asset',
    conditionId: 'condition',
    avgPrice: 0.4,
    totalBought: 1,
    realizedPnl,
    curPrice: realizedPnl > 0 ? 1 : 0,
    timestamp,
    title: 'Politics market',
    outcome: 'Yes',
    outcomeIndex: 0,
  };
}

function score(service: WalletScreeningService, p: WalletProfile, positions: ClosedPosition[]): number {
  const components = (service as any).computeScoringComponents(p, positions);
  return (service as any).computeCopyScore(components);
}

describe('WalletScreeningService CopyScore confidence and recency', () => {
  const service = new WalletScreeningService({} as any, { minTradeCount: 0 });

  it('keeps a one-trade 100% wallet below SATELLITE and PRIMARY', () => {
    const oneTrade = score(service, profile(1, 1), [position(1)]);
    expect(oneTrade).toBeLessThan(45);
    expect(oneTrade).toBeLessThan(65);
  });

  it('lets a 100-trade wallet at 60% win rate clear SATELLITE', () => {
    const positions = Array.from({ length: 100 }, (_, i) => position(i < 60 ? 1 : -1));
    expect(score(service, profile(100, 0.6), positions)).toBeGreaterThanOrEqual(45);
  });

  it('scores the same perfect win rate higher with 200 trades than one trade', () => {
    const oneTrade = score(service, profile(1, 1), [position(1)]);
    const manyTrades = score(service, profile(200, 1), Array.from({ length: 200 }, () => position(1)));
    expect(manyTrades).toBeGreaterThan(oneTrade);
  });

  it('discounts wins outside the 14-day timestamped recency window', () => {
    const old = now - 31 * 86_400_000;
    const oldWins = Array.from({ length: 100 }, () => position(1, old));
    const recentWins = Array.from({ length: 100 }, () => position(1, now));
    expect(score(service, profile(100, 1), recentWins)).toBeGreaterThan(score(service, profile(100, 1), oldWins));
  });
});
