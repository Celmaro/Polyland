import { describe, expect, it } from 'vitest';
import {
  calibrationScore,
  clusteredSE,
  cvarScore,
  drawdownScore,
  effectiveSampleConfidence,
  executionScore,
  finalCopyScore,
  lcbEdge,
  recencyConfidence,
  reliabilityScore,
  riskScore,
  shrunkEdge,
  skillComposite,
  specializationScore,
  stabilityScore,
  type ScoringComponentsResult,
} from './confidence-scoring.js';
describe('effectiveSampleConfidence', () => {
  it('n/(n+prior) with default 30-trade prior', () => {
    expect(effectiveSampleConfidence(30)).toBeCloseTo(0.5);
    expect(effectiveSampleConfidence(200)).toBeGreaterThan(effectiveSampleConfidence(1));
    expect(effectiveSampleConfidence(0)).toBe(0);
  });
  it('rejects negative counts and bad priors', () => {
    expect(effectiveSampleConfidence(-5)).toBe(0);
    expect(effectiveSampleConfidence(10, 0)).toBeGreaterThan(0.9);
    expect(Number.isFinite(effectiveSampleConfidence(NaN))).toBe(true);
  });
});
describe('recencyConfidence', () => {
  it('exponential decay with 30-day half-life', () => {
    expect(recencyConfidence(0)).toBe(1);
    expect(recencyConfidence(30)).toBeCloseTo(Math.exp(-1));
    expect(recencyConfidence(60)).toBeLessThan(recencyConfidence(30));
    expect(recencyConfidence(60, 30)).toBeCloseTo(Math.exp(-2));
  });
});
describe('lcbEdge', () => {
  it('meanEdge − z·SE with default z=1.645', () => {
    expect(lcbEdge(0.1, 0.02).lcb).toBeCloseTo(0.1 - 1.645 * 0.02);
    expect(lcbEdge(0.1, 0.02, 2).lcb).toBeCloseTo(0.1 - 2 * 0.02);
  });
  it('returns 0 with empty flag on non-finite/negative SE', () => {
    expect(lcbEdge(NaN, NaN).lcb).toBe(0);
    expect(lcbEdge(NaN, NaN).empty).toBe(true);
    expect(lcbEdge(0.1, -1).empty).toBe(true);
    expect(lcbEdge(0.1, 0).empty).toBe(false);
  });
});
describe('shrunkEdge', () => {
  it('lambda·meanEdge with lambda = n/(n+prior)', () => {
    expect(shrunkEdge(0.2, 30)).toBeCloseTo(0.2 * 30 / 60);
    expect(shrunkEdge(0.2, 200)).toBeGreaterThan(shrunkEdge(0.2, 1));
    expect(shrunkEdge(0.2, 0)).toBe(0);
    expect(shrunkEdge(0.2, 30, 20)).toBeCloseTo(0.2 * 30 / 50);
  });
});
describe('clusteredSE', () => {
  it('positive dispersion within clusters, zero for flat or empty series', () => {
    expect(clusteredSE([1, 1, -1, -1], ['a', 'a', 'b', 'b'])).toBeGreaterThan(0);
    expect(clusteredSE([1, 1, -1, -1], ['a', 'a', 'a', 'a'])).toBeLessThan(
      clusteredSE([1, 1, -1, -1], ['a', 'a', 'b', 'b']),
    );
    expect(clusteredSE([], [])).toBe(0);
    expect(clusteredSE([1, 1, 1], ['a', 'a', 'a'])).toBe(0);
  });
  it('same-cluster repeats are not counted as independent observations', () => {
    // 10 observations all in ONE market carry the dispersion of that cluster;
    // the within-cluster residual sums cancel, shrinking the SE vs independent obs.
    const sameMarket = clusteredSE([0.5, -0.5, 0.5, -0.5, 0.5, -0.5, 0.5, -0.5, 0.5, -0.5], Array(10).fill('m1'));
    expect(sameMarket).toBe(0);
    const independent = clusteredSE([0.5, -0.5, 0.5, -0.5, 0.5, -0.5, 0.5, -0.5, 0.5, -0.5]);
    expect(independent).toBeGreaterThan(0);
  });
});
describe('calibrationScore', () => {
  it('bounded 0..1, lower loss is better', () => {
    expect(calibrationScore(0, 0.25)).toBe(1);
    expect(calibrationScore(0.25, 0.25)).toBe(0);
    expect(calibrationScore(1, 0.25)).toBe(0);
    expect(calibrationScore(0.125, 0.25)).toBeCloseTo(0.5);
  });
});
describe('drawdownScore and cvarScore', () => {
  it('1 − value/cap, bounded', () => {
    expect(drawdownScore(0, 35)).toBe(1);
    expect(drawdownScore(35, 35)).toBe(0);
    expect(drawdownScore(70, 35)).toBe(0);
    expect(drawdownScore(17.5, 35)).toBeCloseTo(0.5);
    expect(cvarScore(10, 40)).toBeCloseTo(0.75);
    expect(cvarScore(NaN, 40)).toBe(0);
  });
});
describe('stabilityScore', () => {
  it('1 − CV when computable, bounded', () => {
    expect(stabilityScore([0.1, 0.1, 0.1])).toBeCloseTo(1);
    expect(stabilityScore([1])).toBe(0);
    expect(stabilityScore([])).toBe(0);
    expect(stabilityScore([0.1, 0.3])).toBeCloseTo(1 - 0.5);
    expect(stabilityScore([0.5, -0.5])).toBe(0); // zero mean → no stability signal
  });
});
describe('skillComposite', () => {
  it('fixed weights 0.35/0.20/0.15/0.15/0.15, bounded 0..1', () => {
    expect(skillComposite(1, 1, 1, 1, 1)).toBe(1);
    expect(skillComposite(0, 0, 0, 0, 0)).toBe(0);
    expect(skillComposite(1, 0, 0, 0, 0)).toBeCloseTo(0.35);
    expect(skillComposite(2, -1, 1, 0.5, 0.5)).toBeLessThanOrEqual(1);
    expect(skillComposite(0.5, 0.5, 0.5, 0.5, 0.5)).toBeCloseTo(0.5);
  });
});
describe('reliabilityScore', () => {
  it('product collapses when any term is low', () => {
    expect(reliabilityScore(1, 1, 1, 1)).toBe(1);
    expect(reliabilityScore(0.01, 1, 1, 1)).toBeLessThanOrEqual(0.01);
    expect(reliabilityScore(1, 1, 1, 0.1)).toBeLessThan(0.2);
    expect(reliabilityScore(1, 1, 1, 0)).toBe(0);
  });
});
describe('executionScore', () => {
  it('product of fill, slippage, latency, depth — each bounded', () => {
    expect(executionScore(1, 0, 100, 1, 1)).toBe(1);
    expect(executionScore(0.5, 0, 100, 1, 1)).toBeCloseTo(0.5);
    expect(executionScore(1, 50, 100, 1, 1)).toBeCloseTo(0.5);
    expect(executionScore(1, 150, 100, 1, 1)).toBe(0);
    expect(executionScore(1, 10, 0, 1, 1)).toBe(0); // zero cap → any slippage kills
    expect(executionScore(1.5, -5, 100, 1, 1)).toBe(1); // clamped in
  });
});
describe('specializationScore', () => {
  it('requires the independent-market floor, then averages evidence', () => {
    expect(specializationScore(0.2, 0.9, 1, 12, 1)).toBe(0);
    expect(specializationScore(0.2, 0.9, 1, 12, 30)).toBeCloseTo((0.2 + 0.9 + 1) / 3);
    expect(specializationScore(-0.5, 0.9, 1, 12, 30)).toBeCloseTo((0 + 0.9 + 1) / 3);
  });
});
describe('riskScore', () => {
  it('weighted 0.35/0.35/0.20/0.10, bounded', () => {
    expect(riskScore(1, 1, 1, 1)).toBeCloseTo(1);
    expect(riskScore(0, 0, 0, 0)).toBe(0);
    expect(riskScore(1, 0, 0, 0)).toBeCloseTo(0.35);
    expect(riskScore(0.5, 0.5, 0.5, 0.5)).toBeCloseTo(0.5);
  });
});
describe('finalCopyScore', () => {
  it('weights evidence and confidence while preserving hard gates', () => {
    expect(finalCopyScore(1, 1, 1, 1, 1)).toBe(100);
    expect(finalCopyScore(0, 1, 1, 1, 1)).toBe(0);
    expect(finalCopyScore(1, 1, 1, 0, 1)).toBe(0);
    expect(finalCopyScore(0.9, 0.9, 1, 1, 0.9)).toBeGreaterThan(70);
  });
  it('a skilled but low-execution wallet is demoted', () => {
    const skilled = finalCopyScore(0.9, 0.9, 1, 1, 0.9);
    const hardToCopy = finalCopyScore(0.9, 0.9, executionScore(0.4, 80, 100, 0.5, 0.5), 1, 0.9);
    expect(hardToCopy).toBeLessThan(skilled * 0.4);
  });
});
describe('confidence-aware scenarios (pure derivations)', () => {
  it('a one-market wallet cannot reach SATELLITE/PRIMARY even with perfect edge', () => {
    const sampleConf = effectiveSampleConfidence(1);
    const reliability = reliabilityScore(sampleConf, 1, 1, 1);
    // Market-floor specialization is 0 at nMarkets=1 with default gate.
    const spec = specializationScore(0.2, 1, 1, 12, 1);
    const score = finalCopyScore(skillComposite(0.9, 1, 1, 1, 1), reliability, 1, spec, 1);
    expect(score).toBeLessThan(45);
    expect(score).toBeLessThan(65);
  });
  it('a 30-market positive-LCB wallet can reach PRIMARY when evidence is clean', () => {
    const sampleConf = effectiveSampleConfidence(200);
    const reliability = reliabilityScore(sampleConf, 1, 1, 1);
    const lcb = lcbEdge(0.6, 0.02).lcb; // strong positive LCB (> 0)
    const spec = specializationScore(lcb, 1, 1, 12, 200);
    const score = finalCopyScore(skillComposite(0.9, 1, 1, 1, 1), reliability, 1, spec, 1);
    expect(score).toBeGreaterThanOrEqual(65);
  });
  it('identical win rate scores higher with n=200 than n=1', () => {
    const skill200 = skillComposite(0.8, 1, 1, 1, 1);
    const skill1 = skillComposite(0.8, 1, 1, 1, 1);
    const spec1 = specializationScore(0.2, 1, 1, 12, 1);
    const spec200 = specializationScore(0.2, 1, 1, 12, 200);
    const score1 = finalCopyScore(skill1, reliabilityScore(effectiveSampleConfidence(1), 1, 1, 1), 1, spec1, 1);
    const score200 = finalCopyScore(skill200, reliabilityScore(effectiveSampleConfidence(200), 1, 1, 1), 1, spec200, 1);
    expect(score200).toBeGreaterThan(score1);
  });
  it('old wins decay via recency confidence', () => {
    const fresh = finalCopyScore(0.8, reliabilityScore(effectiveSampleConfidence(100), recencyConfidence(1), 1, 1), 1, 1, 1);
    const stale = finalCopyScore(0.8, reliabilityScore(effectiveSampleConfidence(100), recencyConfidence(90), 1, 1), 1, 1, 1);
    expect(stale).toBeLessThan(fresh);
  });
  it('reliability product collapses when sample or identity is low', () => {
    const noIdentity = finalCopyScore(0.9, reliabilityScore(effectiveSampleConfidence(200), 1, 1, 0.05), 1, 1, 1);
    const thinSample = finalCopyScore(0.9, reliabilityScore(effectiveSampleConfidence(1), 1, 1, 1), 1, 1, 1);
    expect(noIdentity).toBeLessThan(45);
    expect(thinSample).toBeLessThan(45);
  });
  it('ScoringComponentsResult exposes every input for operator explanation', () => {
    const result: ScoringComponentsResult = {
      meanEdge: 0.1, edgeN: 30, shrunkEdgeValue: 0.05, edgeSe: 0.02, edgeLcb: 0.02,
      calibration: 0.8, logReturnScore: 0.6, stability: 0.7, tailRiskScore: 0.9,
      skillCompositeScore: 0.7, sampleConfidence: 0.5, recencyConfidence: 1,
      dataCompleteness: 1, identityIntegrity: 1, reliabilityScoreValue: 0.5,
      fillRate: 1, slippageBps: 10, slippageScore: 0.9, latencySurvival: 1, depthSurvival: 1,
      executionScoreValue: 0.9, nMarkets: 30, specializationMinMarkets: 12,
      specializationScoreValue: 0.8, drawdownScoreValue: 0.9, cvarScoreValue: 0.9,
      maeScoreValue: 0.9, recoveryScoreValue: 0.5, riskScoreValue: 0.86, copyScore: 42,
    };
    expect(result.skillCompositeScore + result.reliabilityScoreValue).toBeGreaterThan(1);
    expect(result.copyScore).toBe(42);
  });
});