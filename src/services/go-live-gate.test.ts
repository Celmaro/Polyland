import { describe, expect, it } from 'vitest';
import { computeGoLiveReport, DEFAULT_GO_LIVE_CRITERIA, maxDrawdown } from './go-live-gate.js';
function outcome(i: number, edge: number, domain = 'crypto') {
  return { id: `s${i}`, conditionId: `m${i}`, domain, firedAt: i * 1000, settledAt: i * 86_400_000, realizedEdge: edge, deployedUsd: 10 };
}
describe('go-live gate', () => {
  it('is not ready without independent settled markets', () => {
    const r = computeGoLiveReport([outcome(1, 0.2)], DEFAULT_GO_LIVE_CRITERIA);
    expect(r.ready).toBe(false);
    expect(r.unmet).toContain('minSettledSignals');
    expect(r.unmet).toContain('lcbEdge');
  });
  it('requires a positive clustered lower confidence bound', () => {
    // noisy edges: mean slightly positive, but high variance -> LCB below zero
    const xs = Array.from({ length: 30 }, (_, i) =>
      outcome(i, i % 2 ? 0.05 : -0.04, i % 2 ? 'politics' : 'crypto'));
    const r = computeGoLiveReport(xs, { ...DEFAULT_GO_LIVE_CRITERIA, minWindowMs: 1 });
    expect(r.unmet).toContain('lcbEdge');
  });
  it('passes a deliberately strong synthetic paper record', () => {
    // 40 markets across 4 domains keeps concentration under the 40% cap
    const xs = Array.from({ length: 40 }, (_, i) => outcome(i, 0.20, ['crypto', 'politics', 'sports', 'economics'][i % 4]));
    const r = computeGoLiveReport(xs, { ...DEFAULT_GO_LIVE_CRITERIA, minWindowMs: 1, executionHaircutBps: 0 });
    expect(r.ready).toBe(true);
    expect(r.verdict).toBe('READY');
  });
  it('computes drawdown from cumulative realized edge', () => {
    // cumulative: 0.1 -> 0.05 -> -0.05 -> -0.03; peak 0.1, trough -0.05 => (0.1-(-0.05))/0.1 = 1.5
    expect(maxDrawdown([0.1, -0.05, -0.10, 0.02])).toBeCloseTo(1.5);
  });
});
