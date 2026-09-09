/**
 * BasketLifecycle tests (A1–A5): wallet lifecycle actions, churn/capacity
 * bounds, promotion buffer, persisted memberships, target-allocation
 * rebalancing, and basket overlap health.
 */
import { describe, it, expect } from 'vitest';
import {
  BasketWalletManager,
  computeBasketOverlapHealth,
  evaluateRebalance,
  type BasketLifecycleConfig,
  type BasketMembership,
} from './basket-lifecycle.js';

const CFG: BasketLifecycleConfig = {
  maxWalletsPerBasket: 3,
  maxNewWalletsPerRun: 2,
  minAssignmentScore: 0.5,
  promotionBuffer: 0.05,
  rebalanceDriftThreshold: 0.05,
};

function assignment(wallet: string, topic: string, score: number, confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH') {
  return { wallet, topic, score, confidence };
}

describe('BasketWalletManager lifecycle (A1/A2)', () => {
  it('adds a high-score wallet with a reason (A1)', () => {
    const mgr = new BasketWalletManager(CFG);
    const actions = mgr.propose([assignment('0xnew', 'crypto', 0.8)]);
    expect(actions.length).toBe(1);
    expect(actions[0].action).toBe('add');
    expect(actions[0].topic).toBe('crypto');
    expect(actions[0].wallet).toBe('0xnew');
    expect(actions[0].reason).toContain('score');
  });

  it('observes a low-score wallet instead of adding (A1 graduated, no blacklist)', () => {
    const mgr = new BasketWalletManager(CFG);
    const actions = mgr.propose([assignment('0xlow', 'crypto', 0.3)]);
    expect(actions[0].action).toBe('observe');
  });

  it('observes a borderline MEDIUM wallet below the promotion buffer (A2)', () => {
    const mgr = new BasketWalletManager(CFG);
    // threshold 0.5 + buffer 0.05 = non-HIGH must clear 0.55
    const actions = mgr.propose([assignment('0xborder', 'crypto', 0.53, 'MEDIUM')]);
    expect(actions[0].action).toBe('observe');
    expect(actions[0].reason).toContain('buffer');
  });

  it('respects max_wallets_per_basket capacity (A2)', () => {
    const mgr = new BasketWalletManager(CFG, {
      crypto: [membership('0xa', 'crypto'), membership('0xb', 'crypto'), membership('0xc', 'crypto')],
    });
    const actions = mgr.propose([assignment('0xd', 'crypto', 0.9)]);
    expect(actions[0].action).toBe('observe');
    expect(actions[0].reason).toContain('capacity');
  });

  it('respects max_new_wallets_per_run churn (A2)', () => {
    const mgr = new BasketWalletManager(CFG);
    const actions = mgr.propose([
      assignment('0x1', 'crypto', 0.8),
      assignment('0x2', 'crypto', 0.8),
      assignment('0x3', 'crypto', 0.8),
    ]);
    expect(actions.filter((a) => a.action === 'add').length).toBe(2); // capped
    expect(actions.filter((a) => a.action === 'observe').length).toBe(1);
  });

  it('suspends an existing wallet whose score degraded (A1 reversible)', () => {
    const mgr = new BasketWalletManager(CFG, { crypto: [membership('0xa', 'crypto', 'core')] });
    const actions = mgr.propose([assignment('0xa', 'crypto', 0.4, 'LOW')]);
    expect(actions[0].action).toBe('suspend');
    expect(actions[0].reason).toContain('degraded');
  });
});

describe('BasketWalletManager memberships (A3)', () => {
  it('persists tier/rank/active/effective_until and restores', () => {
    const mgr = new BasketWalletManager(CFG);
    mgr.propose([assignment('0xnew', 'crypto', 0.8)]);
    const snap = mgr.membershipSnapshot();
    expect(snap[0]).toMatchObject({ wallet: '0xnew', topic: 'crypto', tier: 'core', active: true });
    expect(snap[0].effectiveUntil).toBeNull();

    const mgr2 = new BasketWalletManager(CFG);
    mgr2.restore(snap);
    expect(mgr2.membershipSnapshot()).toEqual(snap);
  });

  it('expires a membership with effective_until in the past on snapshot', () => {
    const mgr = new BasketWalletManager(CFG);
    mgr.restore([membership('0xold', 'crypto', 'core', Date.now() - 1000)]);
    const snap = mgr.membershipSnapshot();
    expect(snap).toHaveLength(0); // aged out
  });
});

describe('evaluateRebalance (A4)', () => {
  it('flags a basket whose exposure drifted past the threshold', () => {
    const actions = evaluateRebalance(
      { ...CFG, targetAllocationByTopic: { crypto: 0.75, sports: 0.25 } },
      { crypto: 20, sports: 80 },
    );
    expect(actions.map((a) => a.action)).toContain('rebalance');
  });

  it('returns nothing when allocations are within drift', () => {
    const actions = evaluateRebalance(
      { ...CFG, targetAllocationByTopic: { crypto: 0.75, sports: 0.25 } },
      { crypto: 74, sports: 26 },
    );
    expect(actions).toEqual([]);
  });
});

describe('computeBasketOverlapHealth (A5)', () => {
  it('computes overlap percentages for 2/3/4 wallets', () => {
    const votes = new Map([
      ['t1', new Set(['a', 'b'])],
      ['t2', new Set(['a', 'b', 'c'])],
      ['t3', new Set(['a', 'b', 'c', 'd'])],
      ['t4', new Set(['a'])],
    ]);
    const h = computeBasketOverlapHealth(votes);
    expect(h.activeTokens).toBe(4);
    expect(h.overlapPct2).toBe(75); // 3 of 4 tokens have >=2
    expect(h.overlapPct3).toBe(50); // 2 of 4
    expect(h.overlapPct4).toBe(25); // 1 of 4
  });
});

function membership(wallet: string, topic: string, tier: BasketMembership['tier'] = 'core', effectiveUntil: number | null = null): BasketMembership {
  return {
    topic, wallet, tier, rank: 0, active: true,
    joinedAt: Date.now(), effectiveUntil,
    promotionReason: 'test', demotionReason: '',
  };
}
