/**
 * confidence-scoring.ts
 *
 * Pure, unit-testable building blocks for the confidence-aware CopyScore
 * (findings.md slices B/C). These functions combine pre-computed inputs;
 * they never fetch data and never compute edges from raw positions — the
 * caller (WalletScreeningService) reconstructs per-position edge values,
 * calibration losses, execution metrics, and market counts, then composes
 * them here.
 *
 * Prior choices (documented hypotheses, to be re-fit on holdout):
 *   - priorTrades       = 30   n/(n+30) shrinkage toward zero edge
 *   - recency half-life = 30 days  exp(-days/30) — one-trade wallets decay fast
 *   - z for LCB         = 1.645  one-sided 95% lower confidence bound
 *   - calibration baseline = naive-forecast loss supplied by the caller
 *     (e.g. Brier 0.25 = coin-flip, or log-loss ln2); score = 1 − loss/baseline
 *   - drawdown/CVaR caps, slippage caps, min-markets gating: caller-supplied
 *     config values, not hardcoded here.
 *
 * Every function clamps inputs to their stated domain and returns values in
 * [0,1] (or a small typed result). Non-finite inputs collapse to the neutral
 * value for that component — never to an optimistic one.
 */
export interface LcbEdgeResult {
  /** Lower confidence bound = meanEdge − z·SE. 0 when inputs are empty/non-finite. */
  lcb: number;
  /** True when no finite edge data was supplied (caller should treat LCB as zero). */
  empty: boolean;
}
/** One-sided lower confidence bound on mean edge: meanEdge − z·SE (default z = 1.645 = 95% one-sided). */
export function lcbEdge(meanEdge: number, se: number, z = 1.645): LcbEdgeResult {
  const empty = !Number.isFinite(meanEdge) || !Number.isFinite(se) || se < 0;
  if (empty) return { lcb: 0, empty: true };
  return { lcb: meanEdge - z * se, empty: false };
}
/** Sample confidence: n/(n+priorTrades). Default 30-trade equivalent prior. */
export function effectiveSampleConfidence(nIndependent: number, priorTrades = 30): number {
  const n = Math.max(0, Number.isFinite(nIndependent) ? nIndependent : 0);
  const prior = Math.max(1, Number.isFinite(priorTrades) ? priorTrades : 30);
  return n / (n + prior);
}
/** Recency confidence: exp(−days/halfLife). Default half-life 30 days. */
export function recencyConfidence(lastActiveDays: number, halfLifeDays = 30): number {
  const days = Math.max(0, Number.isFinite(lastActiveDays) ? lastActiveDays : 0);
  const halfLife = Math.max(1, Number.isFinite(halfLifeDays) ? halfLifeDays : 30);
  return Math.exp(-days / halfLife);
}
/**
 * Shrunk mean edge toward zero: λ·meanEdge with λ = n/(n+priorTrades).
 * The 30-event zero prior is the findings.md 2.1 hypothesis.
 */
export function shrunkEdge(meanEdge: number, n: number, priorTrades = 30): number {
  if (!Number.isFinite(meanEdge)) return 0;
  const count = Math.max(0, Number.isFinite(n) ? n : 0);
  const prior = Math.max(1, Number.isFinite(priorTrades) ? priorTrades : 30);
  if (count === 0) return 0;
  const lambda = count / (count + prior);
  return lambda * meanEdge;
}
/**
 * Cluster-robust standard error of the mean (sandwich, per-cluster sums).
 * Residuals r_i = edge_i − mean(edges); cluster contribution η_g = Σ_{i∈g} r_i.
 * CR0 variance V = (G/(G−1)) · Σ_g η_g² / n²  for G ≥ 2; without the
 * few-clusters correction when G < 2 (degrades to the classic SE when every
 * observation is its own cluster). Returns 0 for empty input.
 */
export function clusteredSE(edges: number[], clusterIds: string[] = []): number {
  const n = edges.length;
  if (n === 0) return 0;
  const valid = edges.filter((e) => Number.isFinite(e));
  if (valid.length < 2) return 0;
  const mean = valid.reduce((s, e) => s + e, 0) / valid.length;
  const ids = clusterIds.length === n ? clusterIds : valid.map((_, i) => String(i));
  const byCluster = new Map<string, number[]>();
  for (let i = 0; i < valid.length; i++) {
    const id = ids[i] ?? String(i);
    const bucket = byCluster.get(id) ?? [];
    bucket.push(valid[i]);
    byCluster.set(id, bucket);
  }
  const g = byCluster.size;
  let sumEtaSq = 0;
  for (const members of byCluster.values()) {
    const eta = members.reduce((s, e) => s + (e - mean), 0);
    sumEtaSq += eta * eta;
  }
  const correction = g >= 2 ? g / (g - 1) : 1;
  const variance = (correction * sumEtaSq) / (n * n);
  return Math.sqrt(Math.max(0, variance));
}
/**
 * Calibration score: 1 − loss/baseline, bounded 0..1, higher = better.
 * loss is Brier or log-loss (≥0); baseline is the naive-forecast loss
 * (e.g. 0.25 coin-flip Brier). loss ≤ baseline → ≥ 0; loss ≥ baseline → 0.
 */
export function calibrationScore(brierOrLogLoss: number, baseline: number): number {
  const loss = Math.max(0, Number.isFinite(brierOrLogLoss) ? brierOrLogLoss : Number.POSITIVE_INFINITY);
  const base = Number.isFinite(baseline) ? baseline : 0;
  if (loss <= 0) return 1;
  if (base <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - loss / base));
}
/** Drawdown score: 1 − maxDrawdownPct/capPct, bounded 0..1. */
export function drawdownScore(maxDrawdownPct: number, capPct: number): number {
  const dd = Math.max(0, Number.isFinite(maxDrawdownPct) ? maxDrawdownPct : Number.POSITIVE_INFINITY);
  const cap = Math.max(1e-9, Number.isFinite(capPct) ? Math.abs(capPct) : 1);
  if (dd <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - dd / cap));
}
/** CVaR score: 1 − cvar95Pct/capPct, bounded 0..1. */
export function cvarScore(cvar95Pct: number, capPct: number): number {
  const cvar = Math.max(0, Number.isFinite(cvar95Pct) ? cvar95Pct : Number.POSITIVE_INFINITY);
  const cap = Math.max(1e-9, Number.isFinite(capPct) ? Math.abs(capPct) : 1);
  if (cvar <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - cvar / cap));
}
/**
 * Stability score from sub-period edges: 1 − CV where computable.
 * Perfectly flat series (sd = 0, n ≥ 2) → 1; zero mean with dispersion → 0;
 * fewer than 2 sub-periods → 0 (no stability evidence).
 */
export function stabilityScore(subperiodEdges: number[]): number {
  const values = (subperiodEdges ?? []).filter((e) => Number.isFinite(e));
  if (values.length < 2) return 0;
  const mean = values.reduce((s, e) => s + e, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((s, e) => s + (e - mean) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return 1;
  const cv = sd / Math.abs(mean);
  return Math.max(0, Math.min(1, 1 - cv));
}
const clamp01 = (v: number, fallback = 0): number => {
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, v));
};
/**
 * Skill composite (0..1): 0.35·edge + 0.20·calib + 0.15·logRet + 0.15·stability + 0.15·tail.
 * All inputs are 0..1 scores (edge: shrunk edge value; tail: tail-risk score).
 */
export function skillComposite(
  edge: number, calib: number, logRet: number, stability: number, tail: number,
): number {
  const e = clamp01(edge);
  const c = clamp01(calib);
  const l = clamp01(logRet);
  const s = clamp01(stability);
  const t = clamp01(tail);
  return Math.max(0, Math.min(1, 0.35 * e + 0.20 * c + 0.15 * l + 0.15 * s + 0.15 * t));
}
/**
 * Reliability: PRODUCT of sample × recency × dataCompleteness × identity,
 * each 0..1. A single weak term collapses the product (a 1-trade wallet, or
 * an unverified identity, cannot be rescued by the other terms).
 */
export function reliabilityScore(
  sample: number, recency: number, dataCompleteness: number, identity: number,
): number {
  const s = clamp01(sample);
  const r = clamp01(recency);
  const d = clamp01(dataCompleteness);
  const i = clamp01(identity);
  return s * r * d * i;
}
/**
 * Execution / copyability score: fillRate × (1 − slippageBps/cap) ×
 * latencySurvival × depthSurvival, each factor bounded 0..1, product bounded.
 */
export function executionScore(
  fillRate: number, slippageBps: number, slippageCapBps: number,
  latencySurvival: number, depthSurvival: number,
): number {
  const fill = clamp01(fillRate);
  const slip = Number.isFinite(slippageBps) ? Math.max(0, slippageBps) : Number.POSITIVE_INFINITY;
  const cap = Number.isFinite(slippageCapBps) ? Math.abs(slippageCapBps) : 0;
  const slippageFactor = slip <= 0 ? 1 : cap > 0 ? Math.max(0, Math.min(1, 1 - slip / cap)) : 0;
  const latency = clamp01(latencySurvival);
  const depth = clamp01(depthSurvival);
  return Math.max(0, Math.min(1, fill * slippageFactor * latency * depth));
}
/**
 * Specialization: 0 unless the wallet has >= minMarkets independent observed
 * markets; otherwise mean of edge/calibration/execution evidence (0..1).
 * nMarkets < minMarkets → 0 (no domain proof, regardless of skill).
 */
export function specializationScore(
  lcbEdge: number, calibration: number, execution: number,
  minMarkets: number, nMarkets: number,
): number {
  const min = Math.max(0, Number.isFinite(minMarkets) ? minMarkets : 0);
  const n = Math.max(0, Number.isFinite(nMarkets) ? nMarkets : 0);
  if (n < min) return 0;
  const lcb = clamp01(lcbEdge);
  const calib = clamp01(calibration);
  const exec = clamp01(execution);
  return (lcb + calib + exec) / 3;
}
/**
 * Risk score (0..1, higher = safer): 0.35·drawdown + 0.35·cvar + 0.20·mae + 0.10·recovery.
 * Inputs are 0..1 risk-component SCORES (e.g. drawdownScore/cvarScore output).
 */
export function riskScore(
  drawdown: number, cvar: number, mae: number, recovery: number,
): number {
  const dd = clamp01(drawdown);
  const cv = clamp01(cvar);
  const m = clamp01(mae);
  const rec = clamp01(recovery);
  return Math.max(0, Math.min(1, 0.35 * dd + 0.35 * cv + 0.20 * m + 0.10 * rec));
}
/** Final confidence-aware CopyScore (0..100).
 *
 * Components are evidence dimensions, not independent probabilities; multiplying
 * all five double-penalizes the same sparse/volatile sample. Use an explicit
 * weighted evidence score and retain reliability/execution as multiplicative
 * confidence gates. This keeps meaningful 60%/100-market wallets viable while
 * preventing one-trade wallets from being promoted.
 */
export function finalCopyScore(
  skill: number, reliability: number, execution: number, specialization: number, risk: number,
): number {
  const s = clamp01(skill);
  const r = clamp01(reliability);
  const e = clamp01(execution);
  const sp = clamp01(specialization);
  const rk = clamp01(risk);
  if (s <= 0 || sp <= 0 || e <= 0) return 0;
  const evidence = 0.50 * s + 0.20 * sp + 0.20 * rk + 0.10 * e;
  // Execution is a hard copyability gate; confidence is softened with a
  // square-root transform so sparse evidence is penalized without making
  // a statistically meaningful wallet unusable because one risk sub-score
  // is conservative. Specialization/risk remain evidence dimensions.
  const score = 100 * evidence * e * Math.sqrt(r);
  return score >= 99.999999999 ? 100 : Math.max(0, score);
}
/**
 * Operator-facing trail of every input that produced a CopyScore — the answer
 * to "why was this wallet scored this way?". Populated by the integration.
 */
export interface ScoringComponentsResult {
  // Skill evidence
  /** Mean edge over settled positions (simple return on cost basis), pre-shrinkage. */
  meanEdge: number;
  /** Number of settled positions backing meanEdge. */
  edgeN: number;
  /** Bayesian-shrunk edge: λ·meanEdge, λ = n/(n+30). */
  shrunkEdgeValue: number;
  /** Cluster-robust SE of the mean edge (clustered by market/conditionId). */
  edgeSe: number;
  /** Lower confidence bound with z = 1.645. */
  edgeLcb: number;
  /** Calibration score 0..1 (1 − loss/baseline). */
  calibration: number;
  /** Log-return score 0..1. */
  logReturnScore: number;
  /** Stability score 0..1 (1 − CV of sub-period edges). */
  stability: number;
  /** Tail-risk score 0..1. */
  tailRiskScore: number;
  /** Skill composite 0..1. */
  skillCompositeScore: number;
  // Reliability evidence
  /** n/(n+30) over independent markets. */
  sampleConfidence: number;
  /** exp(−days/30) since last active. */
  recencyConfidence: number;
  /** 0..1 — fraction of expected position fields present. */
  dataCompleteness: number;
  /** 0..1 — 1 when the wallet carries a verified identity marker. */
  identityIntegrity: number;
  /** Reliability = product of the four terms above. */
  reliabilityScoreValue: number;
  // Execution evidence
  fillRate: number;
  slippageBps: number;
  slippageScore: number;
  latencySurvival: number;
  depthSurvival: number;
  /** Execution score 0..1 (product). */
  executionScoreValue: number;
  // Specialization evidence
  /** Number of distinct markets with settled positions. */
  nMarkets: number;
  specializationMinMarkets: number;
  /** Specialization score 0..1 (0 below the market floor). */
  specializationScoreValue: number;
  // Risk evidence
  drawdownScoreValue: number;
  cvarScoreValue: number;
  maeScoreValue: number;
  recoveryScoreValue: number;
  /** Risk score 0..1 (higher = safer). */
  riskScoreValue: number;
  /** Final CopyScore 0..100. */
  copyScore: number;
}