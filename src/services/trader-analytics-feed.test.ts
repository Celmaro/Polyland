import { describe, it, expect } from 'vitest';
import { scoreTraderEvidence, mergeEvidence, type TraderAnalyticsSnapshot } from './trader-analytics-feed.js';

const SNAP: TraderAnalyticsSnapshot = {
  wallet: '0xabc',
  totalPnl: 23_600,
  pnl24h: 1000,
  pnl7d: 5_000,
  pnl14d: 6_000,
  winRate: 0.54,
  gains14d: 210_000,
  losses14d: 191_000,
  trades14d: 120,
};

describe('scoreTraderEvidence', () => {
  it('produces bounded sub-scores and a composite', () => {
    const e = scoreTraderEvidence(SNAP);
    expect(e.pnlScore).toBeGreaterThanOrEqual(0);
    expect(e.pnlScore).toBeLessThanOrEqual(1);
    expect(e.winRateScore).toBeGreaterThanOrEqual(0);
    expect(e.winRateScore).toBeLessThanOrEqual(1);
    expect(e.composite).toBeGreaterThanOrEqual(0);
    expect(e.composite).toBeLessThanOrEqual(1);
  });
  it('a negative-PnL trader scores low on pnl but may keep winRate signal', () => {
    const e = scoreTraderEvidence({ ...SNAP, totalPnl: -5_000, pnl14d: -2_000 });
    expect(e.pnlScore).toBeLessThan(0.5);
  });
  it('zero activity yields zero evidence (no fabrication)', () => {
    const e = scoreTraderEvidence({ wallet: '0x0', totalPnl: 0, winRate: 0, trades14d: 0 });
    expect(e.composite).toBe(0);
  });
});

describe('mergeEvidence', () => {
  it('blends primary and secondary when secondary is fresh and active', () => {
    const merged = mergeEvidence(
      { score: 80, source: 'primary' },
      { evidence: scoreTraderEvidence(SNAP), source: 'analytics', sampleSize: SNAP.trades14d ?? 0 },
    );
    expect(merged.blended).toBeGreaterThan(0);
    expect(merged.blended).toBeLessThanOrEqual(100);
    expect(merged.adjusted).toBe(true);
  });
  it('skips blending when the secondary sample is too small', () => {
    const merged = mergeEvidence(
      { score: 80, source: 'primary' },
      { evidence: scoreTraderEvidence({ ...SNAP, trades14d: 1 }), source: 'analytics', sampleSize: 1 },
    );
    expect(merged.adjusted).toBe(false);
    expect(merged.blended).toBe(80);
  });
});