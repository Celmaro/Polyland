import { describe, expect, it } from 'vitest';
import { computeHHI, nEffective, effectiveContributors, clusterOf, jaccardOverlap } from './independence-metrics.js';
describe('independence metrics', () => {
  it('computes three equal contributors as effective three', () => expect(nEffective([1, 1, 1])).toBeCloseTo(3));
  it('recognizes a dominant contributor', () => expect(nEffective([100, 1, 1])).toBeLessThan(1.1));
  it('caps dominant cluster weight', () => {
    const result = effectiveContributors([{ wallets: ['a'], actions: [], weight: 100 }, { wallets: ['b'], actions: [], weight: 1 }], 101, 10);
    expect(result.dominantWalletWeight).toBe(10);
  });
  it('clusters high-overlap, same-time wallets', () => {
    const actions = ['a', 'b'].map(wallet => ({ wallet, marketSlug: 'market-1', conditionId: 'c', outcome: 'Yes', side: 'BUY' as const, timestamp: 1000, size: 1, price: .5 }));
    expect(clusterOf(actions, .5)).toHaveLength(1);
    expect(jaccardOverlap([actions[0]], [actions[1]])).toBe(1);
  });
  it('calculates HHI', () => expect(computeHHI([1, 1])).toBeCloseTo(.5));
});
