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
import { takerFeePerShare, feePerShare, DEFAULT_FEE_RATE_BPS } from '../utils/fee-math.js';
import { AntiSniperGuard, DEFAULT_ANTI_SNIPER_CONFIG } from '../utils/anti-sniper.js';
import { buildOrderBookSummary } from '../utils/liquidity-check.js';
import { ChainlinkTwapOracle, type CryptoSymbol, type TwapSignalEvaluation } from './chainlink-twap-oracle.js';

/** Symbol → question-key heuristic mapping (lowercased). For markets
 *  where the title contains 'btc', 'eth', 'sol', 'xrp', 'doge', 'hype' we
 *  treat it as a crypto-resolution market and consult the oracle. */
function detectCryptoSymbol(slug: string | undefined): CryptoSymbol | null {
  if (!slug) return null;
  const s = slug.toLowerCase();
  if (s.includes('btc') || s.includes('bitcoin')) return 'btc';
  if (s.includes('eth') || s.includes('ethereum')) return 'eth';
  if (s.includes('sol') && !s.includes('solana-air')) return 'sol';
  if (s.includes('xrp') || s.includes('ripple')) return 'xrp';
  if (s.includes('doge')) return 'doge';
  if (s.includes('hype')) return 'hype';
  return null;
}

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
  /**
   * Min interval (ms) between near-miss diagnostic logs for the same
   * market+outcome. Defaults to 5 minutes. Without this, high-frequency
   * crypto up/down markets re-log the same near-miss state on every vote
   * (observed: 92% of all log output).
   */
  nearMissLogIntervalMs?: number;
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
  /** Wallet tier when vote was cast — used for tiered quorum (2×PRIMARY or 1P+2S) */
  tier: 'PRIMARY' | 'SATELLITE';
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
  /** Skipped because market+outcome was already executed (survives restart via VoteStateStore) */
  quorumSkippedRestartDedup: number;
  /** Dropped by thin_edge filter (vote USD value below $1 floor) */
  quorumSkippedThinEdge: number;
  /** Dropped by stale-market filter (market already expired) */
  quorumSkippedStaleMarket: number;
  /** Dropped because the RiskManager halted trading */
  quorumSkippedRiskHalt: number;
  /** Dropped because the basket's bankroll slice is exhausted */
  quorumSkippedBankroll: number;
  /** Dropped by the anti-sniper guard (mid jump, unstable mid, fill cooldown) */
  quorumSkippedAntiSniper?: number;
  /** Dropped by the Chainlink TWAP oracle due to stale data */
  quorumSkippedTwapStale?: number;
  /** Dropped by the Chainlink TWAP oracle due to momentum misalignment */
  quorumSkippedTwapMisaligned?: number;
  /** Dropped by the 2× liquidity check (book too thin) */
  quorumSkippedThinLiquidity?: number;
  /** Dropped by the fee-adjusted edge filter (no profitable edge after fees) */
  quorumSkippedNegativeEdge?: number;
  /** Dropped because dynamic sizing shrank the order below minTradeSize */
  quorumSkippedMinSize?: number;
  /** Breakdown of anti-sniper block reasons (no_mid_observations, mid_jump, ...) */
  antiSniperReasons?: Record<string, number>;
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

  /** Wallet address -> tier map. Populated in seed(). Used for tiered quorum. */
  private walletTierMap = new Map<string, 'PRIMARY' | 'SATELLITE'>();

  /** conditionId:outcome -> last fired timestamp (cooldown/one-shot) */
  private lastFired = new Map<string, number>();

  /** conditionId:outcome -> last near-miss diagnostic log timestamp */
  private nearMissLogAt = new Map<string, number>();

  /** Resolved min interval between near-miss logs (config default 5 min). */
  private nearMissLogIntervalMs: number;

  /** Local ref to stateStore.lastProcessedFire — set in setStateStore() */
  private _lastProcessedFire = new Map<string, number>();

  private stats: QuorumStats = {
    votesObserved: 0,
    voters: 0,
    quorumFired: 0,
    quorumSkippedDrift: 0,
    quorumSkippedCooldown: 0,
    quorumSkippedRestartDedup: 0,
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
  /** Anti-sniper guard (mid-jump, fill-cooldown, reprice clamping). */
  private antiSniper: AntiSniperGuard | null = null;
  /** Chainlink TWAP oracle (crypto markets only). */
  private twapOracle: ChainlinkTwapOracle | null = null;
  /** Per-conditionId fee rate cache (basis points), so we don't refetch. */
  private feeRateCache: Map<string, number> = new Map();
  /** Per-conditionId tick size cache. */
  private tickSizeCache: Map<string, number> = new Map();
  /** Per-conditionId last TWAP evaluation result (debug + audit). */
  private lastTwapEval: Map<string, TwapSignalEvaluation> = new Map();
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
    this.votes = store.votes as typeof this.votes;
    this.lastFired = store.lastFired;
    this._lastProcessedFire = store.lastProcessedFire;
    // Prune anything already past the window
    let maxWindow = 0;
    for (const [, basket] of this.baskets) {
      if (basket.windowMs > maxWindow) maxWindow = basket.windowMs;
    }
    const pruned = store.pruneStale(maxWindow);
    if (pruned > 0) {
      console.log(`[BasketQuorum] pruned ${pruned} stale votes on load`);
    }
    // Also prune old lastProcessedFire entries (7-day dedup window)
    const dedupPruned = store.pruneLastProcessedFire(7 * 24 * 60 * 60 * 1000);
    if (dedupPruned > 0) {
      console.log(`[BasketQuorum] pruned ${dedupPruned} stale dedup entries on load`);
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
   * Wire an anti-sniper guard. Without one, the fire path is unprotected
   * against thin-book fills and copy-sniping. The default is the proven
   * config (3% mid-jump, 1s stable confirm, 5s fill cooldown, 2 ticks
   * reprice cap).
   */
  setAntiSniper(guard: AntiSniperGuard): void {
    this.antiSniper = guard;
  }

  /**
   * Wire the Chainlink TWAP oracle for crypto Up/Down markets. Without
   * one, crypto baskets fire on the bare consensus without an oracle
   * sanity check.
   */
  setTwapOracle(oracle: ChainlinkTwapOracle): void {
    this.twapOracle = oracle;
  }

  /**
   * Feed a mid-price observation to the anti-sniper guard. The order book
   * subscriber should call this for every mid update.
   */
  observeMid(tokenId: string, mid: number): void {
    this.antiSniper?.observe(tokenId, mid);
  }

  /**
   * Optional callback: the service signals that a tokenId has live quorum
   * interest (near-miss consensus building). The operator wiring should
   * subscribe to that token's orderbook so observeMid() gets continuous
   * data — without it, allowFire() rejects with no_mid_observations/mid_unstable.
   */
  onMidInterest: ((tokenId: string) => void) | null = null;

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
    this.nearMissLogIntervalMs = config.nearMissLogIntervalMs ?? 5 * 60 * 1000;
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

    // Clear the tier map BEFORE the population loop — NOT in the
    // drop-state block below (an earlier version cleared it there, which
    // wiped the tiers this loop just set and made every vote fall back to
    // 'SATELLITE' → primary=0 forever → only the 5-satellite escape hatch
    // could ever fire).
    this.walletTierMap.clear();

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

      // Populate tier map for tiered quorum checks (2×PRIMARY or 1P+2S).
      // Key MUST be lowercased here because onTrade() lowercases traderKey
      // before basket.wallets.includes() — if cases differ the vote is silently
      // dropped and every wallet shows primary=0 in logs.
      this.walletTierMap.set(w.address.toLowerCase(), w.tier as 'PRIMARY' | 'SATELLITE');
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
    // (walletTierMap was already cleared at the top of seed(); do NOT clear
    // it here or the tiers populated above are wiped — the PRIMARY=0 bug.)
    this.votes.clear();
    this.lastFired.clear();
    this.nearMissLogAt.clear();
    this._lastProcessedFire.clear();
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
    const walletTier = this.walletTierMap.get(traderKey) ?? 'SATELLITE';
    outcomeVotes.set(traderKey, {
      wallet: traderKey,
      side: trade.side,
      price: trade.price,
      size: trade.size,
      timestamp: now,
      tier: walletTier,
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

    // Restart-dedup: if a fire was already executed for this market+outcome
    // AND persisted to VoteStateStore, skip on restart to prevent double-execution.
    if (this._lastProcessedFire.has(key)) {
      this.stats.quorumSkippedRestartDedup++;
      return;
    }

    // Tiered quorum: 2× PRIMARY or 1× PRIMARY + 2× SATELLITE fires a signal.
        // This ensures signals come from genuine elite consensus, not just wallet count.
        // ALSO: a strong crowd consensus (5+ SATELLITE votes on same market) fires
        // — empirical near-miss data showed 18 SATELLITE voting on BTC up/down
        // with 0 PRIMARY in that window; elite consensus is also numerical
        // consensus when enough wallets agree.
        const primaryCount = [...outcomeVotes.values()].filter((v) => v.side === 'BUY' && v.tier === 'PRIMARY').length;
        const satelliteCount = [...outcomeVotes.values()].filter((v) => v.side === 'BUY' && v.tier === 'SATELLITE').length;
        const tieredFires =
          primaryCount >= 2 ||
          (primaryCount >= 1 && satelliteCount >= 2) ||
          satelliteCount >= 5;  // crowd consensus escape hatch
        if (!tieredFires) {
          // Diagnostic: log NEAR-MISSES so we can see if consensus is *almost* there.
          // Rate-limited: one line per market+outcome per nearMissLogIntervalMs.
          // Only logs the "waiting" state the operator cares about: 2+ wallets
          // already aligned (primary>=1 or satellite>=2), still short of quorum.
          if (primaryCount + satelliteCount >= 2 && trade.tokenId) {
            const lastLog = this.nearMissLogAt.get(key) ?? 0;
            if (now - lastLog >= this.nearMissLogIntervalMs) {
              this.nearMissLogAt.set(key, now);
              const voters = [...outcomeVotes.values()].map(v => `${v.tier}@${v.price}`).join(',');
              console.log(`[Quorum near-miss] ${marketSlug} ${outcome} primary=${primaryCount} sat=${satelliteCount} votes=[${voters}]`);
              // Signal live quorum interest so the operator wiring can feed
              // the anti-sniper guard a real mid buffer for this token.
              if (this.onMidInterest) this.onMidInterest(trade.tokenId);
            }
          }
          // Not enough tier-weighted consensus — wait for more basket members.
          return;
        }

    // Consensus reached. Compute median entry price across all BUY votes.
    const buyVotes = [...outcomeVotes.values()].filter((v) => v.side === 'BUY');
    const prices = buyVotes.map((v) => v.price).sort((a, b) => a - b);
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
      walletCount: primaryCount + satelliteCount,
      wallets: [...outcomeVotes.values()].filter((v) => v.side === 'BUY').map((v) => v.wallet),
      consensusPrice,
      winRate: basket.winRate ?? 0.6,
      side: 'BUY',  // consensus only formed from BUY votes (SELL filtered upstream)
      totalSize: [...outcomeVotes.values()].filter((v) => v.side === 'BUY').reduce((sum, v) => sum + v.size, 0),
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

    // 7c-pre. Anti-sniper guard (lihanyu81 polymarket_lp_tool pattern):
    //     rejects the fire if the CLOB mid has jumped, the mid hasn't
    //     been stable long enough, or we just filled on this market.
    if (this.antiSniper && trade.tokenId) {
      const decision = this.antiSniper.allowFire(trade.tokenId, now);
      if (!decision.allow) {
        this.stats.quorumSkippedAntiSniper =
          (this.stats.quorumSkippedAntiSniper ?? 0) + 1;
        // Tally the reason so the funnel shows WHY fires are blocked
        // (no_mid_observations vs mid_jump vs mid_unstable vs fill_cooldown).
        const reason = (decision.reason ?? 'unknown').split(' ')[0];
        this.stats.antiSniperReasons = this.stats.antiSniperReasons ?? {};
        this.stats.antiSniperReasons[reason] =
          (this.stats.antiSniperReasons[reason] ?? 0) + 1;
        // This token has live quorum interest — ask the wiring to keep its
        // book subscribed so the guard accumulates mid observations.
        if (this.onMidInterest) this.onMidInterest(trade.tokenId);
        if (process.env['DEBUG_QUORUM']) {
          console.log(
            `[BasketQuorum] SKIP anti-sniper: ${signal.marketSlug} ` +
              `reason=${decision.reason}`,
          );
        }
        return;
      }
    }

    // 7c-pre2. Chainlink TWAP oracle (KingSparta69 pattern). For crypto
    //     markets, sanity-check the consensus against the running 30s/60s
    //     TWAP. If TWAP momentum disagrees with our side, demote the
    //     signal quality (skip if completely anti-aligned).
    if (this.twapOracle && basket.category === 'crypto') {
      const symbol = detectCryptoSymbol(signal.marketSlug);
      if (symbol) {
        const evalResult = this.twapOracle.evaluate(
          symbol,
          signal.consensusPrice,
          signal.side,
          now,
        );
        this.lastTwapEval.set(conditionId, evalResult);
        if (evalResult.quality === 'stale') {
          this.stats.quorumSkippedTwapStale =
            (this.stats.quorumSkippedTwapStale ?? 0) + 1;
          return;
        }
        if (evalResult.quality === 'fresh' && !evalResult.aligned) {
          this.stats.quorumSkippedTwapMisaligned =
            (this.stats.quorumSkippedTwapMisaligned ?? 0) + 1;
          return;
        }
      }
    }

    // 7c. Price-band / drift filter — the CRITICAL edge decoy. If the market
    //     has already moved past maxDrift from consensus entry, skip.
    this.executeIfInBand(trade, signal, basket, key, now);
  }

  private async executeIfInBand(
    trade: SmartMoneyTrade,
    signal: QuorumSignal,
    basket: BasketConfig,
    key: string,
    now: number,
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
        // Silent-drop counter: these fires passed every quality gate but the
        // scaled size (sizeScale × whale size, then RiskManager shrink) fell
        // below the $20 floor. Previously invisible in the funnel.
        this.stats.quorumSkippedMinSize =
          (this.stats.quorumSkippedMinSize ?? 0) + 1;
        return;
      }

      // 8a. Fee-adjusted edge check (Polymarket docs fee formula).
      //     If expected edge after taker fees is non-positive, skip the trade.
      //     Cached feeRateBps per condition; defaults to ~2% if unknown.
      const feeRateBps = this.feeRateCache.get(signal.conditionId) ?? DEFAULT_FEE_RATE_BPS;
      const feePerShareVal = takerFeePerShare(signal.consensusPrice, feeRateBps);
      const winRate = signal.winRate ?? 0.6;
      const expectedEdge = winRate - signal.consensusPrice - feePerShareVal;
      if (expectedEdge <= 0) {
        this.stats.quorumSkippedNegativeEdge =
          (this.stats.quorumSkippedNegativeEdge ?? 0) + 1;
        console.log(
          `[BasketQuorum] SKIP negative-edge: ${signal.marketSlug} ` +
            `winRate=${winRate.toFixed(3)} price=${signal.consensusPrice.toFixed(3)} ` +
            `fee=${(feePerShareVal * 100).toFixed(2)}% edge=${(expectedEdge * 100).toFixed(2)}%`,
        );
        return;
      }

      // 8b. 2× liquidity check (early-bird.ts pattern from polymarket-trade-engine).
      //     Only run when not in dry-run and we have a real CLOB connection.
      if (trade.tokenId && !this.config.dryRun) {
        try {
          const raw = await this.tradingService.getOrderBook(trade.tokenId);
          if (raw) {
            const book = buildOrderBookSummary(raw);
            const liqCheck = book.hasSufficientLiquidity({
              side: 'BUY',
              shares: copySize,
              price: signal.consensusPrice,
              multiplier: 2,
            });
            if (!liqCheck.ok) {
              this.stats.quorumSkippedThinLiquidity =
                (this.stats.quorumSkippedThinLiquidity ?? 0) + 1;
              console.log(
                `[BasketQuorum] SKIP thin-liquidity: ${signal.marketSlug} ` +
                  `${liqCheck.reason ?? 'unknown'}`,
              );
              return;
            }
          }
        } catch {
          // Book fetch failed — non-fatal; continue without the check.
        }
      }

      const slippagePrice =
        signal.consensusPrice * (1 + this.config.maxSlippage);

      // Clamp reprice via anti-sniper (maxRepriceTicks cap).
      const finalPrice = this.antiSniper && trade.tokenId
        ? this.antiSniper.clampReprice(
            trade.tokenId,
            slippagePrice,
            this.tickSizeCache.get(signal.conditionId) ?? 0.01,
          )
        : slippagePrice;

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
          edge_pct: (expectedEdge * 100).toFixed(2),
          fee_bps: feeRateBps,
        });
      } else {
        result = await this.tradingService.createMarketOrder({
          tokenId: trade.tokenId!,
          side: 'BUY',
          amount: usdcAmount,
          price: finalPrice,
          orderType: this.config.orderType,
        });
      }

      if (result.success) {
        this.stats.quorumFired++;
        this.stats.executed++;
        this.basketSpend.set(
          basket.category,
          (this.basketSpend.get(basket.category) ?? 0) + usdcAmount,
        );
        // Persist dedup so we skip this market+outcome on restart.
        // The cooldown above uses this._lastProcessedFire (linked to store).
        this._lastProcessedFire.set(key, now);
        // Record fire in the anti-sniper guard so cooldown takes effect.
        if (this.antiSniper && trade.tokenId) {
          this.antiSniper.recordFire(trade.tokenId);
        }
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
    skipped_anti_sniper: number;
    skipped_twap_stale: number;
    skipped_twap_misaligned: number;
    skipped_thin_liquidity: number;
    skipped_negative_edge: number;
    executed: number;
    failed: number;
    skipped_min_size: number;
    conversion_pct: number;
  } {
    const s = this.stats;
    const filtered = s.quorumSkippedThinEdge + s.quorumSkippedStaleMarket;
    // Conversion = executions per quorum fire (the actionable rate).
    // The old metric divided by raw vote events (executed/votesObserved),
    // which always rounds to 0.0% and tells the operator nothing.
    const conversion = s.quorumFired === 0 ? 0 : (s.executed / s.quorumFired) * 100;
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
      skipped_anti_sniper: s.quorumSkippedAntiSniper ?? 0,
      skipped_twap_stale: s.quorumSkippedTwapStale ?? 0,
      skipped_twap_misaligned: s.quorumSkippedTwapMisaligned ?? 0,
      skipped_thin_liquidity: s.quorumSkippedThinLiquidity ?? 0,
      skipped_negative_edge: s.quorumSkippedNegativeEdge ?? 0,
      skipped_min_size: s.quorumSkippedMinSize ?? 0,
      executed: s.executed,
      failed: s.failed,
      conversion_pct: Math.round(conversion * 100) / 100,
    };
    const edgeStats = signalAuditStore.getStats();
    // Compact anti-sniper reason breakdown, e.g. "no_mid_observations:1200/mid_unstable:300"
    const reasons = Object.entries(s.antiSniperReasons ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join('/');
    console.log(
      `[BasketQuorum${label ? ':' + label : ''}] funnel: ` +
        `observed=${funnel.observed} ` +
        `filtered=${funnel.filtered}(thin=${funnel.filtered_thin},stale=${funnel.filtered_stale}) ` +
        `fired=${funnel.quorum_fired} ` +
        `risk=${funnel.skipped_risk} bankroll=${funnel.skipped_bankroll} ` +
        `drift=${funnel.skipped_drift} cooldown=${funnel.skipped_cooldown} ` +
        `antiSniper=${funnel.skipped_anti_sniper}${reasons ? `(${reasons})` : ''} ` +
        `twap=${funnel.skipped_twap_stale}/${funnel.skipped_twap_misaligned} ` +
        `liq=${funnel.skipped_thin_liquidity} negEdge=${funnel.skipped_negative_edge} ` +
        `minSize=${funnel.skipped_min_size} ` +
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
    this.nearMissLogAt.clear();
    this._lastProcessedFire.clear();
    this.basketSpend.clear();
    this.walletTierMap.clear();
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
      quorumSkippedRestartDedup: 0,
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
   * Delegate to SignalAuditStore — all fired-but-unsettled conditionIds.
   * Used by GammaResolutionPoller to batch-check resolutions.
   */
  getUnsettledConditionIds(): string[] {
    return signalAuditStore.getUnsettledConditionIds();
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

  /**
   * Handle a market_resolved event from the realtime feed.
   *
   * Completes the audit loop that was previously dead code:
   *   market_resolved → recordResolution() → SignalAuditStore.recordSettlement()
   *                   → basket winRate EMA update
   *                   → risk.recordTrade() for each fired signal on this market
   *
   * After this is wired, [edge] shows realized vs expected edge and [risk]
   * shows real daily/monthly P&L and streaks.
   *
   * @param conditionId  the resolving market's condition id
   * @param winningOutcome  outcome name that won ('Yes'/'No' etc.)
   * @param outcomePrices  final prices per outcome from Gamma (index-aligned
   *                       with outcome names); used to determine 0|1 resolution
   */
  handleMarketResolved(
    conditionId: string,
    winningOutcome?: string,
    outcomePrices?: number[],
  ): void {
    // Determine resolution per-signal: a signal on the winning outcome
    // resolves 1; a signal on the losing outcome resolves 0.
    // `winningOutcome` (outcome name) is authoritative when provided;
    // outcomePrices fallback: price→1 means that outcome won (binary markets).
    const signals = signalAuditStore.getSignalsByCondition(conditionId);
    if (signals.length === 0) return;

    // 1. Settle each signal with its own resolved value + update the
    //    owning basket's rolling win rate (EMA, α=0.1 — same math as
    //    recordResolution but per-signal outcome aware).
    const ALPHA = 0.1;
    let anySettled = false;
    for (const sig of signals) {
      if (sig.settledAt !== undefined) continue; // already settled
      let sigResolved: 0 | 1;
      if (winningOutcome) {
        sigResolved = sig.outcome === winningOutcome ? 1 : 0;
      } else if (outcomePrices && outcomePrices.length >= 2) {
        // Binary fallback: if outcomePrices[0] >= 0.99 the first outcome won.
        sigResolved = outcomePrices[0] >= 0.99 ? 1 : 0;
      } else {
        // No way to determine the winner — leave unsettled.
        continue;
      }
      signalAuditStore.recordBacktestSettlement(sig.id, sigResolved);
      anySettled = true;

      // Basket win-rate EMA on the basket the signal actually fired from.
      const basket = this.baskets.get(sig.basket as MarketCategory);
      if (basket && basket.enabled) {
        basket.winRate = basket.winRate * (1 - ALPHA) + (sigResolved === 1 ? 1 : 0) * ALPHA;
      }
    }
    if (!anySettled) return;

    // 2. Feed settled P&L into the RiskManager — one recordTrade per newly
    //    settled signal. P&L per share (BUY): won → 1 - price; lost → -price.
    //    Also release the position's USDC cost from the owning basket's
    //    basketSpend — settled capital returns to the basket's slice, so a
    //    basket that trades and settles keeps rotating instead of locking
    //    up permanently (the 1149 bankroll blocks in the 16h audit).
    for (const sig of signals) {
      if (sig.settledAt === undefined) continue;
      const won = sig.resolved === 1;
      const perShare = won ? (1 - sig.pricePaid) : -sig.pricePaid;
      this.recordSettledTrade(perShare * sig.size, sig.settledAt, sig.side);

      // Release the entry cost (cost basis = pricePaid × size) from basketSpend.
      // Only for BUY-side signals — SELL signals never consumed slice budget.
      if (sig.side === 'BUY') {
        const basket = this.baskets.get(sig.basket as MarketCategory);
        if (basket) {
          const costBasis = sig.pricePaid * sig.size;
          const spent = this.basketSpend.get(basket.category) ?? 0;
          this.basketSpend.set(basket.category, Math.max(0, spent - costBasis));
        }
      }
    }
  }
}

