import { describe, it, expect } from 'vitest';
import { classifyTier, promotePriority, intervalForTier, type AttentionTier } from './market-attention.js';

describe('classifyTier (tremor markets.ts:61-72)', () => {
  it('>$50k daily volume → hot; >$5k → warm; else cold', () => {
    expect(classifyTier(80_000)).toBe('hot');
    expect(classifyTier(50_001)).toBe('hot');
    expect(classifyTier(50_000)).toBe('warm');
    expect(classifyTier(5_001)).toBe('warm');
    expect(classifyTier(5_000)).toBe('cold'); // strict > $5k boundary
    expect(classifyTier(4_999)).toBe('cold');
    expect(classifyTier(0)).toBe('cold');
  });
});

describe('promotePriority (tremor prioritization.ts:37-78)', () => {
  it('high volume + volatility + tight spread → hot', () => {
    const p = promotePriority({ volume24h: 120_000, tradeCount24h: 400, spreadBps: 50, depthUsd: 500, vol1h: 0.1, lastUpdateAgeMs: 1_000 });
    expect(p.tier).toBe('hot');
    expect(p.points).toBeGreaterThanOrEqual(70);
  });
  it('thin market → cold regardless of recency', () => {
    const p = promotePriority({ volume24h: 500, tradeCount24h: 2, spreadBps: 4000, depthUsd: 20, vol1h: 0.01, lastUpdateAgeMs: 100 });
    expect(p.tier).toBe('cold');
  });
  it('points details are exposed for tuning', () => {
    const p = promotePriority({ volume24h: 10_000, tradeCount24h: 50, spreadBps: 200, depthUsd: 100, vol1h: 0.05, lastUpdateAgeMs: 60_000 });
    expect(p.points).toBeGreaterThan(0);
    expect(typeof p.details.volume).toBe('number');
    expect(typeof p.details.spread).toBe('number');
  });
});

describe('intervalForTier', () => {
  it('hot 15s / warm 60s / cold 300s', () => {
    expect(intervalForTier('hot')).toBe(15_000);
    expect(intervalForTier('warm')).toBe(60_000);
    expect(intervalForTier('cold')).toBe(300_000);
  });
  it('all tiers covered by the union type', () => {
    const tiers: AttentionTier[] = ['hot', 'warm', 'cold'];
    expect(tiers).toHaveLength(3);
  });
});