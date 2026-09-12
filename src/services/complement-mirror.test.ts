/**
 * R2 tests: complement-side mirroring. When the target token's ask is walled
 * (e.g. 0.99) but the complement token (NO side of the same binary) has real
 * two-sided depth, express the leader's directional delta via the complement
 * at its executable price. Binary/neg-risk only; strict post-fee gate.
 */
import { describe, it, expect } from 'vitest';
import {
  planComplementMirror,
  binaryComplement,
  isMirrorProfitable,
  type MirrorPlanInput,
} from './complement-mirror.js';

const BOOKS: MirrorPlanInput = {
  // Target (YES): ask walled at 0.99, real bid.
  target: {
    tokenId: 'yes-tok',
    side: 'BUY',
    outcome: 'Yes',
    consensusPrice: 0.60,
    targetAskBest: 0.99,
    targetBidBest: 0.59,
  },
  // Complement (NO): real two-sided depth.
  complement: {
    tokenId: 'no-tok',
    complementSide: 'BUY', // buying NO
    complementAskBest: 0.41,
    complementBidBest: 0.39,
    askSize: 10_000,
  },
  takerFeeBps: 200,
  minPositionUsd: 1,
  maxSlippageBps: 500,
};

describe('R2 — binary complement derivation', () => {
  it('derives the complement token + opposite side for a binary market', () => {
    const c = binaryComplement({ tokenId: 'yes-1', side: 'BUY', outcome: 'Yes' });
    expect(c.complementSide).toBe('BUY'); // buy the NO token
    expect(c.complementOutcome).toBe('No');
  });
});

describe('R2 — mirror profitability gate', () => {
  it('approves a mirror when complement ask + fees is cheap vs target ask', () => {
    // complement ask 0.41 vs target consensus 0.60 -> the delta costs ~0.19.
    // Buying NO at 0.41 net of fee ≈ 0.415; acceptable when target is 0.99.
    const p = isMirrorProfitable({
      complementAskBest: 0.41,
      takerFeeBps: 200,
      targetConsensusPrice: 0.60,
      targetAskBest: 0.99,
      maxSlippageBps: 500,
    });
    expect(p.ok).toBe(true);
  });

  it('rejects a mirror when the complement is also expensive', () => {
    // complement ask 0.95 -> buying NO near certainty = no mirror edge.
    const p = isMirrorProfitable({
      complementAskBest: 0.95,
      takerFeeBps: 200,
      targetConsensusPrice: 0.60,
      targetAskBest: 0.99,
      maxSlippageBps: 500,
    });
    expect(p.ok).toBe(false);
  });
});

describe('R2 — full mirror plan', () => {
  it('produces a fillable mirror order when target is walled', () => {
    const plan = planComplementMirror(BOOKS);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.order.side).toBe('BUY');
      expect(plan.order.tokenId).toBe('no-tok');
      expect(plan.order.price).toBeLessThan(0.5); // complement ask 0.41
      expect(plan.side).toBe('mirrored');
    }
  });

  it('returns not_fillable when complement has no executable depth', () => {
    const plan = planComplementMirror({
      ...BOOKS,
      complement: { ...BOOKS.complement, complementAskBest: 0.99, askSize: 0 },
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe('complement_not_fillable');
  });

  it('returns no_mirror_needed when the target itself is fillable', () => {
    const plan = planComplementMirror({
      ...BOOKS,
      target: { ...BOOKS.target, targetAskBest: 0.61 }, // target fillable
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe('target_fillable');
  });
});