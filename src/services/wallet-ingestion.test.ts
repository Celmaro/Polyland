/**
 * Wallet-ingestion tests (C1–C7): multi-source intake + source corroboration,
 * registry lifecycle (probation→active), two-stage quorum entry, behavioral
 * ingestion filters, topic profile, and discovery failure guards.
 */
import { describe, it, expect } from 'vitest';
import {
  WalletIngestor,
  corroborationBonus,
  buildTopicProfile,
  verifyEVMAddress,
  discoveryHealthy,
  type IngestCandidate,
  type WalletRecord,
} from './wallet-ingestion.js';

function cand(over: Partial<IngestCandidate>): IngestCandidate {
  return {
    wallet: '0x000000000000000000000000000000000000' + (over.wallet?.slice(-2) ?? '01'),
    sources: ['leaderboard'],
    score: 0.5,
    tier: 'WATCHLIST',
    category: 'crypto',
    tradeCount: 20,
    weeklyTrades: 5,
    peakTrades60s: 2,
    realizedPnl: 100,
    ...over,
  };
}

describe('C1 — source corroboration bonus', () => {
  it('gives 0 bonus without a multi-source match and positive with ≥2', () => {
    expect(corroborationBonus(['leaderboard'])).toBe(0);
    expect(corroborationBonus(['leaderboard', 'market_trades'])).toBeGreaterThan(0);
    expect(corroborationBonus(['leaderboard', 'market_trades', 'curated'])).toBeGreaterThan(
      corroborationBonus(['leaderboard', 'market_trades']),
    );
  });
});

describe('C6 — EVM + discovery guards', () => {
  it('validates EVM addresses', () => {
    expect(verifyEVMAddress('0x' + 'a'.repeat(40))).toBe(true);
    expect(verifyEVMAddress('not-an-address')).toBe(false);
    expect(verifyEVMAddress('')).toBe(false);
  });

  it('fails a discovery run when fetch-failure ratio is too high', () => {
    expect(discoveryHealthy({ attempted: 10, failed: 2 })).toBe(true);
    expect(discoveryHealthy({ attempted: 10, failed: 6 })).toBe(false);
  });
});

describe('C5 — topic profile', () => {
  it('computes specialization (HHI) and primary topic', () => {
    const p = buildTopicProfile({ crypto: 10, politics: 5, sports: 5 });
    expect(p.primaryTopic).toBe('crypto');
    expect(p.affinities.crypto).toBe(0.5);
    // 0.5^2 + 0.25^2 + 0.25^2 = 0.25 + 0.0625 + 0.0625 = 0.375
    expect(p.specialization).toBeCloseTo(0.375, 4);
  });
});

describe('WalletIngestor (C2/C3/C4)', () => {
  it('new wallets enter as probation; promoted on sample + score', () => {
    const ing = new WalletIngestor({ minScorePromotion: 0.6, minTradesPromotion: 15 });
    // probation entry
    const rec = ing.register(cand({ wallet: '0x..aa', score: 0.55 }));
    expect(rec.status).toBe('probation');
    expect(rec.statusReason).toContain('probation');
    expect(rec.tier).toBe('WATCHLIST');
  });

  it('promotes a sample- and score-clearing wallet', () => {
    const ing = new WalletIngestor({ minScorePromotion: 0.6, minTradesPromotion: 15 });
    const rec = ing.register(cand({ wallet: '0x..ab', score: 0.68, tradeCount: 30 }));
    // 0.68 >= 0.6 and >= 15 trades -> active; below PRIMARY bar (0.75) -> SATELLITE
    expect(rec.status).toBe('active');
    expect(rec.tier).toBe('SATELLITE');
  });

  it('applies behavioral ingestion filters (C4): burst-80 and weekly cap', () => {
    const ing = new WalletIngestor({ minScorePromotion: 0.6, minTradesPromotion: 15, maxWeeklyTrades: 60, maxBurst60s: 20 });
    const bursty = cand({ score: 0.8, tradeCount: 30, peakTrades60s: 50 });
    expect(ing.register(bursty).status).toBe('rejected');
    const washy = cand({ score: 0.8, tradeCount: 30, weeklyTrades: 200 });
    expect(ing.register(washy).status).toBe('rejected');
  });

  it('carries source + timestamps for registry provenance (C2)', () => {
    const ing = new WalletIngestor({ minScorePromotion: 0.6, minTradesPromotion: 15 });
    const rec = ing.register(cand({ wallet: '0x..ac', sources: ['market_trades', 'curated'], score: 0.7, tradeCount: 20 }));
    expect(rec.sourceRef).toContain('market_trades');
    expect(rec.firstSeen).toBeGreaterThan(0);
    expect(rec.lastScored).toBeGreaterThan(0);
  });

  it('persists and restores the registry (C2)', () => {
    const ing = new WalletIngestor({ minScorePromotion: 0.6, minTradesPromotion: 15 });
    ing.register(cand({ wallet: '0x..ad', score: 0.8, tradeCount: 30 }));
    const snapshot: WalletRecord[] = ing.snapshot();
    const ing2 = new WalletIngestor({ minScorePromotion: 0.6, minTradesPromotion: 15 });
    ing2.restore(snapshot);
    expect(ing2.snapshot()).toEqual(snapshot);
  });
});