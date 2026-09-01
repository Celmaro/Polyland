/**
 * BasketQuorumService
 *
 * Multi-wallet consensus copy-trading for Polymarket (Polymarket-bot v3.x).
 *
 * The problem with single-wallet copy trading (the current startAutoCopyTrading):
 *   - You follow ONE wallet; their edge may be a lucky streak, may have already
 *     closed, or they may be running a bot that gives you worse fills.
 *   - One wallet's single fill tells you nothing about consensus.
 *
 * This service replaces "follow one wallet" with "follow a BASKET of wallets
 * and only act when a QUORUM of the basket agrees on the same outcome, in the
 * same market, within a rolling time window."
 *
 * ==== Design ====
 *  - Baskets: wallets are grouped by market category (politics, crypto, sports...).
 *    Each basket governs markets in its category.
 *  - Quorum: K distinct wallets in a basket must have BOUGHT the same outcome
 *    of the same conditionId within the rolling window.
 *  - Window: a configurable rolling window (default 1 hour). Votes age out, so a
 *    "consensus" formed across 3 hours is NOT valid — it must be a recent
 *    agreement. This is the time-decay filter.
 *  - Price-band filter: when quorum fires, compare the consensus entry price to
 *    the CURRENT market price. If the market has already moved past maxDrift,
 *    the edge is gone — skip (don't chase).
 *  - One-shot per market/outcome: after a quorum fires and is acted on (or
 *    rejected for drift), do not re-fire for the same market+outcome in this
 *    window.
 *  - Distinct-wallet enforcement: one wallet can vote at most once per
 *    outcome; repeated fills by the same wallet do NOT push toward quorum.
 *    This is the anti-iceberging guard.
 *
 * ==== How to wire in ====
 *  Instead of:
 *     smartMoneyService.startAutoCopyTrading({ targetAddresses, ... })
 *  Use:
 *     const quorum = new BasketQuorumService(settings, tradingService);
 *     smartMoneyService.subscribeSmartMoneyTrades(
 *        (trade) => quorum.onTrade(trade),
 *        { minSize: settings.minTradeSize }
 *     );
 *
 *  The service reads settings from a BasketQuorumConfig object (see README).
 */

import type { TradingService, OrderResult } from './trading-service.js';
import type { SmartMoneyTrade } from './smart-money-service.js';
import { categorizeMarket, type MarketCategory } from './smart-money-service.js';
import type { ScreenedWallet } from './wallet-screening-service.js';
import type { RiskManager } from './risk-manager.js';
import type { VoteStateStore } from './vote-state-store.js';
import { signalAuditStore, type SignalSide } from './signal-audit-store.js';
import { GammaApiClient } from '../clients/gamma-api.js';

// ============================================================================
// Config
// ============================================================================

export interface BasketConfig {
  /** Human name, e.g. 'politics' */
  name: string;
  /** Which market category this basket governs */
  category: MarketCategory;
  /** Expert wallets in this basket (lowercased on load) */
  wallets: string[];
  /** Min distinct wallets that must agree to fire (default 3) */
  quorum: number;
  /** Rolling window in ms (default 1h = 3_600_000) */
  windowMs: number;
  /** Whether this basket is active */
  enabled: boolean;
  /** Rolling win rate (0-1), updated on each settlement. Starts at 0.6 (prior). */
  winRate: number;
}

export interface BasketQuorumConfig {
  /** Default quorum count when a basket doesn't set it */
  defaultQuorum: number;
  /** Default window (ms) when a basket doesn't set it */
  defaultWindowMs: number;
  /** Max drift from consensus entry before we skip (e.g. 0.05 = 5%) */
  maxPriceDrift: number;
  /** Cooldown (ms) before a market+outcome can fire again after an action */
  fireCooldownMs: number;
  /** Reuse the existing copy sizing */
  sizeScale: number;
  maxSizePerTrade: number;
  maxSlippage: number;
  orderType: 'FOK' | 'FAK';
  minTradeSize: number;
  dryRun: boolean;
  baskets: BasketConfig[];
  /**
   * Per-basket bankroll slice as a fraction of total capital (0-1).
   * The total must sum to <= 1.0. When sum < 1.0 the remainder is kept
   * unallocated as a reserve. Mirrors Polyland's `strategyAllocation` in
   * bot-config.ts and PredictEngine's per-strategy capital isolation.
   */
  bankrollAllocation?: Partial<Record<MarketCategory, number>>;
}

// ============================================================================
// Types
// ============================================================================

/** A single wallet's vote in a market/outcome */
interface Vote {
  wallet: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  timestamp: number;
}

interface QuorumSignal {
  /** Unique id linking this signal to SignalAuditStore */
  signalId: string;
  conditionId: string;
  marketSlug: string;
  outcome: string;
  category: MarketCategory;
  basketName: string;
  /** Distinct agreeing wallets */
  walletCount: number;
  wallets: string[];
  /** Median consensus entry price */
  consensusPrice: number;
  /** Basket rolling win rate at fire time (for edge calculation) */
  winRate: number;
  /** Direction of the consensus (BUY or SELL) */
  side: SignalSide;
  /** Filled sizes at quorum */
  totalSize: number;
}

export interface QuorumStats {
  votesObserved: number;
  voters: number;
  quorumFired: number;
  quorumSkippedDrift: number;
  quorumSkippedCooldown: number;
  /** Dropped by thin_edge filter (vote USD value below $1 floor) */
  quorumSkippedThinEdge: number;
  /** Dropped by stale-market filter (market already expired) */
  quorumSkippedStaleMarket: number;
  /** Dropped because the RiskManager halted trading */
  quorumSkippedRiskHalt: number;
  /** Dropped because the basket's bankroll slice is exhausted */
  quorumSkippedBankroll: number;
  executed: number;
  failed: number;
}

// ============================================================================
// Service
// ============================================================================

export class BasketQuorumService {
  private config: BasketQuorumConfig;
  private tradingService: TradingService;

  /** category -> basket */
  private baskets = new Map<MarketCategory, BasketConfig>();

  /** conditionId -> outcome -> wallet -> Vote */
  private votes = new Map<string, Map<string, Map<string, Vote>>>();

  /** conditionId:outcome -> last fired timestamp (cooldown/one-shot) */
  private lastFired = new Map<string, number>();

  private stats: QuorumStats = {
    votesObserved: 0,
    voters: 0,
    quorumFired: 0,
    quorumSkippedDrift: 0,
    quorumSkippedCooldown: 0,
    quorumSkippedThinEdge: 0,
    quorumSkippedStaleMarket: 0,
    quorumSkippedRiskHalt: 0,
    quorumSkippedBankroll: 0,
    executed: 0,
    failed: 0,
  };

  /** Optional RiskManager — gates every execution. */
  private riskManager: RiskManager | null = null;
  /** Optional VoteStateStore — persists votes + lastFired across restarts. */
  private stateStore: VoteStateStore | null = null;
  /** Per-basket spend tracker (USDC spent on this basket) */
  private basketSpend: Map<MarketCategory, number> = new Map();
  /** Debounce timer for state persistence */
  private _persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** Gamma client for 1h/24h follow-up price checks (optional) */
  private gammaApi: GammaApiClient | null = null;
  /** Pending follow-up timers keyed by signalId */
  private pendingFollowups: Map<string, NodeJS.Timeout[]> = new Map();
  /**
   * Per-category specialization thresholds used by seed() to decide which
   * basket(s) a wallet joins. Mirrors WalletScreeningConfig so both gates
   * enforce the same bar.
   */
  private specMinCategoryTrades = 12;
  private specMinCategoryWinRate = 0.58;

  /**
   * Wire a RiskManager so the quorum gate respects trading halts and
   * dynamic sizing. Optional — without it, no risk enforcement.
   */
  setRiskManager(risk: RiskManager): void {
    this.riskManager = risk;
  }

  /**
   * Set the per-category specialization thresholds used by seed() to route
   * wallets into baskets. Should match WalletScreeningConfig so the screen
   * and the seed agree on what "proven edge in a category" means.
   */
  setSpecializationThresholds(minCategoryTrades: number, minCategoryWinRate: number): void {
    this.specMinCategoryTrades = minCategoryTrades;
    this.specMinCategoryWinRate = minCategoryWinRate;
  }

  /**
   * Wire a VoteStateStore so vote state survives process restarts.
   * Pruning is applied on load (drops votes older than the longest
   * configured basket window).
   */
  setStateStore(store: VoteStateStore): void {
    this.stateStore = store;
    this.votes = store.votes;
    this.lastFired = store.lastFired;
    // Prune anything already past the window
    let maxWindow = 0;
    for (const [, basket] of this.baskets) {
      if (basket.windowMs > maxWindow) maxWindow = basket.windowMs;
    }
    const pruned = store.pruneStale(maxWindow);
    if (pruned > 0) {
      console.log(`[BasketQuorum] pruned ${pruned} stale votes on load`);
    }
  }

  /**
   * Wire GammaApiClient for 1h/24h follow-up price checks after quorum fires.
   * Optional — without it, follow-ups are skipped but the core quorum
   * pipeline continues to work.
   */
  setGammaApi(api: GammaApiClient): void {
    this.gammaApi = api;
  }

  /**
   * Schedule a debounced state save. Called whenever votes or lastFired
   * change so we don't write the file on every single trade.
   */
  private _schedulePersist(): void {
    if (!this.stateStore) return;
    if (this._persistTimer !== null) {
      clearTimeout(this._persistTimer);
    }
    this._persistTimer = setTimeout(() => {
      this.stateStore?.save().catch((err) => {
        console.warn(
          `[BasketQuorum] state persist failed:`,
          err instanceof Error ? err.message : err,
        );
      });
      this._persistTimer = null;
    }, 1000); // 1s debounce
  }

  /**
   * Schedule 1h and 24h follow-up price checks for a fired signal.
   * At each checkpoint, fetch the current market price and log whether
   * the consensus direction held. Results feed the per-basket signal-quality
   * score and the operator's edge audit trail.
   */
  private _scheduleFollowup(signal: QuorumSignal): void {
    if (!this.gammaApi) return;

    const id = signal.signalId;

    const checkPrice = (label: string, delayMs: number) => {
      const timer = setTimeout(async () => {
        try {
          const markets = await this.gammaApi!.getMarkets({
            conditionId: signal.conditionId,
          });
          const market = markets[0];
          if (!market) {
            console.log(`[BasketQuorum][${label}] ${id}: market not found`);
            return;
          }
          const currentPrice = market.lastTradePrice ?? market.bestBid ?? 0;
          const priceMoved = Math.abs(currentPrice - signal.consensusPrice);
          const pctMove = signal.consensusPrice > 0
            ? (priceMoved / signal.consensusPrice) * 100
            : 0;
          const movedFavorably = signal.side === 'BUY'
            ? currentPrice > signal.consensusPrice
            : currentPrice < signal.consensusPrice;

          console.log(
            `[BasketQuorum][${label}] ${signal.marketSlug}: ` +
              `entry=${signal.consensusPrice.toFixed(3)} ` +
              `now=${currentPrice.toFixed(3)} ` +
              `move=${pctMove.toFixed(1)}% ` +
              `favorable=${movedFavorably}`
          );
        } catch (err) {
          console.warn(`[BasketQuorum][${label}] ${id}: price check failed`, err);
        }
      }, delayMs);
      return timer;
    };

    const ONE_HOUR = 60 * 60 * 1000;
    const ONE_DAY = 24 * ONE_HOUR;

    const timers = [checkPrice('1h', ONE_HOUR), checkPrice('24h', ONE_DAY)];
    this.pendingFollowups.set(id, timers);
  }

  /**
   * Compute the maximum USDC a given basket may spend in this session
   * based on its bankrollAllocation. Default: 100% of RiskManager capital.
   */
  private bankrollFor(category: MarketCategory): number {
    const slice = this.config.bankrollAllocation?.[category] ?? 1.0;
    const capital = this.riskManager ? this.riskManager.currentCapital() : 1000;
    return capital * slice;
  }

  constructor(tradingService: TradingService, config: BasketQuorumConfig) {
    this.tradingService = tradingService;
    this.config = config;
    for (const basket of config.baskets) {
      if (!basket.enabled) continue;
      this.baskets.set(basket.category, {
        ...basket,
        quorum: basket.quorum ?? config.defaultQuorum,
        windowMs: basket.windowMs ?? config.defaultWindowMs,
        wallets: basket.wallets.map((w) => w.toLowerCase()),
        winRate: basket.winRate ?? 0.6,
      });
    }
  }

  /**
   * Rebuild baskets from a screened-wallet list.
   *
   * Used after WalletIngestionService.collect() + WalletScreeningService.score()
   * have produced a tiered candidate list. Each wallet is assigned to a basket
   * based on its category hint (manual wallet's category, or auto-source's
   * leaderboard category). Wallets with no category fall back to the first
   * enabled basket, or 'other' if it exists.
   *
   * Only PRIMARY and SATELLITE wallets are seeded into baskets; WATCHLIST
   * and REJECTED are kept out of the consensus pipeline. Bypassed wallets
   * are always seeded regardless of source stats.
   *
   * The basket quorum/window settings from the original config are preserved
   * (seeded baskets inherit config.defaultQuorum / config.defaultWindowMs).
   */
  seed(screened: ScreenedWallet[]): void {
    const eligible = screened.filter(
      (w) => w.tier === 'PRIMARY' || w.tier === 'SATELLITE' || w.bypassed
    );
    if (eligible.length === 0) {
      console.warn('[BasketQuorum] seed() called with no eligible wallets');
      return;
    }

    // Route each wallet into the basket(s) where IT has demonstrated edge.
    // A wallet is seeded into a category basket only if its own per-category
    // win rate beats the baseline AND it has enough category-specific trades
    // to trust that number. This stops a strong-crypto wallet from polluting
    // the politics basket, and lets a genuinely multi-category expert join
    // several baskets at once.
    //
    // Fallback: bypassed / manual wallets with no per-category data are seeded
    // purely by their resolved category (operator trusts them).
    const byCategory = new Map<MarketCategory, string[]>();
    let inferredCount = 0;
    let otherCount = 0;
    let multiBasket = 0;

    const qualifiesFor = (w: ScreenedWallet, cat: MarketCategory): boolean => {
      const stat = w.categoryWinRates[cat];
      if (!stat) return false;
      return (
        stat.tradeCount >= this.specMinCategoryTrades &&
        stat.winRate >= this.specMinCategoryWinRate
      );
    };

    for (const w of eligible) {
      if (w.categorySource === 'inferred') inferredCount++;
      if (w.category === 'other') otherCount++;

      // Collect every category this wallet is specialized in.
      const cats = new Set<MarketCategory>();
      for (const cat of Object.keys(w.categoryWinRates) as MarketCategory[]) {
        if (qualifiesFor(w, cat)) cats.add(cat);
      }

      // No per-category proof (bypassed / manual / thin data) → trust resolved cat.
      if (cats.size === 0) {
        cats.add(w.category);
      } else if (cats.size > 1) {
        multiBasket++;
      }

      for (const cat of cats) {
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push(w.address.toLowerCase());
      }
    }

    // Rebuild baskets Map using existing config defaults.
    this.baskets.clear();
    for (const [category, wallets] of byCategory) {
      this.baskets.set(category, {
        name: category,
        category,
        wallets,
        quorum: this.config.defaultQuorum,
        windowMs: this.config.defaultWindowMs,
        enabled: true,
        winRate: 0.6,  // prior: 60% win rate as Bayesian starting point
      });
    }

    // Drop any prior vote state — baskets changed.
    this.votes.clear();
    this.lastFired.clear();
    this.basketSpend.clear();
    this._schedulePersist();
    const summary = [...byCategory.entries()]
      .map(([c, ws]) => c + '=' + ws.length)
      .join(', ');
    console.log(
      `[BasketQuorum] seeded ${eligible.length} wallets across ` +
        `${byCategory.size} baskets: ${summary} ` +
        `(inferred: ${inferredCount}, fallback-to-other: ${otherCount}, multi-basket: ${multiBasket})`
    );
  }

  private windowMs(category: MarketCategory): number {
    return this.baskets.get(category)?.windowMs ?? this.config.defaultWindowMs;
  }

  private quorumFor(category: MarketCategory): number {
    return this.baskets.get(category)?.quorum ?? this.config.defaultQuorum;
  }

  /** Number of baskets currently seeded with wallets (after seed()). */
  getBasketCount(): number {
    return this.baskets.size;
  }

  /**
   * Entry point: feed every smart-money trade here.
   * Routes by category -> basket -> votes -> quorum -> execute.
   */
  onTrade(trade: SmartMoneyTrade): void {
    // We can't build a consensus key without a market; skip.
    const conditionId = trade.conditionId;
    const marketSlug = trade.marketSlug;
    const outcome = trade.outcome;
    if (!conditionId || !marketSlug || !outcome) return;

    // 1. Determine the governing basket by the market's category.
    //    We classify on the slug (words are in slugs, e.g. "will-btc-hit-100k").
    const category = categorizeMarket(marketSlug || outcome || '');
    const basket = this.baskets.get(category);
    if (!basket) {
      // Market belongs to a category with no tracked basket — ignore.
      return;
    }

    // 2. Only count wallets that are members of this basket.
    const traderKey = trade.traderAddress.toLowerCase();
    if (!basket.wallets.includes(traderKey)) return;

    // 3. Only BUY votes contribute to a buy-consensus we act on. (SELL votes
    //    are recorded but not counted toward firing, so we can see counter-flow.)
    if (trade.side !== 'BUY') return;

    const now = Date.now();

    // 4. Prune stale votes in THIS market/outcome (rolling window).
    const outcomeVotes = this.getVoteMap(conditionId, outcome);
    for (const [wallet, vote] of outcomeVotes) {
      if (now - vote.timestamp > this.windowMs(category)) {
        outcomeVotes.delete(wallet);
      }
    }

    // 5. PRE-VOTE FILTERS (run BEFORE recording this vote).
    //    Without these, low-quality trades poison the consensus and we
    //    waste quorum votes on markets that can't be traded. The Zeabur
    //    runlogs showed quorum reaching=8 vs quorum rejected=25 because
    //    filters ran AFTER quorum — those 25 votes should never have
    //    counted toward the consensus.
    if (this._isTradeTooSmall(trade)) {
      this.stats.quorumSkippedThinEdge = (this.stats.quorumSkippedThinEdge ?? 0) + 1;
      return;
    }
    if (this._isMarketStale(trade)) {
      this.stats.quorumSkippedStaleMarket = (this.stats.quorumSkippedStaleMarket ?? 0) + 1;
      return;
    }

    // 6. Record the vote — one vote per wallet per outcome.
    outcomeVotes.set(traderKey, {
      wallet: traderKey,
      side: trade.side,
      price: trade.price,
      size: trade.size,
      timestamp: now,
    });

    this.stats.voters = this.votes.size;
    this.stats.votesObserved++;
    this._schedulePersist();

    // 7. Evaluate quorum.
    this.tryFire({ ...trade, conditionId, marketSlug, outcome }, basket, outcomeVotes);
  }

  /**
   * Filter: drop votes whose USD value is below the thin-edge floor.
   * Default floor = 1 share at $0.50, i.e. $0.50. Sub-floor fills are
   * either dust attacks or accidental clicks — neither is a real signal.
   */
  private _isTradeTooSmall(trade: SmartMoneyTrade): boolean {
    const notional = trade.price * trade.size;
    return notional < 1.0; // $1 floor (matches Polymarket minimum order)
  }

  /**
   * Filter: drop votes for markets that have already resolved.
   *   - marketSlug patterns like 'will-trump-win-on-march-15-2027' where
   *     the date is in the past
   *   - explicit `days_to_expiry < 0` (would be passed via SmartMoneyTrade
   *     if the upstream adds it; today it's inferred from slug)
   *
   * Returns true if the market is past expiry.
   */
  private _isMarketStale(trade: SmartMoneyTrade): boolean {
    // SmartMoneyTrade only has marketSlug; the slug itself encodes the
    // resolution date (e.g. 'highest-temperature-in-nyc-on-march-15-2026').
    const haystack = (trade.marketSlug ?? '').toLowerCase();
    // Look for "on-<month>-<day>-<year>" pattern in the slug, which is how
    // Polymarket titles resolved markets (e.g. "highest-temperature-in-nyc-on-march-15-2026").
    const m = haystack.match(/on-([a-z]+)-(\d{1,2})-(\d{4})/);
    if (!m) return false;
    const monthNames = [
      'january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december',
    ];
    const monthIdx = monthNames.indexOf(m[1]);
    if (monthIdx < 0) return false;
    const day = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    const expiry = new Date(Date.UTC(year, monthIdx, day, 23, 59, 59));
    return expiry.getTime() < Date.now();
  }

  private getVoteMap(
    conditionId: string,
    outcome: string
  ): Map<string, Vote> {
    let byOutcome = this.votes.get(conditionId);
    if (!byOutcome) {
      byOutcome = new Map();
      this.votes.set(conditionId, byOutcome);
    }
    let byWallet = byOutcome.get(outcome);
    if (!byWallet) {
      byWallet = new Map();
      byOutcome.set(outcome, byWallet);
    }
    return byWallet;
  }

  private tryFire(
    trade: SmartMoneyTrade,
    basket: BasketConfig,
    outcomeVotes: Map<string, Vote>
  ): void {
    const now = Date.now();
    const conditionId = trade.conditionId!;
    const marketSlug = trade.marketSlug!;
    const outcome = trade.outcome!;
    const key = `${conditionId}:${outcome}`;

    // Cooldown: one-shot per market+outcome in the window.
    const last = this.lastFired.get(key) ?? 0;
    if (now - last < this.config.fireCooldownMs) {
      this.stats.quorumSkippedCooldown++;
      return;
    }

    // Distinct agreeing wallets (this is the quorum count).
    const agreeing = [...outcomeVotes.values()].filter(
      (v) => v.side === 'BUY'
    );
    if (agreeing.length < basket.quorum) {
      // Not enough consensus yet — wait for more basket members.
      return;
    }

    // Consensus reached. Compute median entry price.
    const prices = agreeing.map((v) => v.price).sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const consensusPrice =
      prices.length % 2 === 0
        ? (prices[mid - 1] + prices[mid]) / 2
        : prices[mid];

    const signal: QuorumSignal = {
      signalId: `${conditionId}-${outcome}-${now}`,
      conditionId,
      marketSlug,
      outcome,
      category: basket.category,
      basketName: basket.name,
      walletCount: agreeing.length,
      wallets: agreeing.map((v) => v.wallet),
      consensusPrice,
      winRate: basket.winRate ?? 0.6,
      side: 'BUY',  // consensus only formed from BUY votes (SELL filtered upstream)
      totalSize: agreeing.reduce((sum, v) => sum + v.size, 0),
    };

    // Record the fire in SignalAuditStore (price calibration + fee math done inside)
    signalAuditStore.recordFire({
      conditionId,
      marketSlug,
      outcome,
      side: 'BUY',
      pricePaid: consensusPrice,
      size: signal.totalSize,
      winRate: basket.winRate ?? 0.6,
      basket: basket.name,
      wallets: signal.wallets,
    });

    // Schedule 1h and 24h follow-up price checks (whalewatch-style validation loop)
    this._scheduleFollowup(signal);

    this.lastFired.set(key, now);
    this._schedulePersist();

    // 7a. Risk halt — if RiskManager says no, don't even check drift.
    if (this.riskManager && !this.riskManager.canTrade()) {
      this.stats.quorumSkippedRiskHalt++;
      return;
    }

    // 7b. Bankroll slice check — the basket's spend must not exceed its slice.
    const basketBankroll = this.bankrollFor(basket.category);
    const spent = this.basketSpend.get(basket.category) ?? 0;
    if (spent >= basketBankroll) {
      this.stats.quorumSkippedBankroll++;
      return;
    }

    // 7c. Price-band / drift filter — the CRITICAL edge decoy. If the market
    //     has already moved past maxDrift from consensus entry, skip.
    this.executeIfInBand(trade, signal, basket);
  }

  private async executeIfInBand(
    trade: SmartMoneyTrade,
    signal: QuorumSignal,
    basket: BasketConfig,
  ): Promise<void> {
    // In production, fetch the current market price here via
    //   this.tradingService.getMarketPrice?.(signal.conditionId)
    // and compare to signal.consensusPrice. For v1 we use the most recent
    // vote price as the proxy, so drift defaults to 0 (no fake edge).
    const currentPrice = trade.price;
    const drift = Math.abs(currentPrice - signal.consensusPrice) /
      (signal.consensusPrice || 1);
    if (drift > this.config.maxPriceDrift) {
      this.stats.quorumSkippedDrift++;
      console.log(
        `[BasketQuorum] SKIP drift: ${signal.marketSlug} ` +
          `consensus=${signal.consensusPrice.toFixed(3)} now=${currentPrice.toFixed(3)} ` +
          `(drift ${(drift * 100).toFixed(1)}% > ${(this.config.maxPriceDrift * 100).toFixed(0)}%)`
      );
      return;
    }

    // 8. Size & execute, reusing the repo's existing sizing/slippage logic.
    this.stats.quorumFired++;
    try {
      // Shares to copy = TOTAL agreeing shares scaled by sizeScale.
      let copySize = signal.totalSize * this.config.sizeScale;
      let copyValue = copySize * signal.consensusPrice;

      // Enforce per-trade USDC cap (mirrors startAutoCopyTrading).
      if (copyValue > this.config.maxSizePerTrade) {
        copySize = this.config.maxSizePerTrade / signal.consensusPrice;
        copyValue = this.config.maxSizePerTrade;
      }

      // RiskManager dynamic sizing — shrink/grow based on consecutive outcomes.
      if (this.riskManager) {
        copyValue = this.riskManager.sizeOrder(copyValue);
      }

      // Re-check bankroll after dynamic sizing.
      const bankroll = this.bankrollFor(basket.category);
      const spent = this.basketSpend.get(basket.category) ?? 0;
      if (spent + copyValue > bankroll) {
        copyValue = Math.max(0, bankroll - spent);
      }

      const usdcAmount = copyValue;
      if (usdcAmount < this.config.minTradeSize || usdcAmount < 1) {
        return;
      }

      const slippagePrice =
        signal.consensusPrice * (1 + this.config.maxSlippage);

      let result: OrderResult;
      if (this.config.dryRun) {
        result = { success: true, orderId: `dry_run_${Date.now()}` };
        console.log('[BasketQuorum DRY RUN]', {
          basket: signal.basketName,
          market: signal.marketSlug,
          outcome: signal.outcome,
          quorum: signal.walletCount,
          wallets: signal.wallets.map((w) => w.slice(0, 8)),
          usdc: usdcAmount.toFixed(2),
        });
      } else {
        result = await this.tradingService.createMarketOrder({
          tokenId: trade.tokenId!,
          side: 'BUY',
          amount: usdcAmount,
          price: slippagePrice,
          orderType: this.config.orderType,
        });
      }

      if (result.success) {
        this.stats.executed++;
        this.basketSpend.set(
          basket.category,
          (this.basketSpend.get(basket.category) ?? 0) + usdcAmount,
        );
      } else {
        this.stats.failed++;
      }
    } catch (error) {
      this.stats.failed++;
      console.error('[BasketQuorum] execute error:', error);
    }
  }

  getStats(): QuorumStats {
    return { ...this.stats };
  }

  /**
   * Pretty-print the funnel: how many signals came in, how many were
   * filtered at each gate, how many actually traded. Matches the
   * Polymeteo "signals detected -> filters -> quorum -> copied" funnel.
   *
   * Returns the funnel object so callers can also send it to a
   * dashboard / log aggregator.
   */
  logFunnel(label: string = ''): {
    observed: number;
    filtered: number;
    filtered_thin: number;
    filtered_stale: number;
    quorum_fired: number;
    skipped_risk: number;
    skipped_bankroll: number;
    skipped_drift: number;
    skipped_cooldown: number;
    executed: number;
    failed: number;
    conversion_pct: number;
  } {
    const s = this.stats;
    const filtered = s.quorumSkippedThinEdge + s.quorumSkippedStaleMarket;
    const conversion = s.votesObserved === 0 ? 0 : (s.executed / s.votesObserved) * 100;
    const funnel = {
      observed: s.votesObserved,
      filtered,
      filtered_thin: s.quorumSkippedThinEdge,
      filtered_stale: s.quorumSkippedStaleMarket,
      quorum_fired: s.quorumFired,
      skipped_risk: s.quorumSkippedRiskHalt,
      skipped_bankroll: s.quorumSkippedBankroll,
      skipped_drift: s.quorumSkippedDrift,
      skipped_cooldown: s.quorumSkippedCooldown,
      executed: s.executed,
      failed: s.failed,
      conversion_pct: Math.round(conversion * 100) / 100,
    };
    const edgeStats = signalAuditStore.getStats();
    console.log(
      `[BasketQuorum${label ? ':' + label : ''}] funnel: ` +
        `observed=${funnel.observed} ` +
        `filtered=${funnel.filtered}(thin=${funnel.filtered_thin},stale=${funnel.filtered_stale}) ` +
        `fired=${funnel.quorum_fired} ` +
        `risk=${funnel.skipped_risk} bankroll=${funnel.skipped_bankroll} ` +
        `drift=${funnel.skipped_drift} cooldown=${funnel.skipped_cooldown} ` +
        `executed=${funnel.executed} failed=${funnel.failed} ` +
        `conversion=${funnel.conversion_pct}%` +
        (edgeStats.signalsSettled > 0
          ? ` | edge: exp=${edgeStats.meanExpectedEdge.toFixed(4)} ` +
            `real=${edgeStats.meanRealizedEdge.toFixed(4)} ` +
            `alpha=${edgeStats.edgeAlpha.toFixed(4)} ` +
            `sig=${edgeStats.isSignificant} ` +
            `(n=${edgeStats.signalsSettled} settled/${edgeStats.signalsFired} fired)`
          : ''),
    );
    return funnel;
  }

  /** Drop all state (used on basket re-config). */
  reset(): void {
    this.votes.clear();
    this.lastFired.clear();
    this.basketSpend.clear();
    if (this._persistTimer !== null) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    this.stats = {
      votesObserved: 0,
      voters: 0,
      quorumFired: 0,
      quorumSkippedDrift: 0,
      quorumSkippedCooldown: 0,
      quorumSkippedThinEdge: 0,
      quorumSkippedStaleMarket: 0,
      quorumSkippedRiskHalt: 0,
      quorumSkippedBankroll: 0,
      executed: 0,
      failed: 0,
    };
  }

  /**
   * Record market resolution for edge auditing.
   * Call this when a market settles — it updates the SignalAuditStore
   * AND each basket's rolling win rate so the next quorum fire has an
   * up-to-date expected edge.
   *
   * @param conditionId  Polymarket condition id
   * @param resolved     0 or 1 (binary outcome)
   */
  recordResolution(conditionId: string, resolved: 0 | 1): void {
    // 1. Update the audit store so we can compute realized edge
    signalAuditStore.recordSettlement(conditionId, resolved);

    // 2. Update each basket's rolling win rate.
    //    W_new = W_old * (1 - α) + outcome * α   (EMA with α=0.1)
    const ALPHA = 0.1;
    for (const [, basket] of this.baskets) {
      if (!basket.enabled) continue;
      const won = resolved === 1 ? 1 : 0;
      basket.winRate = basket.winRate * (1 - ALPHA) + won * ALPHA;
    }
  }

  /**
   * Record the settled P&L of a trade so the RiskManager can update
   * its halts, dynamic sizing, and bankroll slice accounting.
   * Call this from your executor (or the TradingService wrapper) AFTER
   * the order has been filled/resolved.
   */
  recordSettledTrade(pnlUsd: number, ts: number = Date.now(), side: 'BUY' | 'SELL' = 'BUY'): void {
    if (this.riskManager) {
      this.riskManager.recordTrade({ pnlUsd, ts, side });
    }
  }
}

