/**
 * WalletScreeningService
 *
 * Quality gate that runs the SAME screen on every wallet, regardless
 * of whether it came from the MANUAL or AUTO ingestion source.
 *
 * Scoring methodology is adapted from Poly Syncer / Polycopy research:
 *   score = 0.45·sharpe_normalized
 *         + 0.20·edge_adjusted_winrate
 *         + 0.15·log_roi_normalized
 *         + 0.10·drawdown_resilience
 *         + 0.10·rank_stability
 *
 * Each component is bounded 0–1.  Weights are constant across categories
 * (regime-specific weights are easy to overfit and hard to communicate).
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
import { categorizeMarket, type MarketCategory } from './smart-money-service.js';

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
  /** Minimum composite consistency score for SATELLITE tier */
  minConsistency: number;
  /** Minimum composite consistency for PRIMARY tier (higher = stronger conviction) */
  primaryConsistency: number;
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
export interface WalletScoringComponents {
  /**
   * Sharpe-normalized (0–1): risk-adjusted return on log-PnL vs cohort median.
   * We use profile.smartScore / 100 as a proxy (it encodes execution quality
   * and risk-adjusted performance). Denominator = cohort 95th-percentile Sharpe
   * (we approximate as smartScore 95/100 for normalization).
   */
  sharpeNormalized: number;
  /**
   * Edge-adjusted win-rate (0–1): realized win rate minus trade-weighted
   * break-even probability. A wallet buying 5¢ long shots and winning is
   * not comparable to one buying 90¢ favorites and winning.
   *
   * Approximated from: winRate − (1 − winRate) = 2·winRate − 1
   * which equals zero at 50% and 1.0 at 100%.
   */
  edgeAdjustedWinRate: number;
  /**
   * Log-ROI normalized (0–1): realized return clipped at 99th percentile.
   * We use avgPercentPnL (0–1) as proxy, log-scaled to compress outliers.
   */
  logRoiNormalized: number;
  /**
   * Drawdown resilience (0–1): 1 − (maxDrawdown / cohortP95Drawdown).
   * Approximated as 1 − (drawdownPct / maxDrawdownPct threshold).
   */
  drawdownResilience: number;
  /**
   * Rank stability (0–1): Spearman correlation between daily rank and
   * 7-day moving rank. Approximated from consistency score (lower
   * consistency volatility = higher stability).
   */
  rankStability: number;
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

    // Fetch per-category win rates in parallel
    const catWinRates = await this.fetchCategoryWinRates(
      toScore.filter((c) => profiles.has(c.address)),
    );

    const screened: ScreenedWallet[] = [];
    const gateCounts: Record<string, number> = {};
    for (const c of toScore) {
      const profile = profiles.get(c.address) ?? null;
      const resolved = resolvedCategories.get(c.address);
      const walletsCatWinRates = catWinRates.get(c.address) ?? {};
      screened.push(c.bypassScreening
        ? this.makeBypassed(c, resolved)
        : this.evaluate(c, profile, resolved, walletsCatWinRates, gateCounts));
    }
    // Log gate tally for this cycle (diagnostic).
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

  private async fetchCategoryWinRates(
    candidates: RawCandidate[],
  ): Promise<Map<string, Record<string, { winRate: number; tradeCount: number }>>> {
    const results = new Map<string, Record<string, { winRate: number; tradeCount: number }>>();

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
          results.set(c.address, winRates);
        } catch (err) {
          // LOG the failure — a silent {} here starves the specialization gate
          // and makes catStat undefined for the wallet downstream.
          console.warn(`[WalletScreening] category win rates failed for ${c.address.slice(0, 10)}: ${err instanceof Error ? err.message : String(err)}`);
          results.set(c.address, {});
        }
      }),
    );

    return results;
  }

  // --------------------------------------------------------------------------
  // Composite scoring (Poly Syncer / Polycopy methodology)
  // --------------------------------------------------------------------------

  /**
   * Compute the five sub-components of the composite CopyScore.
   * Each is bounded 0–1.  Weights mirror Poly Syncer:
   *   Sharpe 0.45 | Edge-adj win-rate 0.20 | Log-ROI 0.15 | Drawdown 0.10 | Rank stability 0.10
   */
  private computeScoringComponents(profile: WalletProfile): WalletScoringComponents {
    const { winRate, smartScore, avgPercentPnL, tradeCount } = profile;

    // 1. Sharpe-normalized (0.45 weight)
    // Numerator: risk-adjusted return proxy = smartScore / 100 (already risk-adjusted).
    // Denominator: cohort 95th-percentile ≈ smartScore 95/100.
    // Capped at 1.0 so wallets exceeding cohort ceiling don't inflate the score.
    const sharpeNormalized = Math.min(1, smartScore / 95);

    // 2. Edge-adjusted win-rate (0.20 weight)
    // Break-even probability at even odds = 0.50.  Edge = realized winRate − breakEven.
    // At 60% win rate: edge = 0.60 − 0.50 = 0.10 (10 percentage points of edge).
    // Normalized: edge / 0.50 (so 10pp edge → 0.20, 20pp edge → 0.40, etc.).
    // Clamp to [0, 1] — a wallet below 50% has negative edge and scores 0.
    const breakEven = 0.5;
    const rawEdge = winRate - breakEven;
    const edgeAdjustedWinRate = Math.max(0, Math.min(1, rawEdge / breakEven));

    // 3. Log-ROI normalized (0.15 weight)
    // Log-ROI compresses the fat tail of arithmetic ROI.  We use avgPercentPnL
    // (0–1) as proxy and apply log1p to compress extreme values.
    // Then min-max normalize assuming avgPercentPnL ∈ [−0.1, 0.5] maps to [0, 1].
    const rawRoi = Math.log1p(Math.max(-0.95, avgPercentPnL)); // log1p handles near-zero/negative
    const roiNormalized = Math.max(0, Math.min(1, (rawRoi + 2) / 2.5)); // rough min-max

    // 4. Drawdown resilience (0.10 weight)
    // Resilience = 1 − (maxDrawdown / cohortP95Drawdown).
    // We approximate cohortP95Drawdown ≈ maxDrawdownPct config threshold.
    // A wallet at or above the threshold → 0. A wallet with 0 drawdown → 1.
    const maxDd = this.config.maxDrawdownPct;
    const drawdownResilience = Math.max(0, Math.min(1, 1 - (maxDd / maxDd)));

    // 5. Rank stability (0.10 weight)
    // Spearman correlation proxy: derive from winRate stability.
    // A wallet whose winRate hovers near its mean is stable (high consistency →
    // low variance → high rank stability).  Approximate as consistency / 100.
    // Small-sample shrinkage: wallets < 100 trades get scores pulled 50% toward 0.5.
    const baseStability = smartScore / 100;
    const shrinkageFactor = tradeCount < 100 ? 0.5 : 1.0;
    const rankStability = shrinkageFactor * baseStability + (1 - shrinkageFactor) * 0.5;

    return {
      sharpeNormalized,
      edgeAdjustedWinRate,
      logRoiNormalized: roiNormalized,
      drawdownResilience,
      rankStability,
    };
  }

  /**
   * Composite CopyScore (0–100) using fixed-weight linear combination.
   * Mirrors Poly Syncer: Sharpe 0.45 | Edge-wr 0.20 | Log-ROI 0.15 | Drawdown 0.10 | Rank 0.10
   */
  computeCopyScore(components: WalletScoringComponents): number {
    const raw =
      0.45 * components.sharpeNormalized +
      0.20 * components.edgeAdjustedWinRate +
      0.15 * components.logRoiNormalized +
      0.10 * components.drawdownResilience +
      0.10 * components.rankStability;
    return Math.round(Math.max(0, Math.min(100, raw * 100)));
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
    const slippage = Math.max(0, Math.min(100, profile.smartScore));
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
    gateCounts?: Record<string, number>,
  ): ScreenedWallet {
    // DEBUG: log address when entering evaluate()
    console.log(`[Eval] ${c.address.slice(0,8)} hintCat=${c.hintCategory ?? 'none'} resolved=${resolved?.category} copyScore-pending`);
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

    // Composite scoring components
    const components = this.computeScoringComponents(profile);
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
      );
    }

    // Drawdown check
    const maxDrawdownPct = this.config.maxDrawdownPct; // profile doesn't expose this directly

    // Composite consistency (Polymeteo formula — adapted to WalletProfile shape).
    // Uses smartScore as a risk-adjusted performance proxy for drawdown/resilience.
    const consistency = Math.min(
      99.5,
      profile.winRate * 100 * 0.55 +
        Math.min(profile.smartScore / 25, 3) * 8 +  // smartScore/25 maps 0-100 to 0-4
        (profile.smartScore / 4),
    );

    // Tier assignment — driven by CopyScore AND consistency
    if (copyScore >= this.config.primaryCopyScoreThreshold && consistency >= this.config.primaryConsistency && profile.winRate >= this.config.minWinRate) {
      return this.buildResult(
        c, profile, 'PRIMARY',
        `copyScore ${copyScore} consistency ${consistency.toFixed(1)}`,
        false, resolved, catWinRates,
      );
    }
    if (copyScore >= this.config.satelliteCopyScoreThreshold && consistency >= this.config.minConsistency) {
      return this.buildResult(
        c, profile, 'SATELLITE',
        `copyScore ${copyScore} consistency ${consistency.toFixed(1)}`,
        false, resolved, catWinRates,
      );
    }

    return this.buildResult(
      c, profile, 'WATCHLIST',
      `copyScore ${copyScore} below threshold`,
      false, resolved, catWinRates,
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
  ): ScreenedWallet {
    const resolvedCat = resolved?.category ?? 'other';
    const catStat = catWinRates[resolvedCat];
    const components = profile ? this.computeScoringComponents(profile) : null;
    const copyScore = profile && components
      ? this.computeCopyScore(components)
      : 0;
    const consistency = profile
      ? Math.min(99.5, profile.winRate * 100 * 0.55 + Math.min(profile.smartScore / 25, 3) * 8 + profile.smartScore / 4)
      : 0;

    return {
      address: c.address,
      tier,
      source: c.source,
      label: c.label,
      category: resolvedCat,
      categorySource: resolved?.source ?? 'unset',
      categoryConfidence: resolved?.confidence ?? 0,
      dimensions: this.computeDimensions(profile),
      copyScore,
      scoringComponents: components ?? undefined,
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
      address: c.address,
      tier: 'PRIMARY',
      source: c.source,
      label: c.label,
      category: resolved?.category ?? 'other',
      categorySource: resolved?.source ?? 'unset',
      categoryConfidence: resolved?.confidence ?? 1,
      dimensions: { profitability: 50, timing: 50, slippage: 50, consistency: 50, marketSelection: 50, recency: 50 },
      copyScore: 100,
      scoringComponents: {
        sharpeNormalized: 1, edgeAdjustedWinRate: 1,
        logRoiNormalized: 1, drawdownResilience: 1, rankStability: 1,
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
