/**
 * WalletScreeningService
 *
 * Quality gate that runs the SAME screen on every wallet, regardless
 * of whether it came from the MANUAL or AUTO ingestion source.
 *
 *   score()  -> produces a ScreenedWallet with quality tier:
 *     - PRIMARY    (consistency >= 85, win rate >= 60%, passes bot filter)
 *     - SATELLITE  (consistency >= 70, decent edge, may include some bots)
 *     - WATCHLIST  (anything else; tracked but NOT used by baskets)
 *     - REJECTED   (bot signature, or insufficient trade history)
 *
 *   Manual wallets with bypassScreening=true are force-marked PRIMARY
 *   even if their stats would otherwise fail. This lets the operator
 *   trust their own judgment ("I've watched this trader for 6 months")
 *   without disabling the gate for everyone.
 *
 *   The screen is intentionally similar to Polymeteo's WalletAnalyzer
 *   (consistency = win_rate*0.55 + min(PF, 3)*8 + latency_bonus + drawdown_bonus)
 *   but adapted to the TypeScript WalletProfile shape Polyland already has.
 *
 *   ==== Wiring ====
 *     const screening = new WalletScreeningService(walletService, {
 *       minTradeCount: 30,
 *       minWinRate: 0.55,
 *       minConsistency: 70,
 *       maxDrawdownPct: 35,
 *       botMedianIntervalMs: 5_000, // sub-5s = bot signature
 *     });
 *     const screened = await screening.score(rawCandidates);
 *     basket.seed(screened);
 */

import type { WalletService, WalletProfile } from './wallet-service.js';
import type { RawCandidate } from './wallet-ingestion-service.js';
import { categorizeMarket, type MarketCategory } from './smart-money-service.js';
import type { ActivityCache } from './activity-cache.js';

// ============================================================================
// Config
// ============================================================================

export interface WalletScreeningConfig {
  /** Minimum number of historical trades required to score a wallet */
  minTradeCount: number;
  /** Minimum win rate (0-1) for PRIMARY tier */
  minWinRate: number;
  /** Minimum composite consistency score for SATELLITE tier (PRIMARY = +15) */
  minConsistency: number;
  /** Minimum composite consistency for PRIMARY tier (higher = stronger conviction) */
  primaryConsistency: number;
  /** Max drawdown % allowed (Polymeteo screens at 10% for the +5 bonus; this is a hard cap) */
  maxDrawdownPct: number;
  /** Wallets with median inter-fill interval below this are flagged as bots (ms) */
  botMedianIntervalMs: number;
  /** Concurrency for profile fetches — keep modest to avoid 429s */
  profileFetchConcurrency: number;
  /**
   * A wallet only joins a basket for categories where its CATEGORY-SPECIFIC
   * win rate beats this baseline. Stops a strong-crypto wallet from polluting
   * the politics basket. 0.55 = must beat coin-flip-with-vig.
   */
  minCategoryWinRate: number;
  /**
   * Minimum number of category-specific trades before we trust a per-category
   * win rate. Below this, the wallet has no demonstrated edge in that category
   * and is held to WATCHLIST rather than seeded into the basket.
   */
  minCategoryTrades: number;
}

export const DEFAULT_SCREENING_CONFIG: WalletScreeningConfig = {
  minTradeCount: 80,
  minWinRate: 0.60,
  minConsistency: 82,
  primaryConsistency: 90,
  maxDrawdownPct: 35,
  botMedianIntervalMs: 5_000,
  profileFetchConcurrency: 4,
  minCategoryWinRate: 0.55,
  /** Min category-specific trades before we trust a per-category win rate. */
  minCategoryTrades: 8,
};

// ============================================================================
// Screened wallet
// ============================================================================

export type WalletTier = 'PRIMARY' | 'SATELLITE' | 'WATCHLIST' | 'REJECTED';

/**
 * Six-dimension wallet quality score (PredictEngine pattern).
 * Each dimension is normalized 0-100.
 */
export interface WalletDimensions {
  /** Realized P&L strength relative to trade count */
  profitability: number;
  /** Entry-price skill proxy (avg % PnL per position) */
  timing: number;
  /** Execution-quality proxy (fills that don't chase; from smartScore) */
  slippage: number;
  /** Win-rate stability across history */
  consistency: number;
  /** Market-category focus vs. spray-and-pray */
  marketSelection: number;
  /** How recently the wallet has been active (edge decays) */
  recency: number;
}

export interface ScreenedWallet {
  address: string;
  tier: WalletTier;
  source: 'manual' | 'auto' | 'both';
  label?: string;

  // Resolved category — used by BasketQuorumService.seed() to route wallets.
  // Resolution: manual.hintCategory → auto.leaderboardCategory → activity inference.
  category: MarketCategory;
  /** Where the resolved category came from. */
  categorySource: 'manual' | 'auto' | 'inferred' | 'unset';
  /** Confidence (0-1) for inferred categories — 1 for manual/auto hints */
  categoryConfidence: number;

  // Six-dimension scores (0-100 each)
  dimensions: WalletDimensions;

  // Computed quality metrics
  consistency: number; // 0-100 composite
  winRate: number;     // 0-1
  profitFactor: number;
  maxDrawdownPct: number;
  smartScore: number;  // 0-100 from WalletProfile
  tradeCount: number;

  // Bot detection
  isBotSuspect: boolean;
  botReason?: string;

  // Category specialization: per-category win rate from the wallet's own trades.
  // A wallet is only trusted in baskets where its category-specific win rate
  // beats minCategoryWinRate. Keyed by MarketCategory.
  categoryWinRates: Record<string, { winRate: number; tradeCount: number }>;
  /** True if the wallet's resolved category beats the specialization baseline. */
  specializesInResolvedCategory: boolean;
  // Operator override
  bypassed: boolean;

  // Reason tag (for the dashboard / logs)
  reason: string;
}

// ============================================================================
// Service
// ============================================================================

export class WalletScreeningService {
  private walletService: WalletService;
  private config: WalletScreeningConfig;
  /** Optional activity cache — avoids re-fetching recent activity every cycle. */
  private activityCache: ActivityCache | null = null;

  constructor(walletService: WalletService, config: Partial<WalletScreeningConfig> = {}) {
    this.walletService = walletService;
    this.config = { ...DEFAULT_SCREENING_CONFIG, ...config };
  }

  /**
   * Wire an activity cache so the inference path doesn't re-fetch every cycle.
   * Pass `null` to disable caching.
   */
  setActivityCache(cache: ActivityCache): void {
    this.activityCache = cache;
  }

  /**
   * Run screening on every candidate. Returns a list of ScreenedWallet.
   * Manual bypasses are honored. Auto + manual converge on the same screen.
   *
   * Each wallet gets a resolved `category`:
   *   1. manual.hintCategory  (operator)
   *   2. auto.leaderboardCategory  (from leaderboard)
   *   3. inferred from activity  (most-common categorizeMarket() over recent fills)
   *   4. 'other'  (last-resort fallback)
   *
   * Set `candidate.lockCategory === true` to force the operator's hint
   * to win even if step 3 would override.
   */
  async score(candidates: RawCandidate[]): Promise<ScreenedWallet[]> {
    // Every candidate goes through the same pipeline — manual bypass just
    // means "skip the quality screen" but it does NOT skip category
    // resolution. We need to know which basket a manual wallet belongs in.
    const toScore = candidates;

    // Step 2 + 3 in parallel: fetch profiles AND resolve categories
    // simultaneously. Each worker pool is bounded, but they don't
    // block each other — total wall-clock is max(profile, activity)
    // instead of profile + activity.
    const profiles = new Map<string, WalletProfile | null>();
    const profileQueue = [...toScore];
    const profileWorkers: Promise<void>[] = [];
    for (let i = 0; i < this.config.profileFetchConcurrency; i++) {
      profileWorkers.push(
        (async () => {
          while (profileQueue.length > 0) {
            const c = profileQueue.shift();
            if (!c) return;
            try {
              const profile = await this.walletService.getWalletProfile(c.address);
              profiles.set(c.address, profile);
            } catch (err) {
              console.warn(
                `[WalletScreening] profile fetch failed for ${c.address}:`,
                err instanceof Error ? err.message : err
              );
              profiles.set(c.address, null);
            }
          }
        })()
      );
    }

    // Step 2b: fetch positions for per-category win-rate specialization.
    // Each position has conditionId + cashPnl; we bucket by category and
    // measure the wallet's win rate INSIDE each category. A crypto whale
    // with 70% crypto win rate but 45% politics win rate must not pollute
    // the politics basket.
    const categoryWinRates = new Map<string, Record<string, { winRate: number; tradeCount: number }>>();
    const posQueue = [...toScore];
    const posWorkers: Promise<void>[] = [];
    for (let i = 0; i < this.config.profileFetchConcurrency; i++) {
      posWorkers.push(
        (async () => {
          while (posQueue.length > 0) {
            const c = posQueue.shift();
            if (!c) return;
            try {
              const positions = await this.walletService.getWalletPositions(c.address);
              categoryWinRates.set(c.address, this.winRatesByCategory(positions));
            } catch {
              categoryWinRates.set(c.address, {});
            }
          }
        })()
      );
    }

    // Categories can resolve from manual/auto hints immediately, only the
    // inference path needs activity fetches. We start category work in
    // parallel with the profile pool above.
    const resolvedCategoriesPromise = this.resolveCategories(toScore);

    // Wait for all pools to drain.
    await Promise.all([...profileWorkers, ...posWorkers, resolvedCategoriesPromise]);
    const resolvedCategories = await resolvedCategoriesPromise;

    // Step 4: score each candidate with its resolved category.
    // Bypass wallets short-circuit the quality screen but still get category
    // resolution so they land in the right basket.
    const screened: ScreenedWallet[] = [];
    for (const c of toScore) {
      const profile = profiles.get(c.address) ?? null;
      const resolved = resolvedCategories.get(c.address);
      const catWinRates = categoryWinRates.get(c.address) ?? {};
      if (c.bypassScreening) {
        screened.push(this.makeBypassed(c, resolved));
      } else {
        screened.push(this.evaluate(c, profile, resolved, catWinRates));
      }
    }
    return screened;
  }

  /**
   * Resolve the category for each candidate. Returns a map
   * address -> { category, source, confidence }.
   */
  private async resolveCategories(
    candidates: RawCandidate[],
  ): Promise<
    Map<
      string,
      {
        category: MarketCategory;
        source: 'manual' | 'auto' | 'inferred';
        confidence: number;
      }
    >
  > {
    const out = new Map<
      string,
      { category: MarketCategory; source: 'manual' | 'auto' | 'inferred'; confidence: number }
    >();

    // Map leaderboard categories to MarketCategory.
    const ledgerToCategory: Record<string, MarketCategory> = {
      POLITICS: 'politics',
      SPORTS: 'sports',
      CRYPTO: 'crypto',
      ECONOMICS: 'economics',
      FINANCE: 'economics',
      TECH: 'science',
      SCIENCE: 'science',
      CULTURE: 'entertainment',
      WEATHER: 'other',
      MENTIONS: 'other',
      OVERALL: 'other',
    };

    // First pass: manual hints + auto leaderboard (no network).
    const needsInference: RawCandidate[] = [];
    for (const c of candidates) {
      // 1. Manual hint (always wins if lockCategory or no override possible)
      if (c.hintCategory && c.lockCategory) {
        out.set(c.address, {
          category: this.coerceMarketCategory(c.hintCategory),
          source: 'manual',
          confidence: 1.0,
        });
        continue;
      }
      // 2. Auto leaderboard category
      if (c.leaderboardCategory) {
        const cat = ledgerToCategory[c.leaderboardCategory] ?? 'other';
        out.set(c.address, { category: cat, source: 'auto', confidence: 0.9 });
        // Still allow inference if manual hint disagrees — but only if not locked.
        if (!c.hintCategory) continue;
      }
      // 3. Manual hint (non-locked)
      if (c.hintCategory) {
        out.set(c.address, {
          category: this.coerceMarketCategory(c.hintCategory),
          source: 'manual',
          confidence: 0.95,
        });
        continue;
      }
      // 4. Need to infer from activity
      needsInference.push(c);
    }

    // Second pass: fetch recent activity and classify by market slugs.
    // Bounded concurrency, same worker-pool pattern as profile fetches.
    const queue = [...needsInference];
    const workers: Promise<void>[] = [];
    for (let i = 0; i < this.config.profileFetchConcurrency; i++) {
      workers.push(
        (async () => {
          while (queue.length > 0) {
            const c = queue.shift();
            if (!c) return;
            try {
              // Cache check — avoid re-fetching recent activity every cycle.
              let activities: ReadonlyArray<{ title?: string; slug?: string; marketSlug?: string }>;
              const cached = this.activityCache?.get<{ activities: typeof activities }>(c.address);
              if (cached) {
                activities = cached.activities;
              } else {
                const activity = await this.walletService.getWalletActivity(
                  c.address,
                  50, // last 50 trades is enough to bucket
                );
                activities = activity.activities as typeof activities;
                this.activityCache?.set(c.address, { activities: [...activities] });
              }
              const inferred = this.inferCategoryFromActivity(activities);
              out.set(c.address, inferred);
            } catch (err) {
              console.warn(
                `[WalletScreening] activity fetch failed for ${c.address}:`,
                err instanceof Error ? err.message : err,
              );
              out.set(c.address, {
                category: 'other',
                source: 'inferred',
                confidence: 0,
              });
            }
          }
        })()
      );
    }
    await Promise.all(workers);
    return out;
  }

  /**
   * Look at the market slugs in a wallet's recent trades and pick the
   * most-common MarketCategory. Confidence scales with how concentrated
   * the trades are in a single bucket (a 100%-crypto wallet gets 1.0;
   * a 50/50 politics/crypto split gets 0.5).
   */
  private inferCategoryFromActivity(
    activities: ReadonlyArray<{ title?: string; slug?: string; marketSlug?: string }>,
  ): { category: MarketCategory; source: 'inferred'; confidence: number } {
    const counts = new Map<MarketCategory, number>();
    let total = 0;
    for (const a of activities) {
      const haystack = [a.title ?? '', a.slug ?? '', a.marketSlug ?? '']
        .filter(Boolean)
        .join(' ');
      if (!haystack.trim()) continue;
      const cat = categorizeMarket(haystack);
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
      total++;
    }
    if (total === 0) {
      return { category: 'other', source: 'inferred', confidence: 0 };
    }
    let top: MarketCategory = 'other';
    let topCount = 0;
    for (const [cat, count] of counts) {
      if (count > topCount) {
        top = cat;
        topCount = count;
      }
    }
    return { category: top, source: 'inferred', confidence: topCount / total };
  }

  private coerceMarketCategory(hint: string): MarketCategory {
    const h = hint.toLowerCase();
    const allowed: MarketCategory[] = [
      'crypto',
      'politics',
      'sports',
      'esports',
      'economics',
      'science',
      'entertainment',
      'other',
    ];
    return (allowed.includes(h as MarketCategory) ? (h as MarketCategory) : 'other');
  }

  /**
   * Filter screened wallets to PRIMARY only.
   * Convenience for callers that want a one-line basket seeding.
   */
  primaries(screened: ScreenedWallet[]): ScreenedWallet[] {
    return screened.filter((w) => w.tier === 'PRIMARY');
  }

  /**
   * Filter screened wallets to PRIMARY + SATELLITE.
   * Use this when you want basket depth even at the cost of quality.
   */
  primariesAndSatellites(screened: ScreenedWallet[]): ScreenedWallet[] {
    return screened.filter((w) => w.tier === 'PRIMARY' || w.tier === 'SATELLITE');
  }

  // ---- internals --------------------------------------------------------

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
      categoryConfidence: resolved?.confidence ?? 0,
      dimensions: {
        profitability: 100,
        timing: 100,
        slippage: 100,
        consistency: 100,
        marketSelection: 100,
        recency: 100,
      },
      consistency: 100,
      winRate: 1,
      profitFactor: 999,
      maxDrawdownPct: 0,
      smartScore: 100,
      tradeCount: 0,
      isBotSuspect: false,
      categoryWinRates: {},
      specializesInResolvedCategory: true, // operator trusts this wallet
      bypassed: true,
      reason: 'manual bypass',
    };
  }

  /**
   * Compute per-category win rates from a wallet's positions.
   * Buckets by category (via market title/slug) and measures win rate
   * (cashPnl > 0) within each. Returns a map keyed by MarketCategory.
   */
  private winRatesByCategory(
    positions: ReadonlyArray<{ title?: string; slug?: string; cashPnl?: number; percentPnl?: number }>,
  ): Record<string, { winRate: number; tradeCount: number }> {
    const buckets = new Map<string, { wins: number; total: number }>();
    for (const p of positions) {
      const haystack = [p.title ?? '', p.slug ?? ''].filter(Boolean).join(' ');
      if (!haystack.trim()) continue;
      const cat = categorizeMarket(haystack);
      const bucket = buckets.get(cat) ?? { wins: 0, total: 0 };
      bucket.total++;
      if ((p.cashPnl ?? p.percentPnl ?? 0) > 0) bucket.wins++;
      buckets.set(cat, bucket);
    }
    const out: Record<string, { winRate: number; tradeCount: number }> = {};
    for (const [cat, b] of buckets) {
      out[cat] = { winRate: b.total > 0 ? b.wins / b.total : 0, tradeCount: b.total };
    }
    return out;
  }

  private evaluate(
    c: RawCandidate,
    profile: WalletProfile | null,
    resolved: { category: MarketCategory; source: 'manual' | 'auto' | 'inferred'; confidence: number } | undefined,
    catWinRates: Record<string, { winRate: number; tradeCount: number }> = {},
  ): ScreenedWallet {
    // No profile → too little history to trust → WATCHLIST.
    if (!profile) {
      return this.buildResult(c, profile, 'WATCHLIST', 'no profile data', false, resolved, catWinRates);
    }
    if (profile.tradeCount < this.config.minTradeCount) {
      return this.buildResult(
        c,
        profile,
        'WATCHLIST',
        `insufficient history (${profile.tradeCount} < ${this.config.minTradeCount})`,
        false,
        resolved,
        catWinRates,
      );
    }

    // Bot detection — limited data here without fills, so use leaderboard
    // category hint + smartScore heuristic. (A full fill-based bot detector
    // would call fetchAllFillsInPeriod and measure inter-fill medians.)
    const isBotSuspect = this.detectBot(profile);

    // Composite consistency (Polymeteo formula, adapted to TS profile shape).
    // Without realised P&L breakdown here, profit factor collapses to
    // winRate proxy. Good enough for a screen, not for sizing.
    const pf = profile.winRate > 0 ? profile.winRate / Math.max(1 - profile.winRate, 1e-9) : 0;
    const consistency = Math.min(
      99.5,
      profile.winRate * 100 * 0.55 +
        Math.min(pf, 3) * 8 +
        (profile.smartScore / 4) +
        (this.config.maxDrawdownPct > 25 ? 5 : 0)
    );

    const maxDrawdownPct = this.config.maxDrawdownPct; // profile doesn't expose this directly

    // Category specialization gate: a wallet is only trusted for the basket
    // matching its resolved category if its CATEGORY-SPECIFIC win rate there
    // beats the baseline. If it has >= minCategoryTrades in that category, it
    // MUST clear the bar; otherwise (no demonstrated category edge) it is held
    // to WATCHLIST — we do NOT fall back to the global win rate, because a
    // global edge tells us nothing about the category the quorum would route it to.
    const resolvedCat = resolved?.category ?? 'other';
    const catStat = catWinRates[resolvedCat];
    const specializes =
      catStat && catStat.tradeCount >= this.config.minCategoryTrades
        ? catStat.winRate >= this.config.minCategoryWinRate
        : false; // insufficient category-specific history → not specialized

    if (isBotSuspect) {
      return this.buildResult(c, profile, 'REJECTED', 'bot signature detected', true, resolved, catWinRates);
    }
    if (maxDrawdownPct > this.config.maxDrawdownPct) {
      return this.buildResult(
        c,
        profile,
        'REJECTED',
        `drawdown ${maxDrawdownPct.toFixed(1)}% > ${this.config.maxDrawdownPct}%`,
        false,
        resolved,
        catWinRates,
      );
    }
    // Require specialization in the resolved category before joining any basket.
    if (!specializes) {
      return this.buildResult(
        c,
        profile,
        'WATCHLIST',
        `not specialized in ${resolvedCat} (catWin=${(catStat?.winRate ?? profile.winRate * 100).toFixed(0)}% < ${this.config.minCategoryWinRate * 100}%)`,
        false,
        resolved,
        catWinRates,
      );
    }
    if (consistency >= this.config.primaryConsistency && profile.winRate >= this.config.minWinRate) {
      return this.buildResult(c, profile, 'PRIMARY', `consistency ${consistency.toFixed(1)}`, false, resolved, catWinRates);
    }
    if (consistency >= this.config.minConsistency) {
      return this.buildResult(c, profile, 'SATELLITE', `consistency ${consistency.toFixed(1)}`, false, resolved, catWinRates);
    }
    return this.buildResult(
      c,
      profile,
      'WATCHLIST',
      `consistency ${consistency.toFixed(1)} below ${this.config.minConsistency}`,
      false,
      resolved,
      catWinRates,
    );
  }

  /**
   * Six-dimension scoring (PredictEngine pattern). All inputs come from
   * WalletProfile; dimensions we can't measure yet are neutral (50).
   *
   *  - profitability: realized PnL per trade, log-scaled
   *  - timing:        avgPercentPnL (entry/exit skill proxy)
   *  - slippage:      smartScore already encodes execution quality; invert
   *  - consistency:   win rate mapped to 0-100
   *  - marketSelection: position-count vs. trade-count ratio (a focused
   *                     trader holds fewer concurrent positions)
   *  - recency:       days since last activity, decayed
   */
  private computeDimensions(
    profile: WalletProfile | null,
  ): WalletDimensions {
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
    // Profitability: log-scale realizedPnL per trade, clamp 0-100.
    const perTrade = profile.realizedPnL / Math.max(profile.tradeCount, 1);
    const profitability = Math.max(
      0,
      Math.min(100, 50 + 50 * Math.tanh(perTrade / 50)),
    );

    // Timing: avgPercentPnL (0-1 expected) mapped to 0-100.
    const timing = Math.max(0, Math.min(100, profile.avgPercentPnL * 100));

    // Slippage/execution: smartScore is a 0-100 composite that already
    // weights execution quality.
    const slippage = Math.max(0, Math.min(100, profile.smartScore));

    // Consistency: win rate to 0-100.
    const consistency = Math.max(0, Math.min(100, profile.winRate * 100));

    // Market selection: focus ratio. A wallet with 500 trades but only
    // 3 positions is focused; 500 trades across 400 positions is spraying.
    const focus = profile.positionCount / Math.max(profile.tradeCount, 1);
    const marketSelection = Math.max(0, Math.min(100, 100 * (1 - focus)));

    // Recency: days since last activity, decay factor 14 days half-life.
    const daysStale = (Date.now() - new Date(profile.lastActiveAt).getTime()) / 86_400_000;
    const recency = Math.max(0, Math.min(100, 100 * Math.pow(0.5, daysStale / 14)));

    return { profitability, timing, slippage, consistency, marketSelection, recency };
  }

  /**
   * Bot signature heuristic.
   * Real signal: high smartScore is GOOD; very high smartScore (95+) AND
   * very high tradeCount (1000+) AND high winRate (75%+) is suspicious —
   * that's almost certainly a market-making or arbitrage bot.
   * The Polymarket CopyCat article flagged this pattern explicitly:
   * crypto bonding bots >80c with 95%+ win rates are bots whose edge
   * decays as soon as it gets copied.
   */
  private detectBot(profile: WalletProfile): boolean {
    const tooPerfect =
      profile.smartScore >= 95 &&
      profile.winRate >= 0.75 &&
      profile.tradeCount >= 500;
    return tooPerfect;
  }

  private buildResult(
    c: RawCandidate,
    profile: WalletProfile | null,
    tier: WalletTier,
    reason: string,
    isBotSuspect: boolean,
    resolved: { category: MarketCategory; source: 'manual' | 'auto' | 'inferred'; confidence: number } | undefined,
    catWinRates: Record<string, { winRate: number; tradeCount: number }> = {},
  ): ScreenedWallet {
    const resolvedCat = resolved?.category ?? 'other';
    const catStat = catWinRates[resolvedCat];
    const specializes =
      catStat && catStat.tradeCount >= 10
        ? catStat.winRate >= this.config.minCategoryWinRate
        : (profile?.winRate ?? 0) >= this.config.minCategoryWinRate;
    return {
      address: c.address,
      tier,
      source: c.source,
      label: c.label,
      category: resolvedCat,
      categorySource: resolved?.source ?? 'unset',
      categoryConfidence: resolved?.confidence ?? 0,
      dimensions: this.computeDimensions(profile),
      consistency: profile
        ? Math.min(
            99.5,
            profile.winRate * 100 * 0.55 +
              Math.min(profile.winRate / Math.max(1 - profile.winRate, 1e-9), 3) * 8 +
              profile.smartScore / 4
          )
        : 0,
      winRate: profile?.winRate ?? 0,
      profitFactor: profile ? profile.winRate / Math.max(1 - profile.winRate, 1e-9) : 0,
      maxDrawdownPct: 0,
      smartScore: profile?.smartScore ?? 0,
      tradeCount: profile?.tradeCount ?? 0,
      isBotSuspect,
      categoryWinRates: catWinRates,
      specializesInResolvedCategory: specializes,
      bypassed: false,
      reason,
    };
  }
}
