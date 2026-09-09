/**
 * Quorum-quality gates (B1–B7): make the basket quorum robust to correlated,
 * thin, or whale-dominated consensus. All pure/stateless — easy to test and
 * to wire into BasketQuorumService. B8 (wallet cooldown) is handled by the
 * risk-manager time-bounded locks.
 */
export interface AlignedVote {
  wallet: string;
  price: number; // entry price of the aligned wallet
  ts: number;    // vote/trade timestamp (ms)
}

export interface ConsensusGateInput {
  aligned: AlignedVote[];
  minAligned: number;
  maxPriceBand: number;      // abs price spread among aligned, e.g. 0.10
  maxTimeSpreadSec: number;  // spread among aligned timestamps, seconds
}
export interface ConsensusGateResult {
  ok: boolean;
  reason: 'insufficient_basket_participants' | 'wide_entry_price_band' | 'wide_entry_time_spread' | null;
  priceBandAbs: number;
  timeSpreadSec: number;
}

/** B1 — reject when aligned wallets' own prices/timestamps are too scattered. */
export function evaluateConsensusGate(input: ConsensusGateInput): ConsensusGateResult {
  const { aligned, minAligned, maxPriceBand, maxTimeSpreadSec } = input;
  const priceBandAbs = pricesSpread(aligned);
  const timeSpreadSec = tsSpread(aligned) / 1000;

  if (aligned.length < minAligned) {
    return { ok: false, reason: 'insufficient_basket_participants', priceBandAbs, timeSpreadSec };
  }
  if (priceBandAbs > maxPriceBand) {
    return { ok: false, reason: 'wide_entry_price_band', priceBandAbs, timeSpreadSec };
  }
  if (timeSpreadSec > maxTimeSpreadSec) {
    return { ok: false, reason: 'wide_entry_time_spread', priceBandAbs, timeSpreadSec };
  }
  return { ok: true, reason: null, priceBandAbs, timeSpreadSec };

  function pricesSpread(votes: AlignedVote[]): number {
    if (votes.length < 2) return 0;
    const prices = votes.map((v) => v.price).sort((a, b) => a - b);
    return prices[prices.length - 1] - prices[0];
  }
  function tsSpread(votes: AlignedVote[]): number {
    if (votes.length < 2) return 0;
    const ts = votes.map((v) => v.ts).sort((a, b) => a - b);
    return ts[ts.length - 1] - ts[0];
  }
}

/** B2 — weighted agreement: aligned notional / total notional. */
export function computeWeightedConsensus(
  alignedWallets: string[],
  allWallets: string[],
  weightOf: (wallet: string) => number,
): { ratio: number; alignedWeight: number; totalWeight: number } {
  const alignedWeight = alignedWallets.reduce((s, w) => s + (weightOf(w) ?? 0), 0);
  const totalWeight = Array.from(new Set(allWallets)).reduce((s, w) => s + (weightOf(w) ?? 0), 0);
  return { ratio: totalWeight > 0 ? alignedWeight / totalWeight : 0, alignedWeight, totalWeight };
}

/** B3 — dominant-wallet share of the ALIGNED weight (penalize past cap). */
export function computeDominantWalletShare(
  alignedWallets: string[],
  weightOf: (wallet: string) => number,
): number {
  if (alignedWallets.length === 0) return 0;
  const values = alignedWallets.map((w) => weightOf(w) ?? 0);
  const total = values.reduce((s, v) => s + v, 0);
  if (total <= 0) return 0;
  return Math.max(...values) / total;
}

/** B4 — Bayesian shrinkage toward neutral for the quorum's confidence. */
export function bayesianConfidence(params: {
  alignedWeight: number;
  totalWeight: number;
  prior: number;
  qualityConsensus?: number;
  dominantShare?: number;
}): { score: number; posterior: number; sampleStrength: number } {
  const { alignedWeight, totalWeight, prior, qualityConsensus = 0.5, dominantShare = 0 } = params;
  const posterior = totalWeight + prior > 0 ? (alignedWeight + prior * 0.5) / (totalWeight + prior) : 0;
  const sampleStrength = totalWeight + prior > 0 ? Math.min(totalWeight / (totalWeight + prior), 1) : 0;
  let score = posterior * sampleStrength;
  score += Math.max(0, qualityConsensus - 0.5) * 0.1;
  score -= Math.max(0, dominantShare - 0.75) * 0.1;
  return { score: round(Math.max(0, Math.min(1, score)), 4), posterior, sampleStrength };
}

/** B5 — penalty when real wallet weight sits on the opposite side. */
export function computeConflictPenalty(params: {
  alignedWeight: number;
  totalWeight: number;
  penaltyWeight: number;
}): number {
  const { alignedWeight, totalWeight, penaltyWeight } = params;
  if (totalWeight <= 0) return 0;
  const conflictRatio = Math.max(0, 1 - alignedWeight / totalWeight);
  return round(conflictRatio * penaltyWeight, 4);
}

/** B6 — rough market-regime classification (drives scoring/sizing). */
export function classifyMarketRegime(params: {
  spreadBps: number;
  depthUsd: number;
  yesAsk: number;
  driftBps?: number;
}): 'RANGE' | 'TRANSITION' | 'TREND' | 'UNSTABLE' {
  const { spreadBps, depthUsd, driftBps = 0 } = params;
  if (spreadBps > 300 || depthUsd < 100) return 'UNSTABLE';
  if (driftBps > 250) return 'TRANSITION';
  if (driftBps > 100) return 'TREND';
  return 'RANGE';
}

/** B7 — dynamic quorum: lower to min ONLY when starved AND quality gates clean. */
export function effectiveQuorum(params: {
  base: number;
  min: number;
  starved: boolean;
  entryQualityClean: boolean;
  walletGateClean: boolean;
}): number {
  const { base, min, starved, entryQualityClean, walletGateClean } = params;
  if (starved && entryQualityClean && walletGateClean) return min;
  return base;
}

function round(v: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(v * scale) / scale;
}