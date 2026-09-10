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
import { shortError } from '../utils/http-client.js';
import { ChainlinkTwapOracle, type CryptoSymbol, type TwapSignalEvaluation } from './chainlink-twap-oracle.js';
import { bucket15m } from './market-snapshot-store.js';
import { quantizeBuyPrice, roundAmount, roundSize, tickSizeToEnum } from '../utils/price-utils.js';
import type { ConsensusSignal, WalletAction, PipelineDecision, LedgerRecord, RejectReason } from './pipeline-types.js';
import { DecisionLedger } from './decision-ledger.js';
import { ExecutionEngine } from './execution-engine.js';
import { CopyPlanner, type CopyBook, type MarketMeta } from './copy-planner.js';
import { PositionStateMachine, evaluateExit } from './position-state-machine.js';
import { clusterOf, effectiveContributors, isDiverse, type WalletActionCategory } from './independence-metrics.js';
import { evaluateConsensusGate, computeWeightedConsensus, computeDominantWalletShare, bayesianConfidence, computeConflictPenalty, classifyMarketRegime } from './quorum-quality.js';
import { computeEntryQualityScore, resolveEdgeSizeMultiplier, applyRiskAdjustedAmount, shouldPostEntryInvalidate } from './execution-quality.js';
import { checkExposure, type BasketRiskConfig } from './basket-risk.js';
function consensusStrength(votes: Map<string, Vote>): number {
  const buys = [...votes.values()].filter(v => v.side === 'BUY');
  const total = buys.reduce((sum, v) => sum + Math.max(0, v.size * v.price), 0);
  return total > 0 ? buys.reduce((sum, v) => sum + Math.max(0, v.size * v.price), 0) / total : 0;
}
function buyWeight(actions: WalletActionCategory[], votes: Map<string, Vote>): number {
  return actions.reduce((sum, a) => { const v = votes.get(a.wallet); return sum + (v ? Math.max(0, v.size * v.price) : 0); }, 0);
}
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
  /**
   * Entry-price ceiling (0-1) shared by engine + planner: consensus above
   * this is rejected (asymmetry guard; default 0.85). Env-tunable via
   * BASKET_MAX_ENTRY_PRICE in bot-config.
   */
  maxEntryPrice?: number;
  /**
   * Feed-freshness halt: when the newest processed feed event is older than
   * this many ms, copy decisions are skipped (feed_stale) instead of acting
   * on stale consensus. 0 = disabled (default). P1 lens #5.
   */
  maxFeedAgeMs?: number;
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
interface QuorumSignal extends ConsensusSignal {}
export interface QuorumStats {
  /** Raw trade events received by the quorum handler. */
  feedReceived: number;
  /** Events discarded before basket membership/vote processing. */
  ignoredNoBasket: number;
  ignoredNotMember: number;
  ignoredUnsupportedSide: number;
  ignoredInvalidMarket: number;
  /** Trades dropped by the domain kill-switch (BASKET_DISABLED_CATEGORIES). */
  ignoredDisabledDomain?: number;
  /** Votes that survived pre-vote filters and were recorded. */
  votesRecorded: number;
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
  quorumSkippedCoherence?: number;
  quorumSkippedWeighted?: number;
  quorumSkippedDominant?: number;
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
  /** Exit pass could not price a position because the live book was unavailable/empty. */
  exitLiquidityBlocked?: number;
  /** Breakdown of anti-sniper block reasons (no_mid_observations, mid_jump, ...) */
  antiSniperReasons?: Record<string, number>;
  executed: number;
  failed: number;
  quorumNearMissIndependence?: number;
  quorumNearMissExecution?: number;
  quorumNearMissConsensus?: number;
  /** Quorum reached but the market failed the quality gate (lens #1/#3). */
  quorumNearMissQuality?: number;
  /** Execution blocked by the market-quality gate (thin/churning). */
  quorumSkippedQuality?: number;
  /** Consensus quote stale at execution (fail-closed stale-quote cancellation). */
  quorumSkippedStaleQuote?: number;
  /** Feed older than maxFeedAgeMs — copy decisions halted on staleness. */
  quorumSkippedFeedStale?: number;
  shadowSignals?: number;
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
  // Confidence maps (populated in seed()): per-wallet CopyScore→reliability and
  // per wallet:category winRate for the planner's fairProb. Rebuilt on re-seed.
  private walletReliability = new Map<string, number>();
  private walletCategoryWinRate = new Map<string, number>();
  /** conditionId:outcome -> last computed vote-cluster HHI (0-1, 1 = one wallet). */
  private lastVoteHHI = new Map<string, number>();
  // Feed-burst detector state (L10 pressure valve): events in the current
  // minute + last burst warning time.
  private _feedEventsThisMinute = 0;
  /** unix ms of the newest processed feed event — feed-lag observability. */
  private _lastFeedEventAt = Date.now();
  private _feedMinuteStart = 0;
  private _lastFeedBurstLogAt = 0;
  private walletTierMap = new Map<string, 'PRIMARY' | 'SATELLITE'>();
  /** conditionId:outcome -> last fired timestamp (cooldown/one-shot) */
  private lastFired = new Map<string, number>();
  /** tokenId -> freshest live mid observation {price, ts} fed via observeMid(). */
  private liveMid = new Map<string, { price: number; ts: number }>();
  /** conditionId:outcome -> last near-miss diagnostic log timestamp */
  private nearMissLogAt = new Map<string, number>();
  /** Resolved min interval between near-miss logs (config default 5 min). */
  private nearMissLogIntervalMs: number;
  /** Local ref to stateStore.lastProcessedFire — set in setStateStore() */
  private _lastProcessedFire = new Map<string, number>();
  private stats: QuorumStats = {
    feedReceived: 0,
    ignoredNoBasket: 0,
    ignoredNotMember: 0,
    ignoredUnsupportedSide: 0,
    ignoredInvalidMarket: 0,
    votesRecorded: 0,
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
  /** Optional BotMetrics — when set, parallel Prometheus histograms are fed. */
    private botMetrics: import('./bot-metrics.js').BotMetrics | null = null;
    /** P1 lens #1/#3: market-quality tracker (chop, spread, depth gates). */
    private marketQuality: import('./market-quality.js').MarketQualityTracker | null = null;
    /** P1 lens #4: bucketed feature-snapshot store (replay/gating input). */
    private marketSnapshots: import('./market-snapshot-store.js').MarketSnapshotStore | null = null;
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
  /** Anti-honeypot: per-conditionId 24h volume + liquidity, 10-min TTL. */
  private marketVolumeCache = new Map<string, { vol: number; liq: number; ts: number }>();
  /** Fetch+cache real 24h volume/liquidity for a market (Gamma), for the
   *  anti-honeypot floor and truthful feature snapshots. Null on failure. */
  private async marketVolume24hFor(conditionId: string): Promise<{ volume24hr: number; liquidity: number } | null> {
    const cached = this.marketVolumeCache.get(conditionId);
    if (cached && Date.now() - cached.ts < 10 * 60_000) return { volume24hr: cached.vol, liquidity: cached.liq };
    if (!this.gammaApi) return null;
    try {
      const markets = await this.gammaApi.getMarkets({ conditionId });
      const m = markets?.[0];
      if (!m) return null;
      const vol = Number(m.volume24hr ?? m.volume ?? 0);
      const liq = Number(m.liquidity ?? 0);
      this.marketVolumeCache.set(conditionId, { vol, liq, ts: Date.now() });
      return { volume24hr: vol, liquidity: liq };
    } catch {
      return null;
    }
  }
  /** Per-conditionId tick size cache. */
  private tickSizeCache: Map<string, number> = new Map();
  /** Per-conditionId last TWAP evaluation result (debug + audit). */
  private lastTwapEval: Map<string, TwapSignalEvaluation> = new Map();
  /** Parallel write timestamps for fee/tick/TWAP caches (1h prune TTLs). */
  private feeRateCacheTs = new Map<string, number>();
  private tickSizeCacheTs = new Map<string, number>();
  private lastTwapEvalTs = new Map<string, number>();
  /** Trade counter driving the amortized pruneStaleState() cadence. */
  private _pruneTradeCount = 0;
  /** Append-only point-in-time decision ledger (confidence-aware phase 1). */
  private ledger: DecisionLedger | null = null;
  private ledgerSeq = 0;
  private ledgerNextId(): string { return `dec-${Date.now()}-${++this.ledgerSeq}`; }
  /** Wire the append-only DecisionLedger; without it, funnel still counts. */
  setDecisionLedger(ledger: DecisionLedger | null): void {
    this.ledger = ledger;
  }
  /** Write one point-in-time decision record; ledger failures never throw. */
  private async recordDecision(record: Omit<LedgerRecord, 'id'>): Promise<void> {
    try {
      await this.ledger?.append({ id: this.ledgerNextId(), ...record } as LedgerRecord);
    } catch { /* observability must never break trading */ }
  }
  /** Synchronous fire-and-forget wrapper for call sites that must not await. */
  private planDecision(record: Omit<LedgerRecord, 'id'>): void {
    void this.recordDecision(record);
  }
  private ledgerDecision(trade: SmartMoneyTrade, stage: string, accepted: boolean, rejectionReason?: string, outcomeOverride?: string): Omit<LedgerRecord, 'id'> {
    const now = Date.now();
    const marketSlug = trade.marketSlug ?? '';
    return { wallet: trade.traderAddress.toLowerCase(), conditionId: trade.conditionId ?? '', marketSlug, tokenId: trade.tokenId, outcome: outcomeOverride ?? trade.outcome ?? '', side: trade.side, price: trade.price, size: trade.size, tradeTimestamp: trade.timestamp, discoveredAt: trade.timestamp, decidedAt: now, ageMs: Math.max(0, now - trade.timestamp), domain: categorizeMarket(marketSlug), tier: this.walletTierMap.get(trade.traderAddress.toLowerCase()) ?? 'SATELLITE', rejectionReason, accepted, stage };
  }
  /** Per-category specialization thresholds used by seed() to decide which
   * basket(s) a wallet joins. Mirrors WalletScreeningConfig so both gates
   * enforce the same bar.
   */
  private specMinCategoryTrades = 12;
  private specMinCategoryWinRate = 0.58;
  private independenceSettings?: { maxHHI: number; minNEffective: number; clusterThreshold: number; consensusStrengthPrimary?: number; consensusStrengthSatellite?: number; capPerWallet: number; };
  private basketRiskConfig?: BasketRiskConfig;
  private paperExploration = false;
  setIndependenceSettings(settings: { maxHHI: number; minNEffective: number; clusterThreshold?: number; consensusStrengthPrimary?: number; consensusStrengthSatellite?: number; capPerWallet?: number }): void {
    this.independenceSettings = { clusterThreshold: 0.7, capPerWallet: 100, ...settings };
  }
  setBasketRiskConfig(config: BasketRiskConfig): void { this.basketRiskConfig = config; }
  setPaperExplorationMode(enabled: boolean): void { this.paperExploration = enabled; }
  /**
   * Wire a RiskManager so the quorum gate respects trading halts and
   * dynamic sizing. Optional — without it, no risk enforcement.
   */
  setRiskManager(risk: RiskManager): void {
    this.riskManager = risk;
  }
  /**
   * Optional hook to a BotMetrics instance — when set, the funnel
   * log path also feeds the per-snapshot counters, and position
   * events observe entry-price / PnL / hold-duration histograms.
   * The funnel log line itself stays unchanged; this is purely a
   * parallel metrics surface.
   */
  setBotMetrics(metrics: import('./bot-metrics.js').BotMetrics | null): void {
      this.botMetrics = metrics;
    }
    /**
     * Wire the market-quality tracker (lens #1/#3): chop-based size modifier,
     * spread/depth gates, freshness floors before execution. Optional.
     */
    setMarketQuality(tracker: import('./market-quality.js').MarketQualityTracker | null): void {
      this.marketQuality = tracker;
    }
    /**
     * Wire the bucketed feature-snapshot store (lens #4): per-15min-bucket
     * probability/spread/depth/chop snapshots persisted for replay + gating.
     */
    setMarketSnapshots(store: import('./market-snapshot-store.js').MarketSnapshotStore | null): void {
      this.marketSnapshots = store;
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
    // Keep a live mid snapshot with timestamp for the drift check, so a
    // market that moved between votes is caught even if the vote fill
    // prices look flat (fix: drift used the last vote's fill price).
    this.liveMid.set(tokenId, { price: mid, ts: Date.now() });
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
                  // Gamma metadata lookup is used only as a "market exists" check.
                  const markets = await this.gammaApi!.getMarkets({
                    conditionId: signal.conditionId,
                  });
                  if (!markets || markets.length === 0) {
                    console.log(`[BasketQuorum][${label}] ${id}: market not found`);
                    return;
                  }
                  // Gamma's lastTradePrice/bestBid becomes a stale/terminal value after
                  // resolution (audit showed unrelated markets all reporting 0.040).
                  // Prefer the live CLOB book for follow-up telemetry; never turn a
                  // missing quote into a fake zero price or a false unfavorable result.
                  let currentPrice: number | null = null;
                  if (signal.tokenId) {
                    const book = await this.tradingService.getPublicOrderBook(signal.tokenId);
                    if (book && book.bids.length > 0 && book.asks.length > 0) {
                      const bestBid = Math.max(...book.bids.map((l) => parseFloat(l.price)));
                      const bestAsk = Math.min(...book.asks.map((l) => parseFloat(l.price)));
                      if (bestBid > 0 && bestAsk > 0) currentPrice = (bestBid + bestAsk) / 2;
                    }
                  }
                  if (currentPrice === null) {
                    console.log(`[BasketQuorum][${label}] ${signal.marketSlug}: live CLOB quote unavailable`);
                    return;
                  }
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
          console.warn(`[BasketQuorum][${label}] ${id}: price check failed: ${shortError(err)}`);
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
      // No per-category proof (bypassed / manual / thin data) — but don't
      // dump unresolved wallets into the `other` basket as a default. Only
      // add the resolved category when the wallet actually has data for it
      // OR it's a manual/bypassed override. Previously this caught all
      // unclassified wallets (144/168 in the 09-08 audit) and inflated
      // `other` into a junk drawer.
      if (cats.size === 0 && w.bypassed && w.category !== 'other') {
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
      // Confidence signals for the execution layer: per-wallet CopyScore
      // (0-100 → 0-1) becomes the planner's `reliability`, and per-category
      // winRate becomes the wallet-calibrated probability for the category
      // basket's fairProb blend. Before this, the planner call hardcoded
      // reliability/executionConfidence/independenceAdjustment = 1, so the
      // entire Phase-2/3 confidence layer never touched an execution decision.
      this.walletReliability.set(w.address.toLowerCase(), Math.max(0, Math.min(1, w.copyScore / 100)));
      this.walletCategoryWinRate.set(`${w.address.toLowerCase()}:${w.category}`, Math.max(0, Math.min(1, w.winRate)));
    }
    // Rebuild baskets Map using existing config defaults.
    // FIRST seed only: baskets were empty before, so there is no prior state
    // to preserve — drop votes/dedup/cooldown/spend. On REFRESH seeds (the
    // periodic wallet re-screen) baskets already exist: swap the wallet lists
    // WITHOUT touching _lastProcessedFire/lastFired, or an already-executed
    // market would re-fire after every 6h refresh (double-execution bug).
    const firstSeed = this.baskets.size === 0;
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
    // Drop prior vote state ONLY on the first seed (see firstSeed above).
    // (walletTierMap was already cleared at the top of seed(); do NOT clear
    // it here or the tiers populated above are wiped — the PRIMARY=0 bug.)
    if (firstSeed) {
      this.votes.clear();
      this.lastFired.clear();
      this.nearMissLogAt.clear();
      this._lastProcessedFire.clear();
      this.basketSpend.clear();
    }
    this._schedulePersist();
    const summary = [...byCategory.entries()]
      .map(([c, ws]) => c + '=' + ws.length)
      .join(', ');
    // Unresolved wallet breakdown (audit 09-08: 144/168 wallets used to land
    // in `other` because the seed-loop fell back to resolved cat for
    // everything. Now `other` is reached only via categoryWinRates.other, so
    // the count here reflects genuine unclassified wallets — not a junk
    // drawer. Track distinct categories and primaryCategory distribution.
    const uniqueByPrimary = new Map<MarketCategory, number>();
    for (const w of eligible) {
      const cats = new Set<MarketCategory>();
      for (const cat of Object.keys(w.categoryWinRates) as MarketCategory[]) {
        if (qualifiesFor(w, cat)) cats.add(cat);
      }
      const primary = cats.size > 0 ? [...cats][0] : (w.bypassed ? w.category : 'other');
      uniqueByPrimary.set(primary, (uniqueByPrimary.get(primary) ?? 0) + 1);
    }
    const primarySummary = [...uniqueByPrimary.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => c + '=' + n)
      .join(', ');
    console.log(
      `[BasketQuorum] seeded ${eligible.length} wallets across ` +
      `${byCategory.size} baskets: ${summary} ` +
      `(inferred: ${inferredCount}, fallback-to-other: ${otherCount}, multi-basket: ${multiBasket})`
    );
    console.log(
      `[BasketQuorum] primary-category distribution: ${primarySummary} ` +
      `(total ${eligible.length}; wallets with zero qualified categories: ` +
      `${eligible.length - [...uniqueByPrimary.values()].reduce((a, b) => a + b, 0)})`
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
  private normalizeAction(trade: SmartMoneyTrade): PipelineDecision<WalletAction> {
    if (!trade.conditionId || !trade.marketSlug || !trade.outcome) return { accepted: false, reason: 'invalid_market' };
    let outcome = trade.outcome;
    let price = trade.price;
    let side = trade.side;
    if (side === 'SELL') {
      const lower = outcome.toLowerCase();
      if (lower === 'yes') outcome = 'No';
      else if (lower === 'no') outcome = 'Yes';
      else return { accepted: false, reason: 'unsupported_side' };
      price = 1 - price;
      side = 'BUY';
    }
    const category = categorizeMarket(trade.marketSlug);
    const basket = this.baskets.get(category);
    if (!basket) return { accepted: false, reason: 'no_basket' };
    const wallet = trade.traderAddress.toLowerCase();
    if (!basket.wallets.includes(wallet)) return { accepted: false, reason: 'not_member' };
    return { accepted: true, value: { wallet, tier: this.walletTierMap.get(wallet) ?? 'SATELLITE', category, conditionId: trade.conditionId, marketSlug: trade.marketSlug, outcome, side, price, size: trade.size, timestamp: trade.timestamp } };
  }
  onTrade(trade: SmartMoneyTrade): void {
    // Count every raw incoming trade exactly once.
    this.stats.feedReceived++
    if (trade.timestamp) this._lastFeedEventAt = Math.max(this._lastFeedEventAt, trade.timestamp);
    // Feed-burst window counter (resets each minute; consumed by the L10
    // staleness pressure valve below).
    if (Date.now() - this._feedMinuteStart > 60_000) {
      this._feedMinuteStart = Date.now();
      this._feedEventsThisMinute = 0;
    }
    this._feedEventsThisMinute++;
    // We can't build a consensus key without a market; skip.
    const conditionId = trade.conditionId;
    const marketSlug = trade.marketSlug;
    const outcome = trade.outcome;
    if (!conditionId || !marketSlug || !outcome) {
      this.stats.ignoredInvalidMarket++;
      this.planDecision(this.ledgerDecision(trade, 'pre_vote', false, 'invalid_market'));
      return;
    }
    this.stats.feedReceived++;
    const normalized = this.normalizeAction(trade);
    if (!normalized.accepted) {
      if (normalized.reason === 'invalid_market') this.stats.ignoredInvalidMarket++;
      else if (normalized.reason === 'unsupported_side') this.stats.ignoredUnsupportedSide++;
      else if (normalized.reason === 'no_basket') this.stats.ignoredNoBasket++;
      else if (normalized.reason === 'not_member') this.stats.ignoredNotMember++;
      this.planDecision(this.ledgerDecision(trade, 'pre_vote', false, normalized.reason));
      return;
    }
    // A SELL from a tracked wallet is a vote for the opposite binary outcome.
    // Normalize it before recording so reverse-quorum logic can see flips.
    let voteOutcome = outcome;
    let votePrice = trade.price;
    let voteSide: 'BUY' | 'SELL' = trade.side;
    if (trade.side === 'SELL') {
      const lower = outcome.toLowerCase();
      if (lower === 'yes') voteOutcome = 'No';
      else if (lower === 'no') voteOutcome = 'Yes';
      else {
        this.stats.ignoredUnsupportedSide++;
        this.planDecision(this.ledgerDecision(trade, 'pre_vote', false, 'unsupported_side'));
        return; // Do not guess the opposite of a non-binary label.
      }
      votePrice = 1 - trade.price;
      voteSide = 'BUY';
    }
    this._pruneTradeCount++;
    if (this._pruneTradeCount % 100 === 0) this.pruneStaleState();
    // L10: bounded staleness gate (qualiaenjoyer/polymarket-apis pattern).
    // A backpressured handler queue must not turn old fills into fresh
    // signals — a vote older than 2× the basket window is dropped, not
    // processed. This bounds worst-case signal age.
    const nowTs = Date.now();
    const cat0 = categorizeMarket(marketSlug);
    const window = this.windowMs(cat0);
    // Backfill burst detector: the smart-money feed replays history after
    // reconnects (audit 09-06: +156k received in 5min, all stale). During a
    // burst (>5000 events/min), tighten from 2× to 0.33× the window and log
    // once per burst so replay floods are visible instead of silent.
    if (nowTs - this._lastFeedBurstLogAt > 60_000 && this._feedEventsThisMinute > 5000) {
      console.warn(`[BasketQuorum] feed backfill burst: ${this._feedEventsThisMinute} events/min — tightening staleness gate to 1/3 window`);
      this._lastFeedBurstLogAt = nowTs;
    }
    const staleMultiplier = this._feedEventsThisMinute > 5000 ? 0.33 : 2;
    if (trade.timestamp && nowTs - trade.timestamp > staleMultiplier * window) {
      this.stats.quorumSkippedStaleMarket = (this.stats.quorumSkippedStaleMarket ?? 0) + 1;
      this.planDecision(this.ledgerDecision(trade, 'pre_vote', false, 'stale'));
      return;
    }
    // 1. Determine the governing basket by the market's category.
    //    We classify on the slug (words are in slugs, e.g. "will-btc-hit-100k").
    const category = categorizeMarket(marketSlug || outcome || '');
    const basket = this.baskets.get(category);
    if (!basket) {
      this.stats.ignoredNoBasket++;
      this.planDecision(this.ledgerDecision(trade, 'pre_vote', false, 'no_basket'));
      return;
    }
    // 1b. Domain kill-switch: operator can disable a category via env
    //    (BASKET_DISABLED_CATEGORIES="tennis,itf" comma list). The audit
    //    (09-07) showed thin tennis/ITF books produced the day's worst
    //    outcomes (entries 0.85→0.04); disabling beats parameter-tuning
    //    a structurally losing domain. Match on slug substrings too, since
    //    categorizeMarket may not isolate "atp-"/"itf-" prefixed slugs.
    const rawDisabled = (process.env.BASKET_DISABLED_CATEGORIES ?? '').toLowerCase();
    if (rawDisabled) {
      const tokens = rawDisabled.split(',').map((t) => t.trim()).filter(Boolean);
      const slug = (marketSlug ?? '').toLowerCase();
      const hit = tokens.some((t) => category === t || slug.includes(t));
      if (hit) {
        this.stats.ignoredDisabledDomain = (this.stats.ignoredDisabledDomain ?? 0) + 1;
        this.planDecision(this.ledgerDecision(trade, 'pre_vote', false, 'domain_disabled'));
        return;
      }
    }
    // 2. Only count wallets that are members of this basket.
    const traderKey = trade.traderAddress.toLowerCase();
    if (!basket.wallets.includes(traderKey)) {
      // PAPER-FIRE WINDOW (fork a): in DRY_RUN with PAPER_BROADEN_MEMBERSHIP,
      // any screened-eligible wallet (PRIMARY/SATELLITE tier) counts toward
      // quorum even when not seeded into this basket's wallet list. This lets
      // consensus actually form in paper mode so the downstream pipeline
      // (ceiling, quality gate, follow-ups, settlement) gets exercised and
      // shows real behavior — instead of fired=0 forever.
      const paperBroaden = this.paperExploration &&
        process.env.PAPER_BROADEN_MEMBERSHIP === 'true' &&
        this.walletTierMap.has(traderKey);
      if (!paperBroaden) {
        this.stats.ignoredNotMember++;
        this.planDecision(this.ledgerDecision(trade, 'pre_vote', false, 'not_member'));
        return;
      }
    }
    // 3. Only BUY votes contribute to a buy-consensus we act on. (SELL votes
    //    are recorded but not counted toward firing, so we can see counter-flow.)
    // SELL votes were normalized above; unsupported labels returned early.
    const now = Date.now();
    // Reverse-flow tracking (exit side): any basket-member fill that is either
    // a SELL or a BUY on some outcome — recorded per conditionId+wallet with a
    // timestamp so _countReverseQuorum can detect post-entry flips even after
    // the vote maps prune. A SELL by a quorum wallet on our outcome, or a BUY
    // by a quorum wallet on the opposite outcome, is the same information event.
    for (const [tokenId, p] of this.openPositions) {
      if (p.conditionId !== conditionId) continue;
      if (!p.quorumWallets?.includes(traderKey)) continue;
      const isOppositeBuy = voteSide === 'BUY' && voteOutcome !== p.outcome;
      const isSameSell = voteSide === 'SELL' && voteOutcome === p.outcome;
      if (isOppositeBuy || isSameSell) {
        this._reverseFills.set(`${conditionId}:${traderKey}`, { conditionId, wallet: traderKey, ts: now });
      }
    }
    // 4. Prune stale votes in THIS market/outcome (rolling window).
    const outcomeVotes = this.getVoteMap(conditionId, voteOutcome);
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
      this.planDecision(this.ledgerDecision(trade, 'pre_vote', false, 'thin'));
      return;
    }
    if (this._isMarketStale(trade)) {
      this.stats.quorumSkippedStaleMarket = (this.stats.quorumSkippedStaleMarket ?? 0) + 1;
      this.planDecision(this.ledgerDecision(trade, 'pre_vote', false, 'stale'));
      return;
    }
    // 6. Record the vote — one vote per wallet per outcome.
    const walletTier = this.walletTierMap.get(traderKey) ?? 'SATELLITE';
    outcomeVotes.set(traderKey, {
      wallet: traderKey,
      side: voteSide,
      price: votePrice,
      size: trade.size,
      timestamp: now,
      tier: walletTier,
    });
    this.stats.voters = this.votes.size;
    this.stats.votesRecorded++
    this.planDecision(this.ledgerDecision({ ...trade, outcome: voteOutcome, price: votePrice, side: voteSide }, 'vote_recorded', true, undefined, voteOutcome));
    this._schedulePersist();
    // 7. Evaluate quorum.
    this.tryFire({ ...trade, conditionId, marketSlug, outcome: voteOutcome, side: voteSide, price: votePrice }, basket, outcomeVotes);
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
    // resolution date. Three formats seen in prod:
    //   1. weather:  'highest-temperature-in-nyc-on-march-15-2026'
    //   2. crypto:   'eth-updown-5m-1788454500' (trailing unix epoch)
    //   3. sports:   'lol-ig1-we-2026-09-06' (ISO date, no epoch suffix).
    // (3) was previously UNMATCHED — finished esports/soccer games lingered
    // as fresh votes until the L10 timestamp gate caught their replays.
    const haystack = (trade.marketSlug ?? '').toLowerCase();
    // ISO date anywhere in the slug: 'YYYY-MM-DD'. Market day ends 23:59:59 UTC.
    const iso = haystack.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) {
      const expiry = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3], 23, 59, 59));
      if (Number.isFinite(expiry.getTime()) && expiry.getTime() < Date.now()) return true;
      // Future-dated ISO slug: not stale.
      return false;
    }
    // Trailing epoch: 10-digit seconds or 13-digit ms.
    const epoch = haystack.match(/-(\d{10,})$/);
    if (epoch) {
      const expiry = Number(epoch[1]) * (epoch[1].length >= 13 ? 1 : 1000);
      return Number.isFinite(expiry) && expiry < Date.now();
    }
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
  /**
   * L4/L1 helper: infer market end time (ms epoch) from the slug.
   * Handles the crypto up/down slug scheme 'xxx-updown-5m-<unix>' where
   * <unix> is the window END in seconds. Returns null when the slug
   * carries no parseable expiry (weather/politics/etc — EARLY rules apply).
   */
  private _inferMarketEndMs(slug: string | undefined): number | null {
    if (!slug) return null;
    const m = slug.match(/-updown-(\d+[mh])-ls(\d+)$/)      // btc-updown-5m-ls1738102200
      ?? slug.match(/-updown-(\d+[mh])-(\d{10})$/)          // eth-updown-5m-1788454500
      ?? slug.match(/-(\d{10})$/);                          // generic trailing unix
    if (!m) return null;
    const unix = parseInt(m[m.length - 1], 10);
    if (!Number.isFinite(unix) || unix < 1_600_000_000) return null;
    return unix * 1000;
  }
  // ==========================================================================
  // L1: Exit ladder (KaustubhPatange/polymarket-trade-engine simulation.ts)
  //     - Late-TP: any open position whose market price >= 0.96 is sold
  //     - Emergency: within 30s of expiry, force-sell at best bid
  //     Exits run on a 15s interval over openPositions (tokenId -> cost).
  // ==========================================================================
  /** Open copy positions: tokenId -> entry state + quorum linkage. */
  private openPositions: Map<string, {
    usdc: number; size: number; entryPrice: number;
    marketSlug: string; outcome: string; firedAt: number;
    conditionId: string; basketName: string; basketCategory: MarketCategory;
    signalId?: string; quorumWallets?: string[];
  }> = new Map();
  private exitTimer: ReturnType<typeof setInterval> | null = null;
  /** Replacement exit layer: position lifecycle state machine. */
  private readonly posMachine = new PositionStateMachine();
  /** P0-7: copy decisions stay blocked until startup reconciliation succeeds. */
  private reconciled = false;
  /** P0-5: called with the current open-position records whenever they change. */
  onPositionsSnapshot?: (records: unknown[]) => void;

  /** P0-7: gate copy decisions on startup reconciliation success. */
  setReconciled(ok: boolean): void {
    this.reconciled = ok;
    if (!ok) console.warn('[BasketQuorum] RECONCILIATION PENDING — copy decisions blocked');
    else console.log('[BasketQuorum] reconciliation OK — copy decisions enabled');
  }

  isReconciled(): boolean { return this.reconciled; }

  /**
   * Serialize open copy positions for durable restore (P0-5). Each record
   * carries everything trackOpenPosition needs to resume the lifecycle.
   */
  getOpenPositionRecords(): Array<{
    tokenId: string; usdc: number; size: number; entryPrice: number;
    marketSlug: string; outcome: string; conditionId: string;
    basketName: string; basketCategory: MarketCategory;
    signalId?: string; quorumWallets?: string[];
  }> {
    return [...this.openPositions.entries()].map(([tokenId, p]) => ({ ...p, tokenId }));
  }

  /** Restore open positions from durable records (P0-5) before copying resumes. */
  restoreOpenPositions(records: Array<{
    tokenId: string; usdc: number; size: number; entryPrice: number;
    marketSlug: string; outcome: string; conditionId: string;
    basketName: string; basketCategory: MarketCategory;
    signalId?: string; quorumWallets?: string[];
  }>): number {
    let restored = 0;
    for (const rec of records) {
      if (!rec || typeof rec.tokenId !== 'string' || !(rec.size > 0) || !rec.conditionId) continue;
      try {
        this.trackOpenPosition(rec.tokenId, rec.usdc ?? 0, rec.size, rec.entryPrice, rec.marketSlug, rec.outcome, rec.conditionId, rec.basketName, (rec.basketCategory ?? 'other') as MarketCategory, rec.signalId, rec.quorumWallets);
        restored++;
      } catch (e) {
        console.warn(`[BasketQuorum][restore] failed for ${rec.tokenId}:`, e instanceof Error ? e.message : e);
      }
    }
    if (restored > 0) console.log(`[BasketQuorum][restore] recovered ${restored} open position(s) from durable state`);
    return restored;
  }

  /** Start the exit ladder loop (15s). Idempotent. */
  startExitLadder(): void {
    if (this.exitTimer) return;
    // Items 1–4: one unified pass handles both live and DRY-RUN exits.
    this.exitTimer = setInterval(() => {
      this.runExitPass().catch((err) => {
        console.warn('[BasketQuorum][exit] pass error:', err instanceof Error ? err.message : err);
      });
    }, 15_000);
    console.log(`[BasketQuorum][exit] ladder started (15s interval${this.config.dryRun ? ', DRY-RUN simulation' : ''})`);
  }
  stopExitLadder(): void {
    if (this.exitTimer) {
      clearInterval(this.exitTimer);
      this.exitTimer = null;
    }
  }
  /** Record an executed entry so the exit ladder can manage it. */
  private trackOpenPosition(
    tokenId: string, usdc: number, size: number, entryPrice: number,
    marketSlug: string, outcome: string,
    conditionId: string, basketName: string, basketCategory: MarketCategory,
    signalId?: string, quorumWallets?: string[],
  ): void {
    this.openPositions.set(tokenId, {
      usdc, size, entryPrice, marketSlug, outcome, firedAt: Date.now(),
      conditionId, basketName, basketCategory, signalId, quorumWallets,
    });
    // Replacement exit layer: register the position lifecycle.
    try {
      this.posMachine.open({
        id: tokenId, conditionId, tokenId, outcome, side: 'BUY',
        shares: 0, entryPrice, entryTime: Date.now(), state: 'PLANNED', basket: basketName,
      });
      this.posMachine.apply(tokenId, { type: 'FILL', shares: size, state: 'full' });
    } catch (e) {
      console.warn('[BasketQuorum][exit] posMachine open failed:', e instanceof Error ? e.message : e);
    }
    try { this.onPositionsSnapshot?.(this.getOpenPositionRecords()); } catch { /* non-fatal */ }
  }
  /**
   * Unified exit pass — items 1–5 of the exit rework.
   *
   * Trigger precedence (first match wins):
   *   5. KILL_SWITCH    — basket suspended by PT4: force-exit at market
   *   2. REVERSE_QUORUM — ≥ N quorum wallets flipped to the opposite outcome
   *   3. EDGE_TP        — bestBid ≥ basket.winRate − feeBuffer (converged to
   *                       our own probability estimate; primary TP)
   *   4. LATE_TP        — bestBid ≥ 0.96 (sanity clamp; catches stale winRate)
   *   6. EMERGENCY      — < 30s to expiry: force-sell at best bid
   *
   * LIVE: places a FAK SELL at best bid, records PnL, marks the audit signal
   * exited (so resolution doesn't double-count).
   * DRY-RUN: identical triggers/decisions, no order — logs `exit_simulated`
   * to the JSONL trail so paper measures the strategy we actually run.
   */
  private async runExitPass(): Promise<void> {
    if (this.openPositions.size === 0) return;
    const REVERSE_QUORUM_MIN = 2;      // ≥2 of the entry quorum flipped
    const EMERGENCY_WINDOW_MS = 30_000;
    for (const [tokenId, pos] of [...this.openPositions]) {
      try {
        const endMs = this._inferMarketEndMs(pos.marketSlug);
        const msToEnd = endMs ? endMs - Date.now() : Number.POSITIVE_INFINITY;
        const emergency = msToEnd < EMERGENCY_WINDOW_MS;
        const basket = this.baskets.get(pos.basketCategory);
        const killed = this.riskManager?.isBasketKilled(pos.basketName) ?? false;
        // Book fetch: public endpoint in DRY-RUN (no auth needed),
        // authenticated client otherwise.
        const book = this.config.dryRun
          ? await this.tradingService.getPublicOrderBook(tokenId)
          : await this.tradingService.getOrderBook(tokenId);
        // Fail-open book fetch: previously a missing book silently skipped the
        // exit with no trace, so the audit could not distinguish "no quote to
        // price the exit" from "decided to hold" (audit: 13 positions, zero
        // [exit] lines). Count/log it and record an audit event instead.
        if (!book || book.bids.length === 0) {
          this.stats.exitLiquidityBlocked = (this.stats.exitLiquidityBlocked ?? 0) + 1;
          console.warn(`[BasketQuorum][exit] exit_liquidity_blocked ${pos.marketSlug} (${tokenId}): no live bid`);
          signalAuditStore.appendJsonl('exit_liquidity_blocked', {
            tokenId, conditionId: pos.conditionId, marketSlug: pos.marketSlug,
            entryPrice: pos.entryPrice, firedAt: pos.firedAt, ts: Date.now(),
          });
          continue;
        }
        const bestBid = Math.max(...book.bids.map((l) => parseFloat(l.price)));
        const bestAsk = book.asks.length > 0 ? Math.min(...book.asks.map((l) => parseFloat(l.price))) : bestBid;
        if (bestBid <= 0) continue;
        // --- replacement trigger evaluation (position state machine) -----------
        const feeRateBps = this.feeRateCache.get(tokenId) ?? this.feeRateCache.get(pos.conditionId) ?? 0;
        // Fair settlement probability — blended estimate, NOT the raw live mid
        // (that degenerates the value-exit into spread-width arithmetic: with
        // fairProb = mid, "sell beats hold" reduces to halfSpread < 1.5c − fee,
        // i.e. a −1-tick dump on every tight book, audit 09-07: 8/8 exits −1 tick)
        // and NOT the stale entry winRate (that held collapsing positions to zero).
        // Blend: live mid carries the market's information; the entry thesis
        // (consensus price) carries the quorum's original conviction. The blend
        // decays toward the market as expiry nears (the market knows best late).
        const liveProb = Math.min(0.99, Math.max(0.01, (bestBid + bestAsk) / 2));
        const thesisProb = Math.min(0.99, Math.max(0.01, pos.entryPrice));
        const secondsLeft = endMs ? Math.max(0, Math.floor((endMs - Date.now()) / 1000)) : null;
        // Long horizon (≥60min): 50/50; short horizon (<5min): 90% market.
        const marketWeight = secondsLeft === null ? 0.5 : Math.min(0.9, Math.max(0.5, 0.9 - secondsLeft / 7200));
        const fairProb = marketWeight * liveProb + (1 - marketWeight) * thesisProb;
        const entryPrice = pos.entryPrice;
        const exitDecision = evaluateExit({
          inventoryShares: pos.size,
          entryPrice,
          executableBidVwap: bestBid,
          sellFeePerShare: takerFeePerShare(bestBid, feeRateBps || DEFAULT_FEE_RATE_BPS),
          impactBufferPerShare: 0.005,
          // 2c holding buffer: sell when the executable bid nets above
          // expected settlement value minus capital-lock/oracle risk.
          holdingRiskBufferPerShare: 0.02,
          fairProb,
          bookSpread: Math.max(0, bestAsk - bestBid),
          secondsToExpiry: secondsLeft ?? undefined,
          leaderExit: pos.quorumWallets && pos.quorumWallets.length > 0 && this._countReverseQuorum(pos) >= REVERSE_QUORUM_MIN
            ? { leaderShares: pos.size, confirmed: true }
            : undefined,
          riskHalt: killed || emergency,
        });
        if (exitDecision.action === 'HOLD' || exitDecision.action === 'NO_INVENTORY') continue;
        const reason = (exitDecision.reason ?? 'EXIT').toUpperCase();
        // ------------------------------------------------------------------------
        const sellSize = exitDecision.quantity;
        if (sellSize <= 0) { this.openPositions.delete(tokenId); try { this.onPositionsSnapshot?.(this.getOpenPositionRecords()); } catch { /* non-fatal */ } continue; }
        const pnl = (bestBid - pos.entryPrice) * sellSize;
        if (this.config.dryRun) {
          console.log(
            `[BasketQuorum][exit] DRY RUN ${reason} sell ${pos.marketSlug} ` +
            `${pos.outcome}: entry=${pos.entryPrice.toFixed(3)} bid=${bestBid.toFixed(3)} ` +
            `size=${sellSize.toFixed(1)} pnl=$${pnl.toFixed(2)}`
          );
          signalAuditStore.appendJsonl('exit_simulated', {
            tokenId,
            conditionId: pos.conditionId,
            marketSlug: pos.marketSlug,
            outcome: pos.outcome,
            entryPrice: pos.entryPrice,
            exitPrice: bestBid,
            size: sellSize,
            pnl,
            reason,
            firedAt: pos.firedAt,
          });
        } else {
          console.log(
            `[BasketQuorum][exit] ${reason} sell ${pos.marketSlug} ` +
            `${pos.outcome}: entry=${pos.entryPrice.toFixed(3)} bid=${bestBid.toFixed(3)} ` +
            `size=${sellSize.toFixed(1)}`
          );
          const result = await this.tradingService.createMarketOrder({
            tokenId,
            side: 'SELL',
            amount: sellSize,                 // SELL: amount = shares
            price: bestBid,                   // FAK at best bid (worst-price clamp)
            orderType: 'FAK',
          });
          if (!result.success) {
            console.warn(`[BasketQuorum][exit] sell failed: ${result.errorMsg}`);
            continue;
          }
        }
        // Shared post-exit bookkeeping (both modes).
        try {
          this.posMachine.apply(tokenId, { type: 'EXIT', shares: sellSize, reason: reason.toLowerCase(), time: Date.now() });
          this.posMachine.apply(tokenId, { type: 'FILL', shares: sellSize, state: 'full' });
        } catch (e) {
          console.warn('[BasketQuorum][exit] posMachine exit failed:', e instanceof Error ? e.message : e);
        }
        this.recordSettledTrade(pnl, Date.now(), 'SELL');
        // Feed the Prometheus histogram with hold duration + exit reason.
        if (this.botMetrics && pos.firedAt) {
          this.botMetrics.observeHold({
            category: String(pos.basketCategory ?? 'unknown'),
            exitReason: reason,
            holdSeconds: Math.max(0, (Date.now() - pos.firedAt) / 1000),
          });
        }
        signalAuditStore.markExited(pos.conditionId, bestBid, reason, pos.outcome);
        this.openPositions.delete(tokenId);
        try { this.onPositionsSnapshot?.(this.getOpenPositionRecords()); } catch { /* non-fatal */ }
        // Release the cost basis back to the basket slice (same as resolution).
        const spent = this.basketSpend.get(pos.basketCategory) ?? 0;
        this.basketSpend.set(pos.basketCategory, Math.max(0, spent - pos.usdc));
      } catch (err) {
        console.warn('[BasketQuorum][exit] position error:', err instanceof Error ? err.message : err);
      }
    }
  }
  /**
   * Item 2: count how many of the position's original quorum wallets have
   * since voted BUY on the OPPOSITE outcome of the same market, or SELLed
   * the same outcome (mirror signal, deduped per wallet).
   *
   * Freshness: the vote maps are pruned on the basket window (30min), so a
   * position older than the window would never see reverse votes — the
   * strongest exit signal would be structurally impossible. Reverse fills
   * are therefore also recorded in `_reverseFills` (timestamped, per
   * conditionId+wallet) by onTrade, independent of vote pruning.
   */
  private _reverseFills = new Map<string, { conditionId: string; wallet: string; ts: number }>();

  private _countReverseQuorum(pos: { conditionId: string; outcome: string; quorumWallets?: string[]; firedAt: number }): number {
    if (!pos.quorumWallets || pos.quorumWallets.length === 0) return 0;
    const flipped = new Set<string>();
    for (const wallet of pos.quorumWallets) {
      // 1. Live vote map (fresh window) — opposite-outcome BUY votes.
      for (const [outcomeName, byWallet] of this.votes.get(pos.conditionId) ?? []) {
        if (outcomeName === pos.outcome) continue;
        const vote = byWallet.get(wallet);
        if (vote && vote.side === 'BUY') flipped.add(wallet);
      }
      // 2. Timestamped reverse-fill record (survives vote pruning).
      const rec = this._reverseFills.get(`${pos.conditionId}:${wallet}`);
      if (rec && rec.ts >= pos.firedAt) flipped.add(wallet);
    }
    return flipped.size;
  }
  /** Amortized cleanup for long-running deployments. */
  private pruneStaleState(): void {
    const now = Date.now();
    const maxWindow = Math.max(this.config.defaultWindowMs, ...[...this.baskets.values()].map(b => b.windowMs));
    for (const [conditionId, byOutcome] of this.votes) {
      for (const [outcome, byWallet] of byOutcome) {
        for (const [wallet, vote] of byWallet) {
          if (now - vote.timestamp > maxWindow * 2) byWallet.delete(wallet);
        }
        if (byWallet.size === 0) byOutcome.delete(outcome);
      }
      if (byOutcome.size === 0) this.votes.delete(conditionId);
    }
    const ttl = Math.max(this.config.fireCooldownMs * 6, 60 * 60 * 1000);
    for (const [key, ts] of this.lastFired) if (now - ts > ttl) this.lastFired.delete(key);
    for (const [key, ts] of this.nearMissLogAt) if (now - ts > ttl) this.nearMissLogAt.delete(key);
    for (const [key, ts] of this.feeRateCacheTs) if (now - ts > ttl) { this.feeRateCacheTs.delete(key); this.feeRateCache.delete(key); }
    for (const [key, ts] of this.tickSizeCacheTs) if (now - ts > ttl) { this.tickSizeCacheTs.delete(key); this.tickSizeCache.delete(key); }
    for (const [key, ts] of this.lastTwapEvalTs) if (now - ts > ttl) { this.lastTwapEvalTs.delete(key); this.lastTwapEval.delete(key); }
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
    const rawKey = `${conditionId}:${outcome}`;
    // Scope restart dedup by execution mode: paper fires must never suppress
    // the first live fire after a DRY_RUN -> LIVE switch.
    const key = `${this.config.dryRun ? 'paper' : 'live'}:${rawKey}`;
    // Cooldown: one-shot per market+outcome in the window.
    const last = this.lastFired.get(key) ?? 0;
    if (now - last < this.config.fireCooldownMs) {
      this.stats.quorumSkippedCooldown++;
      this.planDecision(this.ledgerDecision(trade, 'quorum', false, 'cooldown'));
      return;
    }
    // Restart-dedup: if a fire was already executed for this market+outcome
    // AND persisted to VoteStateStore, skip on restart to prevent double-execution.
    if (this._lastProcessedFire.has(key)) {
      this.stats.quorumSkippedRestartDedup++;
      this.planDecision(this.ledgerDecision(trade, 'quorum', false, 'restart_dedup'));
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
        const distinctVoters = new Set(
          [...outcomeVotes.values()]
            .filter((v) => v.side === 'BUY')
            .map((v) => v.wallet),
        ).size;
        const effectiveQuorum = Math.max(1, this.quorumFor(basket.category));
        const quorumReached = tieredFires && distinctVoters >= effectiveQuorum;
        if (quorumReached && this.independenceSettings) {
          const actions: WalletActionCategory[] = [...outcomeVotes.values()].filter(v => v.side === 'BUY').map(v => ({ wallet: v.wallet, marketSlug, conditionId, outcome, side: v.side, timestamp: v.timestamp, size: v.size, price: v.price }));
          const clusters = clusterOf(actions, this.independenceSettings.clusterThreshold);
          const summary = effectiveContributors(clusters, buyWeight(actions, outcomeVotes), this.independenceSettings.capPerWallet);
          const satelliteOnly = primaryCount === 0;
          const limits = { maxHHI: this.independenceSettings.maxHHI, minNEffective: satelliteOnly ? Math.max(3, this.independenceSettings.minNEffective) : this.independenceSettings.minNEffective };
          const strength = consensusStrength(outcomeVotes);
          const minStrength = satelliteOnly ? (this.independenceSettings.consensusStrengthSatellite ?? 0.70) : (this.independenceSettings.consensusStrengthPrimary ?? 0.60);
          // Remember the cluster HHI for the execution layer's independence
          // adjustment (consumed in executeIfInBand's CopyPlanner call).
          this.lastVoteHHI.set(`${conditionId}:${outcome}`, summary.hhi);
          if (!isDiverse(summary.hhi, summary.nEff, limits)) {
            this.stats.quorumNearMissIndependence = (this.stats.quorumNearMissIndependence ?? 0) + 1;
            if (this.paperExploration) this.stats.shadowSignals = (this.stats.shadowSignals ?? 0) + 1;
            return;
          }
          if (strength < minStrength) {
            this.stats.quorumNearMissConsensus = (this.stats.quorumNearMissConsensus ?? 0) + 1;
            if (this.paperExploration) this.stats.shadowSignals = (this.stats.shadowSignals ?? 0) + 1;
            return;
          }
        }
        if (!quorumReached) {
          // Mid subscription: request on EVERY aligned vote, NOT inside the
          // near-miss log gate. The old code only subscribed when the log
          // actually printed (rate-limited to 1/5min), so a market reaching
          // quorum between log windows executed its drift check against the
          // leader's own fill price (fallback) — the gate passed by
          // construction (audit 09-07: 496/533 SKIP-drift markets were never
          // near-missed; 7,882 fallbacks vs 103 fires).
          if (primaryCount + satelliteCount >= 2 && trade.tokenId) {
            if (this.onMidInterest) this.onMidInterest(trade.tokenId);
            // Diagnostic near-miss log — rate-limited separately.
            const lastLog = this.nearMissLogAt.get(key) ?? 0;
            if (now - lastLog >= this.nearMissLogIntervalMs) {
              this.nearMissLogAt.set(key, now);
              const voters = [...outcomeVotes.values()].map(v => `${v.tier}@${v.price}`).join(',');
              console.log(`[Quorum near-miss] ${marketSlug} ${outcome} primary=${primaryCount} sat=${satelliteCount} votes=[${voters}]`);
            }
          }
          // Not enough tier-weighted consensus — wait for more basket members.
          this.planDecision(this.ledgerDecision(trade, 'quorum', false, 'quorum_near_miss'));
          return;
        }
    // ---- B1-B5: quorum-quality gates (from official-audit recommendation) ----
        // Reject a quorum that fires on correlated, thin, or whale-dominated
        // "consensus". Env-configurable; all fail closed (reject on doubt).
        const buyVotes = [...outcomeVotes.values()].filter((v) => v.side === 'BUY');
        if (buyVotes.length >= 2) {
          const aligned = buyVotes.map((v) => ({ wallet: v.wallet, price: v.price, ts: v.timestamp }));
          const minAligned = Math.max(2, this.quorumFor(basket.category));
          const coherence = evaluateConsensusGate({
            aligned,
            minAligned,
            maxPriceBand: Number(process.env.B1_MAX_PRICE_BAND ?? 0.15),
            maxTimeSpreadSec: Number(process.env.B1_MAX_TIME_SPREAD_SEC ?? 3600),
          });
          if (!coherence.ok) {
                      this.stats.quorumSkippedCoherence = (this.stats.quorumSkippedCoherence ?? 0) + 1;
                      console.log(`[BasketQuorum] SKIP coherence(B1): ${basket.category} ${trade.conditionId ?? ''} ${coherence.reason} priceBand=${coherence.priceBandAbs.toFixed(3)} timeSpread=${coherence.timeSpreadSec.toFixed(0)}s (aligned=${buyVotes.length})`);
                      this.planDecision(this.ledgerDecision(trade, 'quorum', false, coherence.reason ?? 'coherence_gate'));
                      return;
                    }
                    // B2: weighted-size agreement floor (headcount alone insufficient).
                    const weightOf = (w: string) => buyVotes.find((v) => v.wallet === w)?.size ?? 0;
                    const wc = computeWeightedConsensus(
                      aligned.map((a) => a.wallet),
                      aligned.map((a) => a.wallet),
                      weightOf,
                    );
                    const minWeighted = Number(process.env.B2_MIN_WEIGHTED_CONSENSUS ?? 0.0);
                    if (wc.totalWeight > 0 && wc.ratio < minWeighted) {
                      this.stats.quorumSkippedWeighted = (this.stats.quorumSkippedWeighted ?? 0) + 1;
                      console.log(`[BasketQuorum] SKIP weighted(B2): ${basket.category} ratio=${wc.ratio.toFixed(2)} < floor=${minWeighted.toFixed(2)} alignedW=${wc.alignedWeight.toFixed(0)}/totalW=${wc.totalWeight.toFixed(0)}`);
                      this.planDecision(this.ledgerDecision(trade, 'quorum', false, 'below_weighted_consensus'));
                      return;
                    }
                    // B3: dominant-wallet concentration cap.
                    const dominantShare = computeDominantWalletShare(aligned.map((a) => a.wallet), weightOf);
                    const maxDominant = Number(process.env.B3_MAX_DOMINANT_SHARE ?? 1.0);
                    if (dominantShare > maxDominant) {
                      this.stats.quorumSkippedDominant = (this.stats.quorumSkippedDominant ?? 0) + 1;
                      console.log(`[BasketQuorum] SKIP dominant(B3): ${basket.category} share=${dominantShare.toFixed(2)} > cap=${maxDominant.toFixed(2)} aligned=${buyVotes.length}`);
                      this.planDecision(this.ledgerDecision(trade, 'quorum', false, 'dominant_wallet'));
                      return;
                    }
                    // B4 — Bayesian shrinkage toward neutral (advisory, logged so the
                              // operator sees WHY a borderline quorum passed but with low confidence).
                              const bayes = bayesianConfidence({ alignedWeight: wc.alignedWeight, totalWeight: wc.totalWeight, prior: Number(process.env.B4_PRIOR_ALPHA ?? 50) });
                              if (bayes.score < 0.5) {
                                console.log(`[BasketQuorum] BAYES-LOW(B4): ${basket.category} score=${bayes.score.toFixed(2)} posterior=${bayes.posterior.toFixed(2)} alignedW=${wc.alignedWeight.toFixed(0)} totalW=${wc.totalWeight.toFixed(0)} (passes B1-B3 but with low confidence)`);
                              }
                              // B5 — Conflict penalty when aligned weight sits against residual weight.
                              const conflict = computeConflictPenalty({ alignedWeight: wc.alignedWeight, totalWeight: wc.totalWeight, penaltyWeight: 1 });
                              if (conflict > 0.25) {
                                console.log(`[BasketQuorum] CONFLICT(B5): ${basket.category} penalty=${conflict.toFixed(2)} alignedW=${wc.alignedWeight.toFixed(0)}/totalW=${wc.totalWeight.toFixed(0)}`);
                              }
                  }
              // Consensus reached. Compute median entry price across all BUY votes.
        const prices = buyVotes.map((v) => v.price).sort((a, b) => a - b);
        const mid = Math.floor(prices.length / 2);
        const consensusPrice =
          prices.length % 2 === 0
            ? (prices[mid - 1] + prices[mid]) / 2
            : prices[mid];
        // Quorum reached: guarantee the token is subscribed before the drift
        // check runs (markets can jump 1→quorum between votes and never pass
        // through a near-miss). subscribe() is idempotent + evicts oldest.
        if (trade.tokenId && this.onMidInterest) this.onMidInterest(trade.tokenId);
        const signal: ConsensusSignal = {
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
                tokenId: trade.tokenId,
                observedAt: now,
              };
        // NOTE: follow-up [1h]/[24h] telemetry is scheduled ONLY after a
        // successful execution (inside executeIfInBand's ok branch). Scheduling
        // it here at quorum-reach printed `entry=0.99` lines for signals the
        // ceiling/quality gates later REJECTED — the misleading "0.94 entries"
        // the operator saw in the logs (deep audit 09-09).
        this._schedulePersist();
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
          this.planDecision(this.ledgerDecision(trade, 'execution', false, 'twap'));
          return;
        }
        if (evalResult.quality === 'fresh' && !evalResult.aligned) {
          this.stats.quorumSkippedTwapMisaligned =
            (this.stats.quorumSkippedTwapMisaligned ?? 0) + 1;
          this.planDecision(this.ledgerDecision(trade, 'execution', false, 'twap'));
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
    signal: ConsensusSignal,
    basket: BasketConfig,
    key: string,
    now: number,
  ): Promise<void> {
    // Fee rate: fetch-and-cache per conditionId before any edge math. Without
    // this the cache defaults to 0 and every edge/exit calculation runs
    // fee-free (systematically optimistic by the full taker fee).
    if (!this.reconciled) {
      this.stats.quorumSkippedRiskHalt = (this.stats.quorumSkippedRiskHalt ?? 0) + 1;
      console.warn(`[BasketQuorum] SKIP reconcile-gate: ${signal.marketSlug} — startup reconciliation incomplete`);
      this.planDecision(this.ledgerDecision(trade, 'execution', false, 'reconcile'));
      return;
    }
    if (signal.conditionId && !this.feeRateCache.has(signal.conditionId)) {
      try {
        const bps = await this.tradingService.getMarketFeeRateBps(signal.conditionId);
        if (Number.isFinite(bps) && bps >= 0) this.feeRateCache.set(signal.conditionId, bps);
      } catch { /* non-fatal: fallbacks below handle the miss */ }
    }
    const maxMidStalenessMs = Number(process.env.BASKET_MID_MAX_STALENESS_MS ?? 30_000);
    const observedMid = trade.tokenId ? this.liveMid.get(trade.tokenId) : undefined;
    // Fail-closed drift: when the live mid is stale/absent, fetch the public
    // CLOB book mid synchronously (same source the exit pass uses). If that
    // also fails, REJECT the fire — never fall back to the leader's own fill
    // price (drift≈0 auto-pass), which silently defeated the gate (audit:
    // "drift fallback" floods while 13 fires executed on unvalidated drift).
    let currentPrice: number | null = null;
    if (observedMid && now - observedMid.ts <= maxMidStalenessMs) {
      currentPrice = observedMid.price;
    } else if (trade.tokenId) {
      try {
        const book = await this.tradingService.getPublicOrderBook(trade.tokenId);
        if (book && book.bids.length > 0 && book.asks.length > 0) {
          const bestBid = Math.max(...book.bids.map((l) => parseFloat(l.price)));
          const bestAsk = Math.min(...book.asks.map((l) => parseFloat(l.price)));
          if (bestBid > 0 && bestAsk > 0) currentPrice = (bestBid + bestAsk) / 2;
        }
      } catch { /* fall through to reject */ }
    }
    if (currentPrice === null) {
      console.warn(`[BasketQuorum] drift unpriced (no live mid/book) for ${trade.tokenId ?? signal.conditionId}`);
      this.stats.quorumSkippedDrift++;
      this.planDecision(this.ledgerDecision(trade, 'execution', false, 'drift'));
      return;
    }
    const drift = Math.abs(currentPrice - signal.consensusPrice) / (signal.consensusPrice || 1);
    if (drift > this.config.maxPriceDrift) {
      this.stats.quorumSkippedDrift++;
      console.log(`[BasketQuorum] SKIP drift: ${signal.marketSlug} consensus=${signal.consensusPrice.toFixed(3)} now=${currentPrice.toFixed(3)}`);
      this.planDecision(this.ledgerDecision(trade, 'execution', false, 'drift'));
      return;
    }
    const engine = new ExecutionEngine(this.tradingService, this.riskManager, {
      tickSizeFor: (conditionId) => this.tickSizeCache.get(conditionId) ?? 0.01,
      feeRateFor: (conditionId) => this.feeRateCache.get(conditionId) ?? DEFAULT_FEE_RATE_BPS,
      bankrollFor: (category) => this.bankrollFor(category as MarketCategory),
      basketSpendGet: (category) => this.basketSpend.get(category as MarketCategory) ?? 0,
      basketSpendAdd: (category, amount) => {
        const c = category as MarketCategory;
        this.basketSpend.set(c, (this.basketSpend.get(c) ?? 0) + amount);
      },
      phaseEdge: (candidate) => {
        const end = this._inferMarketEndMs(candidate.marketSlug);
        const seconds = end === null ? null : Math.max(0, Math.floor((end - Date.now()) / 1000));
        if (seconds !== null && seconds < 60) return { minEdge: 0.20, minProb: 0.70 };
        if (seconds !== null && seconds < 180) return { minEdge: 0.10, minProb: 0.60 };
        // Long-horizon floor: previously {minEdge:0,minProb:0} disabled the
        // edge gate for any market beyond 3 minutes, letting the bot buy
        // 0.90+ tickets on winRate alone (the core loss driver). Enforce a
        // persistent minimum edge so a fair coin can't clear on a high basket
        // EMA that no longer reflects the market.
        return { minEdge: 0.05, minProb: 0.55 };
      },
      liquidityCheck: async (tokenId, shares, price) => {
        try {
          const raw = await this.tradingService.getOrderBook(tokenId);
          if (!raw) return true;
          return buildOrderBookSummary(raw).hasSufficientLiquidity({ side: 'BUY', shares, price, multiplier: 2 }).ok;
        } catch { return true; }
      },
      onPositionOpened: (tokenId, usdc, size, price, candidate) => {
        if (typeof tokenId !== 'string') return;
        const s = candidate as ConsensusSignal;
        this.trackOpenPosition(tokenId, usdc as number, size as number, price as number, s.marketSlug, s.outcome, s.conditionId, s.basketName, s.category as MarketCategory, s.signalId, s.wallets);
      },
      onDedupFire: (dedupKey, timestamp) => { this._lastProcessedFire.set(dedupKey, timestamp); },
      onAntiSniperFire: (tokenId) => this.antiSniper?.recordFire(tokenId),
      onStaleQuoteSkip: () => { this.botMetrics?.staleQuoteCancelled(); },
      quality: this.marketQuality ?? undefined,
      marketVolume24h: (cid) => this.marketVolume24hFor(cid),
      auditStore: { recordFire: (params) => signalAuditStore.recordFire(params as Parameters<typeof signalAuditStore.recordFire>[0]) },
      bookLookup: async (tokenId) => {
        try {
          const book = await this.tradingService.getPublicOrderBook(tokenId);
          if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks) || book.bids.length === 0 || book.asks.length === 0) return null;
          const level = (l: { price: string | number; size: string | number }) => {
            const price = typeof l.price === 'number' ? l.price : parseFloat(l.price);
            const size = typeof l.size === 'number' ? l.size : parseFloat(l.size);
            return { price, size };
          };
          return {
            asks: book.asks.map(level),
            bids: book.bids.map(level),
            minOrderSize: 0,
            tickSize: this.tickSizeCache.get(tokenId) ?? 0.01,
            timestamp: Date.now(),
          };
        } catch {
          return null;
        }
      },
    }, {
      dryRun: this.config.dryRun, orderType: this.config.orderType, maxSlippage: this.config.maxSlippage,
      minTradeSize: this.config.minTradeSize, maxSizePerTrade: this.config.maxSizePerTrade, sizeScale: this.config.sizeScale,
      maxEntryPrice: this.config.maxEntryPrice,
    });
    this.planDecision(this.ledgerDecision(trade, 'quorum_reached', true, undefined, signal.outcome));
        const decision = await engine.evaluate(signal, trade, basket);
        // D1/D2 — Entry-quality scoring + R-normalized sizing (execution-quality.ts).
        // We compute the size multiplier and the R-adjusted amount from the live
        // microstructure and surface them in the log so operators can see how
        // entry quality reshapes the trade.
        if (decision.accepted) {
          const eq = computeEntryQualityScore({
            signalEdgeBps: Math.round(((decision.value.price - 0.5) * 200)), // rough: midpoint-derived bps (0.5 = neutral)
            spreadBps: this.marketQuality?.features(signal.tokenId ?? signal.conditionId)?.spreadBps ?? null,
            minTopDepth: this.marketQuality?.features(signal.tokenId ?? signal.conditionId)?.depthUsd ?? null,
            ageSeconds: Math.max(0, (Date.now() - (trade.timestamp ?? Date.now())) / 1000),
            weights: { edge: 0.4, spread: 0.2, depth: 0.2, freshness: 0.2 },
          });
          const sz = resolveEdgeSizeMultiplier(eq.edgeScore * 250, { fullBps: 250, floorBps: 100 });
          const baseUsdc = decision.value.amountUsd * sz.multiplier;
          const stopLossPrice = Math.max(0.01, decision.value.price * 0.5); // 50% stop heuristic (no live SL endpoint)
          const adj = applyRiskAdjustedAmount({ baseUsdc, entryPrice: decision.value.price, stopLossPrice, targetRiskUsdc: baseUsdc * 0.5 });
          console.log(`[BasketQuorum] QUALITY(D1/D2): ${basket.category} ${signal.marketSlug} entryQ=${eq.score.toFixed(1)}/100 edge=${eq.edgeScore.toFixed(2)} spread=${eq.spreadScore.toFixed(2)} depth=${eq.depthScore.toFixed(2)} fresh=${eq.freshnessScore.toFixed(2)} sizeTier=${sz.tier} baseUsdc=${baseUsdc.toFixed(2)} adj=${adj.adjusted ? adj.amountUsdc.toFixed(2) : 'no'}`);
          decision.value.amountUsd = adj.amountUsdc;
        }
        if (decision.accepted && this.basketRiskConfig) {
      const amountUsd = decision.value.amountUsd;
      const capital = this.riskManager?.currentCapital() ?? this.bankrollFor(basket.category);
      const exposure = checkExposure(capital, this.basketSpend.get(basket.category) ?? 0, 0, this.basketRiskConfig, basket.category, amountUsd);
      if (!exposure.ok) {
        this.stats.quorumNearMissExecution = (this.stats.quorumNearMissExecution ?? 0) + 1;
        this.stats.quorumSkippedBankroll++;
        if (this.paperExploration) this.stats.shadowSignals = (this.stats.shadowSignals ?? 0) + 1;
        return;
      }
    }
    if (!decision.accepted) {
      if (decision.reason === 'risk') this.stats.quorumSkippedRiskHalt++;
      else if (decision.reason === 'bankroll') this.stats.quorumSkippedBankroll++;
      else if (decision.reason === 'min_size') this.stats.quorumSkippedMinSize = (this.stats.quorumSkippedMinSize ?? 0) + 1;
      else if (decision.reason === 'edge') this.stats.quorumSkippedNegativeEdge = (this.stats.quorumSkippedNegativeEdge ?? 0) + 1;
      else if (decision.reason === 'liquidity') this.stats.quorumSkippedThinLiquidity = (this.stats.quorumSkippedThinLiquidity ?? 0) + 1;
      this.planDecision(this.ledgerDecision(trade, 'execution', false, decision.reason));
      return;
    }
    // Replacement copy layer: executable-VWAP price gate against the live book.
    // The leader's printed price is never the copy price; we adopt the
    // executable ask VWAP when it is within drift and still carries edge.
    try {
      const planner = new CopyPlanner({
        maxSlippagePct: this.config.maxSlippage,
        maxBookAgeMs: 30_000,
        fractionalKelly: 0.25,
        capitalUsd: this.riskManager?.currentCapital() ?? this.bankrollFor(basket.category),
        basketHeadroomUsd: Math.max(0, this.bankrollFor(basket.category) - (this.basketSpend.get(basket.category) ?? 0)),
        maxSizeUsd: this.config.maxSizePerTrade,
        reliabilityFloor: 0,
        defaultOrderType: this.config.orderType,
        maxEntryPrice: this.config.maxEntryPrice,  // planner ceiling syncs with engine (0.85 default)
      });
      const tokenId = trade.tokenId;
      const rawBook = tokenId ? await this.tradingService.getOrderBook(tokenId) : null;
      if (rawBook && Array.isArray((rawBook as { bids?: unknown }).bids) && Array.isArray((rawBook as { asks?: unknown }).asks)) {
        const book: CopyBook = {
          bids: (rawBook as { bids: { price: string | number; size: string | number }[] }).bids.map((l) => ({ price: parseFloat(String(l.price)), size: parseFloat(String(l.size)) })),
          asks: (rawBook as { asks: { price: string | number; size: string | number }[] }).asks.map((l) => ({ price: parseFloat(String(l.price)), size: parseFloat(String(l.size)) })),
          ageMs: 0,
        };
        const meta: MarketMeta = {
          tickSize: this.tickSizeCache.get(signal.conditionId) ?? 0.01,
          minNotional: 1,
          takerFeeRateBps: this.feeRateCache.get(signal.conditionId) ?? DEFAULT_FEE_RATE_BPS,
          acceptingOrders: true,
        };
        const s = signal.wallets[0] ?? (trade.traderAddress ?? '').toLowerCase();
        // Confidence wiring: pull REAL screening-derived values for the quorum's
        // wallets. reliability = mean CopyScore (0-1) across the firing wallets;
        // independenceAdjustment = 1 − HHI of the vote cluster (computed in
        // tryFire); fairProb = per-wallet category winRate (wallet-calibrated)
        // blended with the basket EMA. Falls back to neutral values only when
        // the wallet has no screening data yet.
        const walletStats = signal.wallets.map((w) => ({
          rel: this.walletReliability.get(w) ?? 0.5,
          wr: this.walletCategoryWinRate.get(`${w}:${signal.category}`),
        }));
        const reliability = walletStats.length
          ? walletStats.reduce((a, b) => a + b.rel, 0) / walletStats.length
          : 0.5;
        const wrVals = walletStats.map((x) => x.wr).filter((v): v is number => typeof v === 'number');
        const walletWinRate = wrVals.length
          ? wrVals.reduce((a, b) => a + b, 0) / wrVals.length
          : null;
        // Blend: wallet-calibrated rate (if any) 60%, basket EMA 40%. The EMA
        // alone made the edge gate a falling-knife filter; the wallet rate is
        // the actual "these specific people win here" number.
        const fairProb = walletWinRate !== null
          ? 0.6 * walletWinRate + 0.4 * (signal.winRate ?? 0.6)
          : (signal.winRate ?? 0.6);
        const hhi = this.lastVoteHHI.get(`${signal.conditionId}:${signal.outcome}`) ?? 1;
        const independenceAdjustment = Math.max(0.2, Math.min(1, 1 - hhi));
      const planDecision = planner.plan(
        {
          wallet: s,
            conditionId: signal.conditionId,
            tokenId: trade.tokenId ?? signal.conditionId,
            side: 'BUY',
            // Request OUR copy size (shares the engine actually plans to buy),
            // not the whales' aggregate totalSize — walking the book for the
            // full whale notional overstates the executable price on thin
            // books and produces spurious drift/no_edge rejections.
            size: Math.max(1, (decision.value.amountUsd || 0) / Math.max(signal.consensusPrice, 0.01)),
            price: signal.consensusPrice,
            timestamp: now,
            fairProb,
            reliability,
            executionConfidence: 1,
            independenceAdjustment,
          },
          book,
          meta,
        );
        if (!planDecision.accepted) {
          const r = planDecision.reason;
          if (r === 'drift') { this.stats.quorumSkippedDrift++; this.planDecision(this.ledgerDecision(trade, 'execution', false, 'drift')); return; }
          if (r === 'no_edge') { this.stats.quorumSkippedNegativeEdge = (this.stats.quorumSkippedNegativeEdge ?? 0) + 1; this.planDecision(this.ledgerDecision(trade, 'execution', false, 'edge')); return; }
          if (r === 'below_min') { this.stats.quorumSkippedMinSize = (this.stats.quorumSkippedMinSize ?? 0) + 1; this.planDecision(this.ledgerDecision(trade, 'execution', false, 'min_size')); return; }
          if (r === 'stale_book' || r === 'no_book') { this.planDecision(this.ledgerDecision(trade, 'execution', false, 'liquidity')); return; }
          this.planDecision(this.ledgerDecision(trade, 'execution', false, r === 'market_closed' ? 'risk' : 'liquidity'));
          return;
        }
        // Adopt the executable-VWAP price for the order (engine keeps sizing).
        decision.value.price = planDecision.plan.price;
      }
    } catch (e) {
      console.warn('[BasketQuorum][copy] planner gate error:', e instanceof Error ? e.message : e);
    }
    this.lastFired.set(key, Date.now());
    this._schedulePersist();
    // P1 lens #5: feed-freshness halt — never copy from a stale feed even
    // when consensus is fresh; the whole signal stack is only as good as
    // the newest raw event it derived from.
    if (this.config.maxFeedAgeMs && this.config.maxFeedAgeMs > 0) {
      const feedAge = Date.now() - this.getLastFeedEventAt();
      if (feedAge > this.config.maxFeedAgeMs) {
        this.stats.quorumSkippedFeedStale = (this.stats.quorumSkippedFeedStale ?? 0) + 1;
        console.warn(`[BasketQuorum] SKIP feed-stale: ${signal.marketSlug} — newest feed event ${(feedAge / 1000).toFixed(0)}s old (max ${(this.config.maxFeedAgeMs / 1000).toFixed(0)}s)`);
        this.planDecision(this.ledgerDecision(trade, 'execution', false, 'stale'));
        return;
      }
    }
    const result = await engine.execute(decision, trade, basket);
        if (result.ok) {
          // Schedule 1h and 24h follow-up price checks (whalewatch-style
          // validation loop) — ONLY for actually-fired signals, so the
          // `[1h] entry=` telemetry never misleads about rejected signals.
          // (Deep audit 09-09: follow-ups used to be scheduled at quorum-reach,
          // before the 0.85 ceiling, so logs showed entry=0.99 for never-bought
          // signals.)
          this._scheduleFollowup(signal);
          // P1 lens #4: persist the bucketed feature snapshot for this fire —
      // probability (consensus), spread/depth/chop from the quality tracker
      // (all that is observable in this path), for replay + gating inputs.
      if (this.marketSnapshots) {
        const tokenId = trade.tokenId ?? signal.conditionId;
        const qf = this.marketQuality?.features(tokenId);
        // Real 24h volume/liquidity (anti-honeypot + truthful snapshots); the
        // cached value is best-effort and non-fatal when unavailable.
        const volMeta = await this.marketVolume24hFor(signal.conditionId).catch(() => null);
        try {
          void this.marketSnapshots.upsertTick({
            tokenId,
            tsBucket: bucket15m(Date.now()),
            probability: Number(signal.consensusPrice) || 0,
            liquidity: volMeta?.liquidity ?? 0,
            volume24hr: volMeta?.volume24hr ?? 0,
            spreadBps: qf?.spreadBps ?? null,
            depthUsd: qf?.depthUsd ?? 0,
            chop: qf?.chop ?? 0,
            fetchedAt: Date.now(),
          }).catch(() => undefined);
        } catch { /* persistence must never break trading */ }
      }
      this.planDecision(this.ledgerDecision(trade, 'executed', true, undefined, signal.outcome));
      this.stats.quorumFired++;
      this.stats.executed++;
      this._schedulePersist();
      // Feed the Prometheus histogram with the entry price. `decision.value.price`
      // is the audited price (the consensus/limit price before slippage) — that's
      // the entry-price cluster the funnel mean cannot show.
      if (this.botMetrics) {
        this.botMetrics.observeEntryPrice(
          String(signal.category ?? 'unknown'),
          String(basket?.name ?? 'all'),
          Number(decision.value.price ?? 0),
        );
      }
    } else {
      // Skip/failure taxonomy (audit 09-09 failed=6 conflation): only a real
      // order failure increments `failed`; fail-closed gates (stale quote,
      // bankroll, depth, quality) are counted separately so the funnel shows
      // WHY orders didn't land instead of lumping everything into failed.
      switch (result.reason) {
        case 'order':
          this.stats.failed++;
          break;
        case 'stale_quote':
          this.stats.quorumSkippedStaleQuote = (this.stats.quorumSkippedStaleQuote ?? 0) + 1;
          break;
        case 'bankroll':
          this.stats.quorumSkippedBankroll++;
          break;
        case 'depth_unknown':
        case 'no_depth':
          this.stats.quorumSkippedThinLiquidity = (this.stats.quorumSkippedThinLiquidity ?? 0) + 1;
          break;
        case 'quality':
          this.stats.quorumSkippedQuality = (this.stats.quorumSkippedQuality ?? 0) + 1;
          break;
        case 'entry_ceiling':
          this.stats.quorumSkippedNegativeEdge = (this.stats.quorumSkippedNegativeEdge ?? 0) + 1;
          break;
        default:
          this.stats.failed++;
      }
    }
  }
  getStats(): QuorumStats {
    return { ...this.stats };
  }

  /** Per-category deployed USDC (read-only exposure view for rebalancing/health). */
  getCategorySpend(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [cat, amt] of this.basketSpend) out[cat] = amt;
    return out;
  }

  /** unix ms of the newest processed feed event (0 = none yet). */
  getLastFeedEventAt(): number {
    return this._lastFeedEventAt;
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
    feed_received: number;
    ignored_no_basket: number;
    ignored_not_member: number;
    ignored_unsupported_side: number;
    ignored_invalid_market: number;
    votes_recorded: number;
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
    accounted_pct: number;
  } {
    const s = this.stats;
    const filtered = s.quorumSkippedThinEdge + s.quorumSkippedStaleMarket;
    // Stage counters intentionally use different denominators: filtered events
    // are counted before vote recording, so filtered may exceed recorded votes.
    // Conversion = executions per quorum fire (the actionable rate).
    // The old metric divided by raw vote events (executed/votesObserved),
    // which always rounds to 0.0% and tells the operator nothing.
    const filteredPct = s.feedReceived === 0 ? 0 : Math.min(100, Math.round(((s.votesRecorded + s.quorumSkippedThinEdge + s.quorumSkippedStaleMarket) / s.feedReceived) * 1000) / 10);
    const conversion = s.quorumFired === 0 ? 0 : (s.executed / s.quorumFired) * 100;
    const funnel = {
      feed_received: s.feedReceived,
      ignored_no_basket: s.ignoredNoBasket,
      ignored_not_member: s.ignoredNotMember,
      ignored_unsupported_side: s.ignoredUnsupportedSide,
      ignored_invalid_market: s.ignoredInvalidMarket,
      votes_recorded: s.votesRecorded,
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
      // Audit 09-09 skip taxonomy: fail-closed gates counted separately from
      // real order failures (failed=6 was actually 6× no-depth liquidity skips).
      skipped_stale_quote: s.quorumSkippedStaleQuote ?? 0,
      skipped_feed_stale: s.quorumSkippedFeedStale ?? 0,
      skipped_quality: s.quorumSkippedQuality ?? 0,
      near_miss_ind: s.quorumNearMissIndependence ?? 0,
      near_miss_cons: s.quorumNearMissConsensus ?? 0,
      near_miss_exec: s.quorumNearMissExecution ?? 0,
      executed: s.executed,
      failed: s.failed,
      conversion_pct: Math.round(conversion * 100) / 100,
      accounted_pct: filteredPct,
      feed_age_ms: Math.max(0, Date.now() - this.getLastFeedEventAt()),
    };
    const edgeStats = signalAuditStore.getStats();
    // Compact anti-sniper reason breakdown, e.g. "no_mid_observations:1200/mid_unstable:300"
    const reasons = Object.entries(s.antiSniperReasons ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join('/');
    console.log(
      `[BasketQuorum${label ? ':' + label : ''}] funnel: ` +
        `received=${funnel.feed_received} ignored=${Math.min(funnel.feed_received, funnel.ignored_no_basket + funnel.ignored_not_member + funnel.ignored_unsupported_side + funnel.ignored_invalid_market)} ` +
        `recorded=${funnel.votes_recorded} ` +
        `filtered=${funnel.filtered}(thin=${funnel.filtered_thin},stale=${funnel.filtered_stale}) ` +
        `fired=${funnel.quorum_fired} ` +
        `risk=${funnel.skipped_risk} bankroll=${funnel.skipped_bankroll} ` +
        `drift=${funnel.skipped_drift} cooldown=${funnel.skipped_cooldown} ` +
        `antiSniper=${funnel.skipped_anti_sniper}${reasons ? `(${reasons})` : ''} ` +
        `twap=${funnel.skipped_twap_stale}/${funnel.skipped_twap_misaligned} ` +
        `liq=${funnel.skipped_thin_liquidity} negEdge=${funnel.skipped_negative_edge} ` +
        `minSize=${funnel.skipped_min_size} ` +
        `execSkips=${funnel.skipped_stale_quote}/${funnel.skipped_feed_stale}/${funnel.skipped_quality} ` +
        `nearMiss=${funnel.near_miss_ind}/${funnel.near_miss_cons}/${funnel.near_miss_exec} ` +
        `executed=${funnel.executed} failed=${funnel.failed} ` +
        `feedAge=${(funnel.feed_age_ms / 1000).toFixed(0)}s ` +
        `conversion=${funnel.conversion_pct}% accounted=${funnel.accounted_pct}%` +
        (edgeStats.signalsSettled > 0
          ? ` | edge: exp=${edgeStats.meanExpectedEdge.toFixed(4)} ` +
            `real=${edgeStats.meanRealizedEdge.toFixed(4)} ` +
            `alpha=${edgeStats.edgeAlpha.toFixed(4)} ` +
            `sig=${edgeStats.isSignificant} ` +
            `(n=${edgeStats.signalsSettled} settled/${edgeStats.signalsFired} fired)`
          : ''),
    );
    // Parallel Prometheus surface: mirror the snapshot into histograms/counters
    // so a `curl /metrics` exposes distribution shape (loss tail, entry-price
    // cluster, hold duration) that the mean-only funnel line cannot.
    if (this.botMetrics) {
      this.botMetrics.feedFunnel({
        feedReceived: funnel.feed_received,
        votesRecorded: funnel.votes_recorded,
        filtered: funnel.filtered,
        filteredThin: funnel.filtered_thin,
        filteredStale: funnel.filtered_stale,
        quorumFired: funnel.quorum_fired,
        executed: funnel.executed,
        failed: funnel.failed,
        byReason: s.antiSniperReasons ?? {},
        skippedStaleQuote: funnel.skipped_stale_quote,
        skippedFeedStale: funnel.skipped_feed_stale,
        skippedQuality: funnel.skipped_quality,
        nearMissInd: funnel.near_miss_ind,
        nearMissCons: funnel.near_miss_cons,
        nearMissExec: funnel.near_miss_exec,
      });
    }
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
      feedReceived: 0,
      ignoredNoBasket: 0,
      ignoredNotMember: 0,
      ignoredUnsupportedSide: 0,
      ignoredInvalidMarket: 0,
      votesRecorded: 0,
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
    // 2. Update ONLY the baskets that actually fired on this market. The old
    //   code moved EVERY basket's EMA on ANY resolution — a single crypto
    //   settlement dragged the politics/weather baskets' winRate too
    //   (landmine: re-wiring this would silently corrupt every basket prior).
    //   Scoped via the audit store's per-condition signal baskets.
    const ALPHA = 0.1;
    const firedBaskets = new Set<string>(
      signalAuditStore.getSignalsByCondition(conditionId).map((s) => s.basket),
    );
    for (const basketName of firedBaskets) {
      const basket = this.baskets.get(basketName as MarketCategory);
      if (!basket || !basket.enabled) continue;
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
    // Fan out to the operator wiring (bot-config's display `state`) — the
    // [risk] status line reads BotState, not RiskManager, so without this
    // hook settled PnL never shows in [risk].
    if (this.onSettledTrade) {
      try { this.onSettledTrade(pnlUsd); } catch { /* display must not break trading */ }
    }
  }
  /** Optional callback: invoked with each settled trade's PnL (display/hook). */
  onSettledTrade: ((pnlUsd: number) => void) | null = null;
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
    /** Uniform payout override (e.g. 0.5 for a tennis walkover — 50-50 rule).
     *  When set, every unsettled signal books PnL at `payout − pricePaid`
     *  but is NOT marked resolved 1/0 (the audit taxonomy keeps walkovers
     *  conservatively pending until a real binary resolution exists). */
    payout?: number,
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
      // Uniform-payout path first (walkover / non-plain resolution): book the
      // PnL now, keep the signal pending — a 0.5 payout is neither won nor lost.
      if (payout !== undefined) {
        const pnlPerShare = (payout - sig.pricePaid) - (sig.feePerShare ?? 0);
        this.recordSettledTrade(pnlPerShare * sig.size, Date.now(), sig.side);
        if (this.botMetrics && typeof sig.pricePaid === 'number' && sig.pricePaid > 0) {
          this.botMetrics.observePnl({
            category: String(sig.basket ?? 'unknown'),
            outcome: 'pending',
            side: sig.side,
            pnlPerShare,
          });
        }
        console.log(`[BasketQuorum] half-payout settlement ${conditionId.slice(0, 10)}: payout=${payout} pnlPerShare=${pnlPerShare.toFixed(4)} (walkover/non-plain; signal stays pending)`);
        anySettled = true;
        continue;
      }
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
      // PT4: feed the kill switch — per-basket settled outcomes.
      if (this.riskManager && sig.side === 'BUY') {
        this.riskManager.recordBasketOutcome(sig.basket, sigResolved === 1);
      }
      // Feed the Prometheus histogram with realized PnL per share, segmented
      // by outcome (won|pending|lost) + category + side. This is the
      // distribution shape the funnel mean cannot show.
      if (this.botMetrics && typeof sig.pricePaid === 'number' && sig.pricePaid > 0) {
        const won = sigResolved === 1;
        const entryPrice = sig.pricePaid;
        // Value model: a winning share pays $1, a losing share pays $0 —
        // for BOTH sides (BUY = long YES, SELL = long NO). The old SELL
        // branch (entryPrice − 1 / entryPrice) inverted the sign of NO exits.
        const pnlPerShare = won ? 1 - entryPrice : -entryPrice;
        this.botMetrics.observePnl({
          category: String(sig.basket ?? 'unknown'),
          outcome: won ? 'won' : 'lost',
          side: sig.side,
          pnlPerShare,
        });
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
