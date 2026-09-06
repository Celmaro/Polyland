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
function position(realizedPnl: number, timestamp = now, conditionId = `condition-${timestamp}-${Math.random()}`): ClosedPosition {
  return {
    proxyWallet: '0x' + '1'.repeat(40),
    asset: 'asset',
    conditionId,
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
    const positions = Array.from({ length: 100 }, (_, i) => {
      const win = i < 20 || (i >= 20 && i % 2 === 0);
      return position(win ? 0.1 : -0.0666667, now, `condition-${i}`);
    });
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
  it('demotes high-CopyScore wallets with a tiny market sample to WATCHLIST', () => {
    // Audit scenario: a 3-market wallet scoring in the PRIMARY band must NOT
    // seed a basket — sample floor (SATELLITE >= 12, PRIMARY >= 30) wins over
    // raw CopyScore. The tier logic is the private evaluate(); exercise it
    // through the public gate-count path by calling evaluate directly.
    const s = service as any;
    const candidate = { address: '0x' + '1'.repeat(40), source: 'auto' as const, autoRank: 1 };
    const small = Array.from({ length: 3 }, (_, i) => position(i % 2 === 0 ? 0.2 : -0.1, now, `condition-small-${i}`));
    const winRates = { politics: { winRate: 0.67, tradeCount: 3 } };
    const resolved = { category: 'politics' as const, source: 'auto' as const, confidence: 1 };
    const gateCounts: Record<string, number> = {};
    const res = s.evaluate(candidate, profile(100, 0.67), resolved, winRates, small, gateCounts);
    expect(['SATELLITE', 'PRIMARY']).not.toContain(res.tier);
    expect(res.tier).toBe('WATCHLIST');
  });
  it('keeps a wallet with >= 30 distinct markets eligible for PRIMARY by sample', () => {
    const s = service as any;
    const candidate = { address: '0x' + '1'.repeat(40), source: 'auto' as const, autoRank: 1 };
    // All-wins across 30 distinct markets: score clears SATELLITE easily, and
    // the sample floor must not demote it (positive control for the floor).
    const many = Array.from({ length: 30 }, (_, i) => position(0.2, now, `condition-many-${i}`));
    const winRates = { politics: { winRate: 1, tradeCount: 30 } };
    const resolved = { category: 'politics' as const, source: 'auto' as const, confidence: 1 };
    const gateCounts: Record<string, number> = {};
    const res = s.evaluate(candidate, profile(30, 1), resolved, winRates, many, gateCounts);
    expect(res.copyScore).toBeGreaterThanOrEqual(45);
    expect(res.tier).not.toBe('WATCHLIST'); // score + sample allow SATELLITE/PRIMARY
  });
});
