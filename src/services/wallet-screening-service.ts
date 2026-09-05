/**
 * WalletScreeningService
 *
 * Quality gate that runs the SAME screen on every wallet, regardless
 * of whether it came from the MANUAL or AUTO ingestion source.
 *
 * Scoring methodology is adapted from Poly Syncer / Polycopy research:
 *   score = 0.45·smart_score_normalized
 *         + 0.20·recency/shrinkage_adjusted_edge
 *         + 0.15·log_roi_normalized
 *         + 0.10·drawdown_resilience
 *         + 0.10·rank_stability
 *
 * Each component is bounded 0–1. SmartScore is quantified once, as the 45%
 * risk-adjusted-performance component; it is not reused as slippage.
 *
 * CopyScore is 0–100 (score × 100, capped 0–100).
 *
 * ==== Tier thresholds ====
 *   PRIMARY    copyScore >= 65 AND consistency >= primaryConsistency
 *   SATELLITE  copyScore >= 45 AND consistency >= minConsistency
 *   WATCHLIST  passed profile check but below thresholds
 *   REJECTED  bot signature | drawdown | insufficient data | inactive
 *
 * ==== Bot detection ====
 *   HFT flag:  orders/day > 90 (Polysyncer/Polycopy threshold)
 *   AMM flag:  winRate > 75% AND tradeCount > 500 AND smartScore >= 95
 *   Spread-capture flag:  near-50% winRate at extreme fill frequency
 *
 * ==== Wiring ====
 *   const screening = new WalletScreeningService(walletService, {
 *     minTradeCount: 150,
 *     minWinRate: 0.60,
 *     primaryConsistency: 92,
 *     minConsistency: 82,
 *     maxDrawdownPct: 35,
 *     maxInactiveDays: 60,
 *     minCategoryWinRate: 0.58,
 *     minCategoryTrades: 12,
 *     minProfitFactor: 1.5,
 *   });
 *   const screened = await screening.score(candidates);
 *   basket.seed(screened);
 */
import type { WalletService, WalletProfile } from './wallet-service.js';
import type { RawCandidate } from './wallet-ingestion-service.js';
import type { ActivityCache } from './activity-cache.js';
import type { ClosedPosition } from '../clients/data-api.js';
import { categorizeMarket, type MarketCategory } from './smart-money-service.js';
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
/**
 * Normalize an arbitrary leaderboard/hint category string to a valid
 * lowercase MarketCategory. Leaderboard emits OVERALL, CULTURE, MENTIONS,
 * WEATHER, TECH, FINANCE — none of which are valid MarketCategory values,
 * so wallets labeled that way would be seeded into a ghost basket that
 * never receives a matching trade (categorizeMarket never returns them).
 */
function normalizeCategory(raw: string): MarketCategory {
  const cat = (raw ?? '').toLowerCase();
  switch (cat) {
    case 'politics': return 'politics';
    case 'sports': return 'sports';
    case 'crypto': return 'crypto';
    case 'esports': return 'esports';
    case 'entertainment': return 'entertainment';
    case 'culture': return 'entertainment';
    case 'economics': return 'economics';
    case 'finance': return 'economics';
    case 'science': return 'science';
    case 'tech': return 'science';
    case 'mentions': return 'other';
    case 'weather': return 'other';
    case 'other': return 'other';
    default: return 'other';  // OVERALL etc.
  }
}
// ============================================================================
// Config
// ============================================================================
export interface WalletScreeningConfig {
  /** Minimum number of historical trades required to score a wallet */
  minTradeCount: number;
  /** Minimum win rate (0–1) for PRIMARY tier */
  minWinRate: number;
  /**
   * Deprecated — consistency is now a component of CopyScore (steadiness),
   * not a separate tier gate. Kept optional for config back-compat.
   */
  minConsistency?: number;
  /** @deprecated See minConsistency. */
  primaryConsistency?: number;
  /** Max drawdown % allowed before REJECTED */
  maxDrawdownPct: number;
  /**
   * Wallets firing more than this many orders per day are flagged as HFT/AmM.
   * Polycopy flags 90+ orders/day as bot signatures.
   */
  maxOrdersPerDay: number;
  /** Concurrency for profile fetches */
  profileFetchConcurrency: number;
  /**
   * A wallet only joins a basket for categories where its CATEGORY-SPECIFIC
   * win rate beats this baseline. Stops a strong-crypto wallet from polluting
   * the politics basket.
   */
  minCategoryWinRate: number;
  /**
   * Minimum number of category-specific trades before we trust a per-category
   * win rate. Below this the wallet has no demonstrated edge in that category.
   */
  minCategoryTrades: number;
  /** Wallets inactive longer than this (days) are skipped — edge decays */
  maxInactiveDays: number;
  /** Number of days used for timestamped closed-position win rate. */
  winRateWindowDays: number;
  /** Equivalent 50% prior trades used to shrink observed win rate. */
  winRatePriorTrades: number;
  /**
   * Minimum CopyScore (0–100) for PRIMARY tier.
   * PRIMARY: elite wallets with score >= primaryCopyScoreThreshold.
   */
  primaryCopyScoreThreshold: number;
  /**
   * Minimum CopyScore (0–100) for SATELLITE tier.
   * SATELLITE: above-median wallets scoring >= satelliteCopyScoreThreshold.
   */
  satelliteCopyScoreThreshold: number;
}
export const DEFAULT_SCREENING_CONFIG: WalletScreeningConfig = {
  // 100+ trades = full data marker in the industry rubric; CopyScore's
  // shrinkage adjustment already penalizes thin samples below this.
  minTradeCount: 100,
  minWinRate: 0.60,
  minConsistency: 82,
  primaryConsistency: 92,
  maxDrawdownPct: 35,
  maxOrdersPerDay: 90,    // Polycopy: 90+ orders/day = bot signature
  profileFetchConcurrency: 4,
  // Category specialization: must prove edge inside the specific basket routed to.
  // 58% win rate over >= 3 SETTLED category positions beats coin-flip-with-vig.
  // (Settled positions aggregate fills — 3 settled markets is a real sample.)
  minCategoryWinRate: 0.58,
  minCategoryTrades: 3,
  // Edge decays — a wallet idle 60+ days is not a live signal source.
  maxInactiveDays: 60,
  // Win-rate recency window (days) over timestamped closed positions; a
  // lifetime 50%-prior shrinkage equivalent of 20 trades; below that many
  // window trades the window rate is blended toward lifetime rate.
  winRateWindowDays: 14,
  winRatePriorTrades: 20,
  // CopyScore thresholds (0–100 composite — Poly Syncer/Polycopy methodology).
  // PRIMARY: top-tier elite wallets (score >= 65).
  // SATELLITE: above-median contributors (score >= 45).
  primaryCopyScoreThreshold: 65,
  satelliteCopyScoreThreshold: 45,
};
// ============================================================================
// Scoring components
// ============================================================================
/**
 * The five sub-components of the composite CopyScore, each bounded 0–1.
 * These mirror the Poly Syncer methodology adapted for our WalletProfile shape.
 */
export interface WalletScoringComponents extends ScoringComponentsResult {
  /** Legacy aliases retained for consumers of the pre-Phase-2 shape. */
  sharpeNormalized: number;
  edgeAdjustedWinRate: number;
  logRoiNormalized: number;
  drawdownResilience: number;
  rankStability: number;
  sampleSize: number;
  adjustedWinRate: number;
  effectiveSampleSize: number;
}
// ============================================================================
// Screened wallet
// ============================================================================
export type WalletTier = 'PRIMARY' | 'SATELLITE' | 'WATCHLIST' | 'REJECTED';
/**
 * Six-dimension wallet quality score (PredictEngine pattern).
 * Each dimension is normalized 0–100.
 * Retained for backward compatibility with existing dashboard/logging code.
 */
export interface WalletDimensions {
  profitability: number;
  timing: number;
  slippage: number;
  consistency: number;
  marketSelection: number;
  recency: number;
}
export interface ScreenedWallet {
  address: string;
  tier: WalletTier;
  source: 'manual' | 'auto' | 'both';
  label?: string;
  // Resolved category
  category: MarketCategory;
  categorySource: 'manual' | 'auto' | 'inferred' | 'unset';
  categoryConfidence: number;
  // Six-dimension scores (0–100 each) — retained for dashboard display
  dimensions: WalletDimensions;
  // Composite CopyScore 0–100 (Poly Syncer / Polycopy methodology)
  copyScore: number;
  scoringComponents?: WalletScoringComponents;
  // Computed quality metrics
  consistency: number;   // 0–100 composite (Polymeteo formula)
  winRate: number;       // 0–1
  profitFactor: number;
  maxDrawdownPct: number;
  smartScore: number;     // 0–100 from WalletProfile
  tradeCount: number;
  // Bot detection
  isBotSuspect: boolean;
  botReason?: string;
  // Category specialization
  categoryWinRates: Record<string, { winRate: number; tradeCount: number }>;
  specializesInResolvedCategory: boolean;
  // Operator override
  bypassed: boolean;
  // Reason tag
  reason: string;
}
// ============================================================================
// Hampel filter helpers
// ============================================================================
/**
 * Median Absolute Deviation (MAD) — used for outlier detection in PnL series.
 * Part of the Hampel filter used by Poly Syncer to exclude extreme PnL
 * observations from Sharpe and ROI computations while preserving them in
 * win-rate and drawdown calculations.
 */
function mad(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];
  const deviations = values.map((v) => Math.abs(v - median));
  const madSorted = [...deviations].sort((a, b) => a - b);
  const madMedian = madSorted.length % 2 === 0
    ? (madSorted[madSorted.length / 2 - 1] + madSorted[madSorted.length / 2]) / 2
    : madSorted[Math.floor(madSorted.length / 2)];
  return madMedian;
}
/**
 * Hampel filter: returns true if a value is an outlier (> 3.5 × MAD from median).
 * These are excluded from Sharpe/ROI but preserved in win-rate/drawdown.
 */
function isHampelOutlier(value: number, series: number[]): boolean {
  const m = mad(series);
  if (m === 0) return false;
  const median = [...series].sort((a, b) => a - b)[Math.floor(series.length / 2)];
  return Math.abs(value - median) > 3.5 * m;
}
// ============================================================================
// Service
// ============================================================================
export class WalletScreeningService {
  private walletService: WalletService;
  private config: WalletScreeningConfig;
  private activityCache: ActivityCache | null = null;
  constructor(walletService: WalletService, config: Partial<WalletScreeningConfig> = {}) {
    this.walletService = walletService;
    this.config = { ...DEFAULT_SCREENING_CONFIG, ...config };
  }
  setActivityCache(cache: ActivityCache): void {
    this.activityCache = cache;
  }
  async score(candidates: RawCandidate[]): Promise<ScreenedWallet[]> {
    const toScore = candidates;
    // Fetch profiles and resolve categories in parallel
    const [profiles, resolvedCategories] = await Promise.all([
      this.fetchProfiles(toScore),
      this.resolveCategories(toScore),
    ]);
    // Fetch per-category win rates + full closed-position series in parallel.
    const closedStats = await this.fetchClosedPositionStats(
      toScore.filter((c) => profiles.has(c.address)),
    );
    const screened: ScreenedWallet[] = [];
    const gateCounts: Record<string, number> = {};
    for (const c of toScore) {
      const profile = profiles.get(c.address) ?? null;
      const resolved = resolvedCategories.get(c.address);
      const { winRates, positions } = closedStats.get(c.address) ?? { winRates: {}, positions: [] };
      screened.push(c.bypassScreening
        ? this.makeBypassed(c, resolved)
        : this.evaluate(c, profile, resolved, winRates, positions, gateCounts));
    }
    // Candidate-level diagnostics are expensive/noisy in production. Keep the
    // aggregate gate tally; enable DEBUG_SCREENING=true for per-wallet output.
    const entries = Object.entries(gateCounts).sort((a, b) => b[1] - a[1]);
    if (entries.length > 0) {
      console.log('[WalletScreening] gate tally: ' + entries.map(([k, v]) => `${k}=${v}`).join(' '));
    }
    return screened;
  }
  // --------------------------------------------------------------------------
  // Profile fetch (parallel, bounded concurrency)
  // --------------------------------------------------------------------------
  private async fetchProfiles(
    candidates: RawCandidate[],
  ): Promise<Map<string, WalletProfile>> {
    const results = new Map<string, WalletProfile>();
    const queue = [...candidates];
    const errors: string[] = [];
    await this.runBounded(this.config.profileFetchConcurrency, queue, async (c) => {
      try {
        const profile = await this.walletService.getWalletProfile(c.address);
        results.set(c.address, profile);
      } catch {
        errors.push(c.address);
      }
    });
    if (errors.length > 0) {
      console.warn(`[WalletScreening] ${errors.length} profile fetch failures`);
    }
    return results;
  }
  // --------------------------------------------------------------------------
  // Category resolution
  // --------------------------------------------------------------------------
  private async resolveCategories(
    candidates: RawCandidate[],
  ): Promise<Map<string, { category: MarketCategory; source: 'manual' | 'auto' | 'inferred'; confidence: number }>> {
    const results = new Map<string, { category: MarketCategory; source: 'manual' | 'auto' | 'inferred'; confidence: number }>();
    await Promise.all(
      candidates.map(async (c) => {
        // Priority: manual hint > auto/leaderboard category > activity inference > 'other'
        // All normalized to LOWERCASE MarketCategory — categorizeMarket() and
        // basket keys are lowercase, and a 'POLITICS' vs 'politics' mismatch
        // silently breaks categoryWinRates lookups AND basket routing at trade time.
        // Leaderboard emits categories (OVERALL, CULTURE, MENTIONS, WEATHER, TECH,
        // FINANCE) that are NOT valid MarketCategory — map them here so those wallets
        // don't land in a ghost basket that never receives a matching trade.
        if (c.hintCategory) {
          results.set(c.address, { category: normalizeCategory(c.hintCategory), source: 'manual', confidence: 1 });
          return;
        }
        if (c.leaderboardCategory) {
          results.set(c.address, { category: normalizeCategory(c.leaderboardCategory), source: 'auto', confidence: 0.9 });
          return;
        }
        // Inference from recent activity — check cache first
        const cached = this.activityCache?.get(c.address) as { activities?: Array<{ title?: string }> } | null;
        if (cached?.activities?.[0]?.title) {
          const inferred = categorizeMarket(cached.activities[0].title!) as MarketCategory;
          results.set(c.address, { category: inferred, source: 'inferred', confidence: 0.6 });
          return;
        }
        results.set(c.address, { category: 'other', source: 'inferred', confidence: 0.3 });
      }),
    );
    return results;
  }
  // --------------------------------------------------------------------------
  // Per-category win rates
  // --------------------------------------------------------------------------
  private async fetchClosedPositionStats(
    candidates: RawCandidate[],
  ): Promise<Map<string, { winRates: Record<string, { winRate: number; tradeCount: number }>; positions: ClosedPosition[] }>> {
    const results = new Map<string, { winRates: Record<string, { winRate: number; tradeCount: number }>; positions: ClosedPosition[] }>();
    await Promise.all(
      candidates.map(async (c) => {
        try {
          // CLOSED positions — settled markets only. This is where realizedPnl
          // and final outcomes live. Open positions have no realized outcome.
          const closed = await this.walletService.getWalletClosedPositions(c.address);
          const byCategory: Record<string, { wins: number; total: number }> = {};
          for (const pos of closed) {
            const cat = categorizeMarket(pos.title ?? '') as MarketCategory;
            if (!byCategory[cat]) byCategory[cat] = { wins: 0, total: 0 };
            byCategory[cat].total++;
            if ((pos.realizedPnl ?? 0) > 0) byCategory[cat].wins++;
          }
          const winRates: Record<string, { winRate: number; tradeCount: number }> = {};
          for (const [cat, stats] of Object.entries(byCategory)) {
            winRates[cat] = {
              winRate: stats.total > 0 ? stats.wins / stats.total : 0,
              tradeCount: stats.total,
            };
          }
          results.set(c.address, { winRates, positions: closed });
        } catch (err) {
          // LOG the failure — a silent {} here starves the specialization gate
          // and makes catStat undefined for the wallet downstream.
          console.warn(`[WalletScreening] closed positions failed for ${c.address.slice(0, 10)}: ${err instanceof Error ? err.message : String(err)}`);
          results.set(c.address, { winRates: {}, positions: [] });
        }
      }),
    );
    return results;
  }
  // --------------------------------------------------------------------------
  // Composite scoring (Poly Syncer / Polycopy methodology)
  // --------------------------------------------------------------------------
  /**
   * Compute the five sub-components of the composite CopyScore from the
   * CLOSED (settled) position series. Each is bounded 0–1.
   *
   * Weights mirror Poly Syncer:
   *   Sharpe 0.45 | Edge-adj win-rate 0.20 | Log-ROI 0.15 | Drawdown 0.10 | Rank stability 0.10
   *
   * Consistency is NOT a separate gate — steadiness is baked in as
   * rankStability (inverse dispersion of per-trade returns).
   */
  private computeScoringComponents(
    profile: WalletProfile,
    positions: ClosedPosition[] = [],
  ): WalletScoringComponents {
    const n = positions.length;
    const now = Date.now();
    const windowStart = now - this.config.winRateWindowDays * 86_400_000;
    const recent = positions.filter((p) => (p.timestamp ?? 0) >= windowStart);
    const source = recent.length > 0 ? recent : positions;
    const sourceForEvidence = source.length > 0 ? source : positions;
    const edges: number[] = [];
    const clusterIds: string[] = [];
    const returns: number[] = [];
    let costBasis = 0;
    let pnl = 0;
    let peak = 0;
    let cumulative = 0;
    let maxDd = 0;
    const marketIds = new Set<string>();
    for (const pos of positions) {
      const cost = Math.max(0, (pos.avgPrice ?? 0) * (pos.totalBought ?? 0));
      const realized = Number.isFinite(pos.realizedPnl) ? pos.realizedPnl : 0;
      if (cost > 0) {
        const edge = realized / cost;
        edges.push(edge);
        clusterIds.push(pos.conditionId || pos.asset || String(edges.length));
        returns.push(edge);
      }
      costBasis += cost;
      pnl += realized;
      marketIds.add(pos.conditionId || pos.asset);
      cumulative += realized;
      if (cumulative > peak) peak = cumulative;
      if (peak > 0) maxDd = Math.max(maxDd, (peak - cumulative) / peak);
    }
    const sourceWins = source.filter((p) => (p.realizedPnl ?? 0) > 0).length;
    const sourceN = source.length;
    const lifetimeWins = positions.filter((p) => (p.realizedPnl ?? 0) > 0).length;
    const lifetimeRate = n > 0 ? lifetimeWins / n : Math.max(0, Math.min(1, profile.winRate));
    const rawRate = sourceN > 0 ? sourceWins / sourceN : lifetimeRate;
    const prior = Math.max(1, this.config.winRatePriorTrades);
    const adjustedWinRate = ((rawRate * sourceN) + prior / 2) / (sourceN + prior);
    const effectiveN = marketIds.size;
    const weightedPrice = positions.reduce((sum, p) => sum + Math.max(0, p.avgPrice ?? 0) * Math.max(0, p.totalBought ?? 0), 0) /
      Math.max(positions.reduce((sum, p) => sum + Math.max(0, p.totalBought ?? 0), 0), 1);
    const meanEdge = edges.length > 0 ? edges.reduce((sum, e) => sum + e, 0) / edges.length : 0;
    const edgeSe = clusteredSE(edges, clusterIds);
    const shrunk = shrunkEdge(meanEdge, edges.length, 30);
    const lcb = lcbEdge(shrunk, edgeSe).lcb;
    const edgeAdjustedWinRate = rawRate - weightedPrice;
        // Edge-adjusted win rate is the copy-trader's skill signal: buying at 0.40
        // and winning 60% is positive edge (0.20), while buying at 0.90 and winning
        // 80% is a slim negative edge. Brier-vs-entry-price is kept as a reported
        // diagnostic but must NOT zero a wallet that systematically beats the
        // market price — that is precisely the edge we copy.
        const calibration = Math.max(0, Math.min(1, edgeAdjustedWinRate / 0.3));
    // A slightly negative LCB with a large sample is statistical neutrality, not
    // evidence of negative edge. Within a ±1% tolerance we fall back to the
    // edge-adjusted win-rate evidence so one marginally-negative LCB cannot
    // zero a genuinely positive-edge wallet.
    const edgeScore = lcb > 0
      ? Math.max(0, Math.min(1, lcb / 0.5))
      : (Math.abs(lcb) <= 0.01 ? calibration : 0);
    const roi = costBasis > 0 ? pnl / costBasis : profile.avgPercentPnL;
    const logReturnScore = Math.max(0, Math.min(1, (Math.log1p(Math.max(-0.95, roi)) + 2) / 2.5));
    // Stability is measured on independent time buckets, not individual fills.
    // A same-day batch has no time-series evidence, so it receives a neutral
    // 0.5 rather than being punished as unstable.
    const weeklyEdges = new Map<string, number[]>();
    for (const pos of positions) {
      if (!Number.isFinite(pos.timestamp) || !Number.isFinite(pos.realizedPnl)) continue;
      const week = Math.floor((pos.timestamp as number) / (7 * 86_400_000));
      const cost = Math.max(0, (pos.avgPrice ?? 0) * (pos.totalBought ?? 0));
      if (cost <= 0) continue;
      const values = weeklyEdges.get(String(week)) ?? [];
      values.push((pos.realizedPnl ?? 0) / cost);
      weeklyEdges.set(String(week), values);
    }
    const weeklyMeans = [...weeklyEdges.values()]
      .map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
    const stability = weeklyMeans.length >= 2 ? stabilityScore(weeklyMeans) : 0.5;
    const ddScore = drawdownScore(maxDd * 100, this.config.maxDrawdownPct);
    const cvar = returns.length > 0 ? Math.abs([...returns].sort((a, b) => a - b)[Math.floor(Math.max(0, returns.length * 0.05))]) * 100 : 0;
    const cvScore = cvarScore(cvar, this.config.maxDrawdownPct);
    const maeScore = ddScore;
    const recoveryScore = maxDd <= 0 ? 1 : Math.max(0, Math.min(1, 1 - maxDd));
    const tail = cvScore;
    const skill = skillComposite(
      Math.max(0, Math.min(1, edgeScore * 0.7 + Math.max(0, Math.min(1, profile.smartScore / 100)) * 0.3)),
      calibration, logReturnScore, stability, tail,
    );
    const daysStale = positions.length > 0
      ? Math.max(0, (now - Math.max(...positions.map((p) => p.timestamp ?? 0))) / 86_400_000)
      : Math.max(0, (now - profile.lastActiveAt.getTime()) / 86_400_000);
    const nIndependent = marketIds.size;
    const sampleConfidence = effectiveSampleConfidence(nIndependent, 30);
    const recency = recencyConfidence(daysStale, 30);
    const dataCompleteness = positions.length === 0 ? 0.5 : positions.reduce((sum, p) =>
      sum + ([p.conditionId, p.avgPrice, p.totalBought, p.realizedPnl, p.timestamp].every((v) => v !== undefined && v !== null) ? 1 : 0), 0) / positions.length / 1;
    const identity = profile.address && /^0x[0-9a-fA-F]{40}$/.test(profile.address) ? 1 : 0.75;
    const reliability = reliabilityScore(sampleConfidence, recency, dataCompleteness, identity);
    // No historical replay fields exist in WalletProfile/ClosedPosition; empty-series fallback is neutral.
    const fillRate = positions.length === 0 ? 1 : 1;
    const slippageBps = 0;
    const latencySurvival = 1;
    const depthSurvival = 1;
    const exec = executionScore(fillRate, slippageBps, 100, latencySurvival, depthSurvival);
    const effectiveLcb = Math.max(0, Math.min(1, lcb / 0.5));
    const spec = specializationScore(effectiveLcb, calibration, exec, 12, Math.max(12, marketIds.size));
    const risk = riskScore(ddScore, cvScore, maeScore, recoveryScore);
    const copy = finalCopyScore(skill, reliability, exec, spec, risk);
    const slippageScore = executionScore(1, slippageBps, 100, 1, 1);
    const result: ScoringComponentsResult = {
      meanEdge, edgeN: edges.length, shrunkEdgeValue: shrunk, edgeSe, edgeLcb: lcb, calibration,
      logReturnScore, stability, tailRiskScore: tail, skillCompositeScore: skill, sampleConfidence,
      recencyConfidence: recency, dataCompleteness, identityIntegrity: identity, reliabilityScoreValue: reliability,
      fillRate, slippageBps, slippageScore, latencySurvival, depthSurvival, executionScoreValue: exec,
      nMarkets: marketIds.size, specializationMinMarkets: 12, specializationScoreValue: spec,
      drawdownScoreValue: ddScore, cvarScoreValue: cvScore, maeScoreValue: maeScore,
      recoveryScoreValue: recoveryScore, riskScoreValue: risk, copyScore: copy,
    };
    return { ...result, sharpeNormalized: Math.max(0, Math.min(1, profile.smartScore / 100)),
      edgeAdjustedWinRate: Math.max(0, Math.min(1, (adjustedWinRate - weightedPrice) / 0.5)),
      logRoiNormalized: logReturnScore, drawdownResilience: ddScore, rankStability: stability,
      sampleSize: n, adjustedWinRate, effectiveSampleSize: effectiveN };
  }
  /** Confidence-aware product; legacy method signature is preserved. */
  computeCopyScore(components: WalletScoringComponents): number {
    return Math.round(finalCopyScore(components.skillCompositeScore, components.reliabilityScoreValue,
      components.executionScoreValue, components.specializationScoreValue, components.riskScoreValue));
  }
  // --------------------------------------------------------------------------
  // Six-dimension scoring (PredictEngine pattern — retained for dashboard display)
  // --------------------------------------------------------------------------
  private computeDimensions(profile: WalletProfile | null): WalletDimensions {
    if (!profile) {
      return {
        profitability: 0,
        timing: 0,
        slippage: 50,
        consistency: 0,
        marketSelection: 50,
        recency: 0,
      };
    }
    const perTrade = profile.realizedPnL / Math.max(profile.tradeCount, 1);
    const profitability = Math.max(0, Math.min(100, 50 + 50 * Math.tanh(perTrade / 50)));
    const timing = Math.max(0, Math.min(100, profile.avgPercentPnL * 100));
    // No fill-quality/slippage field is available in WalletProfile. Keep this
    // dashboard-only dimension neutral; SmartScore is already quantified once
    // as the 45% sharpeNormalized component of CopyScore.
    const slippage = 50;
    const consistency = Math.max(0, Math.min(100, profile.winRate * 100));
    const focus = profile.positionCount / Math.max(profile.tradeCount, 1);
    const marketSelection = Math.max(0, Math.min(100, 100 * (1 - focus)));
    const daysStale = (Date.now() - new Date(profile.lastActiveAt).getTime()) / 86_400_000;
    const recency = Math.max(0, Math.min(100, 100 * Math.pow(0.5, daysStale / 14)));
    return { profitability, timing, slippage, consistency, marketSelection, recency };
  }
  // --------------------------------------------------------------------------
  // Bot detection
  // --------------------------------------------------------------------------
  /**
   * Detect HFT / AMM / spread-capture bots.
   * Polycopy explicitly flags: 90+ orders/day, winRate > 75% at scale,
   * and smartScore >= 95 with tradeCount >= 500 as bot signatures.
   *
   * We approximate orders/day from tradeCount and lastActiveAt:
   *   ordersPerDay = tradeCount / max(1, daysSinceFirstTrade)
   */
  private detectBot(profile: WalletProfile): { isBot: boolean; reason?: string } {
    // Pattern 1: AMM / market-making bot — near-perfect score at scale
    // Polycopy: winRate > 75% AND tradeCount >= 500 AND smartScore >= 95
    const isAmmBot =
      profile.winRate >= 0.75 &&
      profile.tradeCount >= 500 &&
      profile.smartScore >= 95;
    if (isAmmBot) {
      return { isBot: true, reason: 'AMM/spread-capture bot signature (winRate≥75%, vol≥500, smartScore≥95)' };
    }
    // Pattern 2: HFT — orders/day > threshold
    // We don't have per-fill timestamps, so we approximate orders/day as:
    //   tradeCount / max(tradingWindowDays, 30)
    // where tradingWindowDays = days since last active, floored at 30 days.
    // Without first-activity data, a 30-day floor prevents freshly-active wallets
    // with moderate trade counts from being misclassified as HFT.
    // A wallet with 200 trades over 30 days = ~7 orders/day (human pace).
    // A wallet with 200 trades over 2 days (but last active 30d ago) = ~7/day.
    const daysSinceActive = Math.max(1,
      (Date.now() - new Date(profile.lastActiveAt).getTime()) / 86_400_000,
    );
    const tradingWindowDays = Math.max(30, daysSinceActive);
    const ordersPerDay = profile.tradeCount / tradingWindowDays;
    if (ordersPerDay > this.config.maxOrdersPerDay) {
      return { isBot: true, reason: `HFT signature (${ordersPerDay.toFixed(0)} orders/day > ${this.config.maxOrdersPerDay})` };
    }
    // Pattern 3: mechanical churn — very high trade count with steady win rate
    // indicating bot-like regularity rather than human discretion
    const tooFrequent =
      profile.tradeCount >= 2000 &&
      profile.winRate >= 0.70;
    if (tooFrequent) {
      return { isBot: true, reason: 'mechanical churn signature (2000+ trades, winRate≥70%)' };
    }
    return { isBot: false };
  }
  // --------------------------------------------------------------------------
  // Evaluation gate
  // --------------------------------------------------------------------------
  private evaluate(
    c: RawCandidate,
    profile: WalletProfile | null,
    resolved: { category: MarketCategory; source: 'manual' | 'auto' | 'inferred'; confidence: number } | undefined,
    catWinRates: Record<string, { winRate: number; tradeCount: number }>,
    positions: ClosedPosition[] = [],
    gateCounts?: Record<string, number>,
  ): ScreenedWallet {
    if (process.env.DEBUG_SCREENING === 'true') {
      console.log(`[Eval] ${c.address.slice(0,8)} hintCat=${c.hintCategory ?? 'none'} resolved=${resolved?.category} copyScore-pending`);
    }
    // No profile — cannot score
    if (!profile) {
      if (gateCounts) gateCounts['no profile'] = (gateCounts['no profile'] ?? 0) + 1;
      return this.buildResult(c, profile, 'WATCHLIST', 'no profile data', false, undefined, catWinRates);
    }
    // Insufficient history
    if (profile.tradeCount < this.config.minTradeCount) {
      if (gateCounts) gateCounts['insufficient history'] = (gateCounts['insufficient history'] ?? 0) + 1;
      return this.buildResult(
        c, profile, 'WATCHLIST',
        `insufficient history: ${profile.tradeCount} trades (min ${this.config.minTradeCount})`,
        false, resolved, catWinRates,
      );
    }
    // Bot detection
    const botCheck = this.detectBot(profile);
    if (botCheck.isBot) {
      if (gateCounts) gateCounts['HFT signature'] = (gateCounts['HFT signature'] ?? 0) + 1;
      return this.buildResult(c, profile, 'REJECTED', botCheck.reason!, true, resolved, catWinRates);
    }
    // Recency gate — edge decays
    const daysStale = (Date.now() - new Date(profile.lastActiveAt).getTime()) / 86_400_000;
    if (daysStale > this.config.maxInactiveDays) {
      if (gateCounts) gateCounts['inactive >60d'] = (gateCounts['inactive >60d'] ?? 0) + 1;
      return this.buildResult(
        c, profile, 'WATCHLIST',
        `inactive ${daysStale.toFixed(0)}d (> ${this.config.maxInactiveDays}d)`,
        false, resolved, catWinRates,
      );
    }
    // NOTE: profitability is NO LONGER a binary gate here.
    // Poly Syncer/Polycopy embed risk-adjusted profitability as weighted components
    // of the CopyScore (drawdownResilience, Sharpe-normalized), not a hard filter.
    // totalPnL can be negative for wallets with genuine category-specific edge that
    // had unlucky variance — the CopyScore captures this holistically.
    // The binary gate was removed after gate-tally showed it rejected 52/70 wallets.
    // Composite scoring components — computed from the CLOSED position series
    // (real Sharpe, edge-adjusted win-rate, log-ROI, drawdown, steadiness).
    const components = this.computeScoringComponents(profile, positions);
    const copyScore = this.computeCopyScore(components);
    const resolvedCat = resolved?.category ?? 'other';
    const catStat = catWinRates[resolvedCat];
    // DEBUG: log high-copyScore candidates' copyScore vs specializes evaluation
    if (copyScore >= 55) {  // lowered from 75 to catch SPORTS=90
      console.log(`[Score] ${c.address} copyScore=${copyScore} winRate=${profile.winRate} smartScore=${profile.smartScore} cat=${resolvedCat} catStat=${JSON.stringify(catStat)} specializes=${copyScore>=75||(!!catStat&&catStat.tradeCount>=12?catStat.winRate>=0.58:0)}`);
    }
    // Category specialization gate.
    // A wallet routing to a specific basket must prove it actually wins there.
    // CopyScore >= 75 bypasses this gate entirely — elite generalist CopyScore IS the proof.
    // For mid-tier wallets, we require either:
    //   (a) >=12 category trades with winRate >= 58%, OR
    //   (b) concentration >= 30% (or >= minConcentration) if catStat is unavailable.
    // If catStat is undefined AND copyScore < 75, use concentration fallback.
    const concentration = catStat?.tradeCount
      ? catStat.tradeCount / profile.tradeCount
      : 0;
    const minConcentration = copyScore >= 75 ? 0 : 0.30;
    // Category edge: >=3 SETTLED positions in the category with >=58% win rate.
    // Settled positions aggregate fills — 150+ trades may collapse to 10-30
    // distinct markets, so trade-count thresholds must be position-based.
    const hasCatEdge = !!catStat
      && catStat.tradeCount >= this.config.minCategoryTrades
      && catStat.winRate >= this.config.minCategoryWinRate;
    const specializes =
      copyScore >= 75 ||   // elite generalist — CopyScore is the proof (bypasses catStat check)
      hasCatEdge ||        // proven category winner on settled markets
      concentration >= minConcentration && profile.winRate >= this.config.minWinRate;
    if (!specializes) {
      if (gateCounts) gateCounts['not specialized'] = (gateCounts['not specialized'] ?? 0) + 1;
      return this.buildResult(
        c, profile, 'WATCHLIST',
        `not specialized in ${resolvedCat} (catWin=${((catStat?.winRate ?? profile.winRate) * 100).toFixed(0)}% < ${this.config.minCategoryWinRate * 100}%)`,
        false, resolved, catWinRates,
        components,
      );
    }
    // Tier assignment — driven ONLY by CopyScore (consistency is one of its
    // components: rankStability/steadiness). No separate consistency XOR gate.
    if (copyScore >= this.config.primaryCopyScoreThreshold && profile.winRate >= this.config.minWinRate) {
      return this.buildResult(
        c, profile, 'PRIMARY',
        `copyScore ${copyScore}`,
        false, resolved, catWinRates,
        components,
      );
    }
    if (copyScore >= this.config.satelliteCopyScoreThreshold) {
      return this.buildResult(
        c, profile, 'SATELLITE',
        `copyScore ${copyScore}`,
        false, resolved, catWinRates,
        components,
      );
    }
    return this.buildResult(
      c, profile, 'WATCHLIST',
      `copyScore ${copyScore} below threshold`,
      false, resolved, catWinRates,
      components,
    );
  }
  // Result builder
  // --------------------------------------------------------------------------
  private buildResult(
    c: RawCandidate,
    profile: WalletProfile | null,
    tier: WalletTier,
    reason: string,
    isBot: boolean,
    resolved: { category: MarketCategory; source: 'manual' | 'auto' | 'inferred'; confidence: number } | undefined,
    catWinRates: Record<string, { winRate: number; tradeCount: number }> = {},
    components: WalletScoringComponents | null = null,
  ): ScreenedWallet {
    const resolvedCat = resolved?.category ?? 'other';
    const catStat = catWinRates[resolvedCat];
    // Use the pre-computed components/copyScore from evaluate() when available.
    // Recomputing here (without the closed-position series) would cheapen the
    // score to an empty-series approximation. Only fall back when not passed.
    const useComponents = components ?? (profile ? this.computeScoringComponents(profile) : null);
    const copyScore = profile && useComponents
      ? this.computeCopyScore(useComponents)
      : 0;
    const consistency = profile
      ? Math.min(99.5, profile.winRate * 100 * 0.55 + Math.min(profile.smartScore / 25, 3) * 8 + profile.smartScore / 4)
      : 0;
    return {
      address: c.address.toLowerCase(),
      tier,
      source: c.source,
      label: c.label,
      category: resolvedCat,
      categorySource: resolved?.source ?? 'unset',
      categoryConfidence: resolved?.confidence ?? 0,
      dimensions: this.computeDimensions(profile),
      copyScore,
      scoringComponents: useComponents ?? undefined,
      consistency,
      winRate: profile?.winRate ?? 0,
      profitFactor: 0,  // no longer computed (replaced by totalPnL > 0 gate)
      maxDrawdownPct: this.config.maxDrawdownPct,
      smartScore: profile?.smartScore ?? 0,
      tradeCount: profile?.tradeCount ?? 0,
      isBotSuspect: isBot,
      botReason: isBot ? reason : undefined,
      categoryWinRates: catWinRates,
      specializesInResolvedCategory: !!(catStat && catStat.tradeCount >= this.config.minCategoryTrades
        ? catStat.winRate >= this.config.minCategoryWinRate
        : (profile?.winRate ?? 0) >= this.config.minCategoryWinRate),
      bypassed: false,
      reason,
    };
  }
  private makeBypassed(
    c: RawCandidate,
    resolved: { category: MarketCategory; source: 'manual' | 'auto' | 'inferred'; confidence: number } | undefined,
  ): ScreenedWallet {
    return {
      address: c.address.toLowerCase(),
      tier: 'PRIMARY',
      source: c.source,
      label: c.label,
      category: resolved?.category ?? 'other',
      categorySource: resolved?.source ?? 'unset',
      categoryConfidence: resolved?.confidence ?? 1,
      dimensions: { profitability: 50, timing: 50, slippage: 50, consistency: 50, marketSelection: 50, recency: 50 },
      copyScore: 100,
      scoringComponents: {
        meanEdge: 1, edgeN: 100, shrunkEdgeValue: 1, edgeSe: 0, edgeLcb: 1,
        calibration: 1, logReturnScore: 1, stability: 1, tailRiskScore: 1,
        skillCompositeScore: 1, sampleConfidence: 1, recencyConfidence: 1,
        dataCompleteness: 1, identityIntegrity: 1, reliabilityScoreValue: 1,
        fillRate: 1, slippageBps: 0, slippageScore: 1, latencySurvival: 1, depthSurvival: 1,
        executionScoreValue: 1, nMarkets: 100, specializationMinMarkets: 12,
        specializationScoreValue: 1, drawdownScoreValue: 1, cvarScoreValue: 1,
        maeScoreValue: 1, recoveryScoreValue: 1, riskScoreValue: 1, copyScore: 100,
        sharpeNormalized: 1, edgeAdjustedWinRate: 1,
        logRoiNormalized: 1, drawdownResilience: 1, rankStability: 1,
        sampleSize: 100, adjustedWinRate: 1, effectiveSampleSize: 100,
      },
      consistency: 100,
      winRate: 1,
      profitFactor: 0,
      maxDrawdownPct: 0,
      smartScore: 100,
      tradeCount: 999999,
      isBotSuspect: false,
      categoryWinRates: {},
      specializesInResolvedCategory: true,
      bypassed: true,
      reason: 'manual bypass',
    };
  }
  // --------------------------------------------------------------------------
  // Utilities
  // --------------------------------------------------------------------------
  private async runBounded<T>(concurrency: number, items: T[], fn: (item: T) => Promise<void>): Promise<void> {
    const chunks = [];
    for (let i = 0; i < items.length; i += concurrency) {
      chunks.push(items.slice(i, i + concurrency));
    }
    for (const chunk of chunks) {
      await Promise.all(chunk.map(fn));
    }
  }
}
