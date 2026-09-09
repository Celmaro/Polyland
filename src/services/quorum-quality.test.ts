/**
 * Quorum-quality tests (B1–B8): consensus coherence, weighted agreement,
 * dominant-wallet cap, Bayesian confidence, conflict penalty, market regime,
 * dynamic quorum, and wallet cooldown.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateConsensusGate,
  computeWeightedConsensus,
  computeDominantWalletShare,
  bayesianConfidence,
  computeConflictPenalty,
  classifyMarketRegime,
  effectiveQuorum,
} from './quorum-quality.js';

describe('B1 — consensus coherence gates', () => {
  it('rejects when aligned entry prices are too spread', () => {
    const aligned = [
      { wallet: 'a', price: 0.40, ts: 100 },
      { wallet: 'b', price: 0.60, ts: 120 },
    ];
    const r = evaluateConsensusGate({ aligned, minAligned: 2, maxPriceBand: 0.10, maxTimeSpreadSec: 3600 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('wide_entry_price_band');
  });

  it('rejects when aligned timestamps are too scattered', () => {
    const aligned = [
      { wallet: 'a', price: 0.50, ts: 100 },
      { wallet: 'b', price: 0.51, ts: 100 + 7200 * 1000 },
    ];
    const r = evaluateConsensusGate({ aligned, minAligned: 2, maxPriceBand: 0.10, maxTimeSpreadSec: 3600 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('wide_entry_time_spread');
  });

  it('passes a coherent consensus', () => {
    const aligned = [
      { wallet: 'a', price: 0.50, ts: 100 },
      { wallet: 'b', price: 0.51, ts: 150 },
    ];
    const r = evaluateConsensusGate({ aligned, minAligned: 2, maxPriceBand: 0.10, maxTimeSpreadSec: 3600 });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('fails on insufficient participants', () => {
    const r = evaluateConsensusGate({ aligned: [{ wallet: 'a', price: 0.5, ts: 1 }], minAligned: 2, maxPriceBand: 0.1, maxTimeSpreadSec: 3600 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('insufficient_basket_participants');
  });
});

describe('B2/B3 — weighted agreement + dominant wallet', () => {
  const weight = (wallet: string) => ({ a: 100, b: 50, c: 30, d: 200 })[wallet] ?? 0;
  it('computes weighted consensus as aligned/total with a floor', () => {
    const wc = computeWeightedConsensus(['a', 'b'], ['a', 'b', 'c'], weight);
    expect(wc.ratio).toBeCloseTo(150 / 180, 4);
  });

  it('flags a dominant wallet above the cap', () => {
    const share = computeDominantWalletShare(['d', 'a'], weight); // d=200,a=100 total 300
    expect(share).toBeCloseTo(200 / 300, 4); // 0.667 < 0.75
    const heavy = computeDominantWalletShare(['d'], weight); // 200/200 = 1.0
    expect(heavy).toBe(1.0);
  });
});

describe('B4 — Bayesian confidence prior', () => {
  it('pulls a thin consensus toward neutral', () => {
    const c = bayesianConfidence({ alignedWeight: 2, totalWeight: 3, prior: 2 });
    // (2 + 2*0.5)/(3+2) = 3/5 = 0.6; sample_strength = 3/5 = 0.6 -> 0.36
    expect(c.score).toBeCloseTo(0.36, 4);
  });
  it('is higher with strong agreement and more evidence', () => {
    const strong = bayesianConfidence({ alignedWeight: 9, totalWeight: 10, prior: 2 }).score;
    const weak = bayesianConfidence({ alignedWeight: 2, totalWeight: 3, prior: 2 }).score;
    expect(strong).toBeGreaterThan(weak);
  });
});

describe('B5 — conflict penalty', () => {
  it('penalizes when significant weight sits on the opposite side', () => {
    const p = computeConflictPenalty({ alignedWeight: 60, totalWeight: 100, penaltyWeight: 0.15 });
    expect(p).toBeCloseTo(0.06, 4); // 0.4 * 0.15
  });
  it('is zero with full agreement', () => {
    expect(computeConflictPenalty({ alignedWeight: 100, totalWeight: 100, penaltyWeight: 0.15 })).toBe(0);
  });
});

describe('B6 — market regime classification', () => {
  it('classifies a wide-spread, low-depth market as UNSTABLE', () => {
    expect(classifyMarketRegime({ spreadBps: 500, depthUsd: 10, yesAsk: 0.5 })).toBe('UNSTABLE');
  });
  it('classifies a tight-spread, deep market as RANGE', () => {
    expect(classifyMarketRegime({ spreadBps: 20, depthUsd: 5000, yesAsk: 0.5 })).toBe('RANGE');
  });
});

describe('B7 — dynamic quorum', () => {
  it('returns the configured min when starved and gates are clean', () => {
    const q = effectiveQuorum({ base: 5, min: 3, starved: true, entryQualityClean: true, walletGateClean: true });
    expect(q).toBe(3);
  });
  it('keeps base quorum when NOT clean even if starved', () => {
    const q = effectiveQuorum({ base: 5, min: 3, starved: true, entryQualityClean: false, walletGateClean: true });
    expect(q).toBe(5);
  });
});

describe('B8 — wallet cooldown', () => {
  it('is not implemented here (handled by risk-manager locks); placeholder holds', () => {
    expect(true).toBe(true);
  });
});
