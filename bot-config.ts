/**
 * Polyland — Basket-Quorum Copy Trading Bot
 *
 * The ONLY active strategy is basket-quorum copy trading: watch a screened
 * set of expert wallets, fire only when K distinct wallets in a category
 * basket agree on the same outcome within a rolling window, then copy with
 * risk-managed sizing.
 */

import 'dotenv/config';
import * as fs from 'node:fs/promises';
import {
  PolymarketSDK,
  BasketQuorumService,
  WalletIngestionService,
  WalletScreeningService,
  JsonStateStore,
  VoteStateStore,
  RiskManager,
  type SmartMoneyTrade,
  type BasketQuorumConfig,
} from './src/index.js';
import { signalAuditStore, SignalAuditStore, setBonferroniGroups } from './src/services/signal-audit-store.js';
import { AntiSniperGuard, DEFAULT_ANTI_SNIPER_CONFIG } from './src/utils/anti-sniper.js';
import { ChainlinkTwapOracle } from './src/services/chainlink-twap-oracle.js';
import { ClobMarketWsService } from './src/services/clob-market-ws.js';
import { GammaResolutionPoller } from './src/services/gamma-resolution-poller.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  capital: {
    totalUsd: parseFloat(process.env.CAPITAL_USD || '250'),
    maxPerTradePct: 0.02,  // Reduced from 3% to 2% for safety
    maxPerMarketPct: 0.10,
    maxTotalExposurePct: 0.30,
    minOrderUsd: 5,
  },

  risk: {
    // Daily limits
    dailyMaxLossPct: 0.05,  // Reduced from 8% to 5%
    maxConsecutiveLosses: 6,
    pauseOnBreachMinutes: 60,

    // 🔴 NEW: Monthly and cumulative limits
    monthlyMaxLossPct: 0.15,  // 15% monthly limit
    maxDrawdownFromPeak: 0.25,  // 25% drawdown from peak
    totalMaxLossPct: 0.40,  // 40% total loss - stop trading entirely

    // 🔴 NEW: Dynamic position sizing
    enableDynamicSizing: true,
    minPositionPct: 0.01,  // 1% minimum
    maxPositionPct: 0.05,  // 5% maximum
    lossSizingReduction: 0.20,  // Reduce 20% per consecutive loss
    winSizingIncrease: 0.10,  // Increase 10% per consecutive win
  },

  smartMoney: {
      enabled: true,  // basket-quorum copy trading — do NOT disable
      topN: 50,        // 50 per category × 5 categories ≈ 200+ candidates after dedup
      // 🔴 FIXED: Stricter criteria
      minWinRate: 0.60,  // Up from 0.50 to 60%
      minPnl: 500,       // Up from 100 to $500
      minTrades: 30,     // Up from 20 to 30

      // 🔴 NEW: Quality filters
      minProfitFactor: 1.5,  // Total wins / total losses >= 1.5x
      minConsistencyScore: 0.7,  // Recent performance score
      maxSingleTradeExposure: 0.3,  // Max 30% of PnL from one trade
      checkLastNTrades: 10,  // Analyze last 10 trades for consistency

      sizeScale: 0.2,
      maxSizePerTrade: 15,
      maxSlippage: 0.03,
      minTradeSize: 5,
      delay: 500,
      // ADD YOUR CUSTOM WALLETS HERE (will be followed in addition to leaderboard)
      customWallets: [
        '0xc2e7800b5af46e6093872b177b7a5e7f0563be51',  // Top Polymarket trader
        '0x58c3f5d66c95d4c41b093fbdd2520e46b6c9de74',  // simonbanza
        // Add more wallet addresses here...
      ] as string[],
    },

  dryRun: process.env.DRY_RUN !== 'false',
};

// ============================================================================
// STATE
// ============================================================================

interface BotState {
  startTime: number;
  dailyPnL: number;
  totalPnL: number;
  consecutiveLosses: number;
  consecutiveWins: number;  // NEW
  tradesExecuted: number;
  isPaused: boolean;
  pauseUntil: number;

  // 🔴 NEW: Enhanced risk tracking
  monthlyPnL: number;
  monthStartTime: number;
  peakCapital: number;
  currentCapital: number;
  currentDrawdown: number;
  permanentlyHalted: boolean;  // When total loss limit hit
  lastDailyReset: number;

  // Balances
  usdcBalance: number;
  usdcEBalance: number;
  maticBalance: number;

}

const state: BotState = {
  startTime: Date.now(),
  dailyPnL: 0,
  totalPnL: 0,
  consecutiveLosses: 0,
  consecutiveWins: 0,
  tradesExecuted: 0,
  isPaused: false,
  pauseUntil: 0,

  // Risk tracking
  monthlyPnL: 0,
  monthStartTime: Date.now(),
  peakCapital: CONFIG.capital.totalUsd,
  currentCapital: CONFIG.capital.totalUsd,
  currentDrawdown: 0,
  permanentlyHalted: false,
  lastDailyReset: Date.now(),

  usdcBalance: 0,
  usdcEBalance: 0,
  maticBalance: 0,
};

// ============================================================================
// UTILITIES
// ============================================================================

function log(level: string, message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const icons: Record<string, string> = {
    INFO: '📋', WARN: '⚠️', ERROR: '❌', TRADE: '💰', SIGNAL: '🎯',
    WALLET: '👛',
  };
  console.log(`[${timestamp}] ${icons[level] || '•'} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

// 🔴 FIXED: Enhanced trade recording with win tracking
function recordTrade(profit: number) {
  state.tradesExecuted++;
  state.dailyPnL += profit;
  state.monthlyPnL += profit;  // NEW
  state.totalPnL += profit;

  // Track consecutive wins/losses
  if (profit < 0) {
    state.consecutiveLosses++;
    state.consecutiveWins = 0;
  } else {
    state.consecutiveLosses = 0;
    state.consecutiveWins++;
  }

  // Update capital + drawdown (used by [risk] display line)
  state.currentCapital = CONFIG.capital.totalUsd + state.totalPnL;
  state.peakCapital = Math.max(state.peakCapital, state.currentCapital);
  state.currentDrawdown = state.peakCapital > 0
    ? (state.peakCapital - state.currentCapital) / state.peakCapital
    : 0;

}

// ============================================================================
// 1b. BASKET QUORUM COPY TRADING
// ============================================================================

let basketQuorum: BasketQuorumService | null = null;
let quorumSubscription: { id: string; unsubscribe: () => void } | null = null;
/** Gamma API resolution poller (replaces dead RTDS market_resolved topic) */
let gammaPoller: GammaResolutionPoller | null = null;
/** CLOB market WebSocket (replaces dead RTDS clob_market topic for mid feed) */
let clobWs: ClobMarketWsService | null = null;
/** Anti-sniper mid-feed book subscription */
let midFeedSubscription: { unsubscribe: () => void } | null = null;

const BASKET_QUORUM_CONFIG: BasketQuorumConfig = {
  // Quorum of 2 distinct, vetted wallets per basket. With ~67 leaderboard
  // candidates yielding only 2-7 quality wallets, 2 is the minimum viable
  // consensus (still "two independent experts agreed", not one wallet's luck).
  // Raise to 3+ if the candidate pool grows.
  defaultQuorum: 2,
  defaultWindowMs: 30 * 60 * 1000,       // 30-minute rolling window
  maxPriceDrift: 0.05,
  fireCooldownMs: 10 * 60 * 1000,
  sizeScale: CONFIG.smartMoney.sizeScale,
  maxSizePerTrade: CONFIG.smartMoney.maxSizePerTrade,
  maxSlippage: CONFIG.smartMoney.maxSlippage,
  orderType: 'FOK',
  minTradeSize: CONFIG.smartMoney.minTradeSize,
  dryRun: CONFIG.dryRun,
  bankrollAllocation: {
    crypto: 0.35,
    sports: 0.10,
    politics: 0.10,
    esports: 0.05,
    economics: 0.05,
    entertainment: 0.05,
    science: 0.05,
    other: 0.05,
    // remainder (0.20) = reserve, unallocated.
    // NOTE: every category MUST be listed — seed() rebuilds baskets for all
    // 8 categories from wallet data, and an unlisted category defaults to a
    // 100%-of-capital slice (observed: other=107 wallets got the full bankroll).
  },
  baskets: [
    {
      name: 'Crypto Quorum',
      category: 'crypto',
      enabled: true,
      wallets: [],
      quorum: 3,
      windowMs: 30 * 60 * 1000,
      winRate: 0.52,
    },
    {
      name: 'Sports Quorum',
      category: 'sports',
      enabled: true,
      wallets: [],
      quorum: 3,
      windowMs: 30 * 60 * 1000,
      winRate: 0.52,
    },
    {
      name: 'Politics Quorum',
      category: 'politics',
      enabled: true,
      wallets: [],
      quorum: 3,
      windowMs: 30 * 60 * 1000,
      winRate: 0.5,
    },
    {
      name: 'Esports Quorum',
      category: 'esports',
      enabled: true,
      wallets: [],
      quorum: 3,
      windowMs: 30 * 60 * 1000,
      winRate: 0.52,
    },
    {
      name: 'Economics Quorum',
      category: 'economics',
      enabled: true,
      wallets: [],
      quorum: 3,
      windowMs: 30 * 60 * 1000,
      winRate: 0.5,
    },
    {
      name: 'Entertainment Quorum',
      category: 'entertainment',
      enabled: true,
      wallets: [],
      quorum: 3,
      windowMs: 30 * 60 * 1000,
      winRate: 0.5,
    },
    {
      name: 'Science Quorum',
      category: 'science',
      enabled: true,
      wallets: [],
      quorum: 3,
      windowMs: 30 * 60 * 1000,
      winRate: 0.5,
    },
    {
      name: 'Other Quorum',
      category: 'other',
      enabled: true,
      wallets: [],
      quorum: 3,
      windowMs: 30 * 60 * 1000,
      winRate: 0.5,
    },
  ],
};

async function setupBasketQuorum(sdk: PolymarketSDK) {
  if (!CONFIG.smartMoney.enabled) return;

  log('QUORUM', 'Setting up basket quorum copy trading...');

  // Boot the three-service stack: ingest → screen → quorum
  const ingestion = new WalletIngestionService(sdk.wallets, {
    manual: CONFIG.smartMoney.customWallets.map((addr) => ({
      address: addr,
      label: 'manual',
      source: 'manual' as const,
      lockCategory: false,
    })),
    auto: {
      enabled: true,
      period: 'week',
      topN: CONFIG.smartMoney.topN,
      categories: ['OVERALL', 'CRYPTO', 'SPORTS', 'POLITICS', 'CULTURE', 'TECH', 'FINANCE', 'ECONOMICS'],
      refreshIntervalMs: 6 * 60 * 60 * 1000,
      sortBy: 'pnl',
    },
  });
  const screeningConfig = {
    profileFetchConcurrency: 10,
    // CopyScore thresholds (Poly Syncer composite 0–100, single score).
    // Consistency is now ROLLED INTO CopyScore (rankStability/steadiness),
    // not a separate gate. Thin wallets are shrunk toward 50 by computeCopyScore
    // so thresholds are set below that pull. PRIMARY >= 60, SATELLITE >= 40.
    primaryCopyScoreThreshold: 60,
    satelliteCopyScoreThreshold: 40,
    // Baseline: 100 trades (industry full-sample marker for shrinkage fade),
    // category edge = 58% win over >=3 SETTLED positions.
    // Profitability is handled by CopyScore components, not a binary gate.
    minTradeCount: 100,
    minWinRate: 0.60,
    minCategoryWinRate: 0.58,
    minCategoryTrades: 3,
    maxInactiveDays: 60,   // edge decays — 60d matches Poly Syncer window
  };
  const screening = new WalletScreeningService(sdk.wallets, screeningConfig);
  const stateStore = new VoteStateStore('./data/quorum-state.json');
  // Single namespaced state abstraction for new runtime state. Existing vote,
  // risk, and audit stores remain compatible during the migration.
  const runtimeState = new JsonStateStore('./data/polyland-state.json');
  await runtimeState.load();
  stateStore.setStateStore(runtimeState);
  const risk = new RiskManager(
    {
      dailyMaxLossPct: 0.05,
      monthlyMaxLossPct: 0.15,
      maxDrawdownFromPeak: 0.25,
      totalMaxLossPct: 0.40,
      lossSizingReduction: 0.20,
      winSizingIncrease: 0.10,
      enableDynamicSizing: true,
    },
    CONFIG.capital.totalUsd,
  );
  risk.setStateStore(runtimeState);
  // P6: survive restarts — a redeploy must not wipe a breached halt.
  RiskManager.enablePersistence('./data/risk-state.json');
  risk.loadPersistedState();
  // L11: JSONL audit trail — every fire/settlement persisted to disk.
  SignalAuditStore.enableJsonl('./data/signal-audit.jsonl');
  signalAuditStore.setStateStore(runtimeState);
  // Rebuild 30-day edge stats from the trail so a redeploy doesn't wipe the
  // significance gate's history (previously signals reset to {} every boot).
  signalAuditStore.replayJsonl('./data/signal-audit.jsonl');

  basketQuorum = new BasketQuorumService(sdk.tradingService, BASKET_QUORUM_CONFIG);
  basketQuorum.setRiskManager(risk);
  // L1: start the exit ladder. In DRY-RUN it runs in simulation mode —
  // same triggers, no orders, exits logged to the audit trail so paper
  // results measure the strategy we actually run (item 1).
  basketQuorum.startExitLadder();
  // Settled PnL -> BotState so the [risk] display line reflects reality.
  basketQuorum.onSettledTrade = (pnlUsd: number) => recordTrade(pnlUsd);
  basketQuorum.setStateStore(stateStore);
  basketQuorum.setGammaApi(sdk.gammaApi);
  basketQuorum.setSpecializationThresholds(
    screeningConfig.minCategoryTrades,
    screeningConfig.minCategoryWinRate,
  );

  // Wire anti-sniper guard (lihanyu81/polymarket_lp_tool pattern). Protects
  // against copy-sniping and thin-book fills. Configurable via env.
  // Defaults match the 16h-audit relaxation in DEFAULT_ANTI_SNIPER_CONFIG
  // (0.08/500ms/3s) — the leader's own fill IS the jump; don't block on it.
  const antiSniperConfig = {
    midJumpThreshold: parseFloat(process.env.ANTI_SNIPER_MID_JUMP ?? '0.08'),
    midStableConfirmMs: parseInt(process.env.ANTI_SNIPER_STABLE_MS ?? '500', 10),
    fillCooldownMs: parseInt(process.env.ANTI_SNIPER_FILL_COOLDOWN_MS ?? '5000', 10),
    maxRepriceTicks: parseInt(process.env.ANTI_SNIPER_MAX_REPRICE_TICKS ?? '2', 10),
    midJumpLookbackMs: parseInt(process.env.ANTI_SNIPER_LOOKBACK_MS ?? '3000', 10),
  };
  const antiSniper = new AntiSniperGuard(null, antiSniperConfig);
  basketQuorum.setAntiSniper(antiSniper);
  log('QUORUM', `Anti-sniper guard: ${JSON.stringify(antiSniperConfig)}`);

  // Wire Chainlink TWAP oracle (KingSparta69/MattheusFeittosa pattern) for
  // crypto Up/Down markets. Connects to wss://ws-live-data.polymarket.com
  // and subscribes to crypto_prices_twap_thirty/sixty topics.
  const twapOracle = new ChainlinkTwapOracle({
    autoReconnect: true,
    reconnectDelayMs: 3_000,
    pingIntervalMs: 5_000,
    maxStalenessMs: parseInt(process.env.TWAP_MAX_STALENESS_MS ?? '30000', 10),
  });
  if (process.env.TWAP_ENABLED !== 'false') {
    basketQuorum.setTwapOracle(twapOracle);
    twapOracle.connect().catch((err) => {
      log('WARN', `TWAP oracle connect failed: ${err instanceof Error ? err.message : err}`);
    });
    log('QUORUM', 'Chainlink TWAP oracle wired (crypto baskets enabled)');
  } else {
    log('QUORUM', 'Chainlink TWAP oracle disabled via TWAP_ENABLED=false');
  }

  // Collect wallets from all sources (manual + auto)
  log('QUORUM', 'Collecting wallets...');
  const candidates = await ingestion.collect();
  log('QUORUM', `Ingested ${candidates.length} candidates`);

  if (candidates.length === 0) {
    log('WARN', 'No wallet candidates — check WALLET_SOURCES or leaderboard access');
    return;
  }

  // Wire trade feed IMMEDIATELY — before screening — so we don't miss trades
    // during the 5-15min it takes to screen 250+ candidates. filterAddresses is
    // empty here: onTrade() filters by basket membership, so we capture all trades
    // and discard the ones from wallets that don't end up seeded.
    // Once seeding completes, basketQuorum.seed(primaries) sets the wallet list.
    const tradeBuffer: SmartMoneyTrade[] = [];
    const SEED_BUFFER_LIMIT = 1000;
    quorumSubscription = sdk.smartMoney.subscribeSmartMoneyTrades(
      (trade: SmartMoneyTrade) => {
        // Buffer trades until seed() completes (otherwise they'd be dropped
        // because no baskets exist yet). The buffer is bounded; if screening
        // takes longer than the trade volume we drop oldest.
        if (!basketQuorum || basketQuorum.getBasketCount() === 0) {
          if (tradeBuffer.length < SEED_BUFFER_LIMIT) tradeBuffer.push(trade);
          return;
        }
        // Feed the price as a mid observation to the anti-sniper guard
        // (if a tokenId is available). This builds the rolling mid buffer
        // used by the mid-jump and mid-stable checks.
        if (trade.tokenId && trade.price) {
          basketQuorum.observeMid(trade.tokenId, trade.price);
        }
        basketQuorum.onTrade(trade);
      },
      { filterAddresses: [], smartMoneyOnly: false },
    );

    // --- Gamma resolution poller (replaces dead RTDS market_resolved topic) ---
    // The RTDS clob_market/market_resolved topic is deprecated and delivers
    // nothing.  Poll Gamma every 5 min for settled markets; any that have
    // resolved are settled via basketQuorum.handleMarketResolved(), which
    // updates the audit trail, basket winRate EMAs, and RiskManager P&L.
    gammaPoller = new GammaResolutionPoller(sdk.gammaApi, basketQuorum, 5 * 60 * 1000);
    gammaPoller.start();
    log('QUORUM', 'Gamma resolution poller active (edge/risk settlement loop active)');

    // --- CLOB market WebSocket for mid-price feed (replaces dead RTDS clob_market) ---
    // The RTDS clob_market topic is deprecated ("CLOB messages not supported").
    // Use the official CLOB market WebSocket instead, which provides book_update,
    // price_change, and last_trade_price for subscribed assets.
    // The mid-price feed is used by the anti-sniper guard to confirm price
    // stability before allowing a fire; without it the guard blocks on
    // no_mid_observations or mid_unstable.
    clobWs = new ClobMarketWsService();

        // Wire mid observations to the anti-sniper guard.
        // onMid fires on every price_change / last_trade from the CLOB WS.
        clobWs.onMid(({ assetId, price }) => {
          basketQuorum?.observeMid(assetId, price);
        });

        // Note: clobWs.start() is deferred until the first requestMidFeed()
        // call. An empty subscribe message causes the server to push every
        // market's snapshot, leading to immediate slow-consumer disconnects.

    // Dynamic subscription to CLOB market WS — request mid observations for a token
    // whenever the anti-sniper guard shows interest.  The CLOB WS subscribes to
    // all assets globally (server-side filtering), so we just call subscribe()
    // with the tokenId to start receiving its book/price/lastTrade events.
    const requestMidFeed = (tokenId: string) => {
      if (!clobWs) return;
      // ClobMarketWsService.subscribe() is idempotent; calling repeatedly is safe.
      clobWs.subscribe([tokenId]);
    };
    log('QUORUM', 'CLOB market WS ready (mid feed active)');

    // Screen and score wallets. Screening is expensive (profile, activity,
    // and closed-position API calls), so reuse a bounded 6h cache when the
    // candidate universe and screening config are unchanged. The cache is a
    // JSON file, not a database; on Zeabur it survives only if /data is backed
    // by a persistent volume. A cache miss safely falls back to full screening.
    log('QUORUM', 'Screening wallets...');
    const screeningCachePath = './data/wallet-screening.json';
    const screeningCacheTtlMs = 6 * 60 * 60 * 1000;
    const cacheKey = JSON.stringify({
      version: 1,
      candidates: candidates.map((c) => ({ address: c.address, source: c.source, autoRank: c.autoRank })).sort((a, b) => a.address.localeCompare(b.address)),
      config: screeningConfig,
    });
    let screened: Awaited<ReturnType<WalletScreeningService['score']>> | null = null;
    try {
      const cached = JSON.parse(await fs.readFile(screeningCachePath, 'utf8')) as {
        savedAt?: number; cacheKey?: string; screened?: Awaited<ReturnType<WalletScreeningService['score']>>;
      };
      if (cached.cacheKey === cacheKey && cached.savedAt && Date.now() - cached.savedAt < screeningCacheTtlMs && Array.isArray(cached.screened)) {
        screened = cached.screened;
        log('QUORUM', `Loaded ${screened.length} wallets from screening cache (age=${Math.round((Date.now() - cached.savedAt) / 60000)}m)`);
      } else {
        log('QUORUM', 'Wallet screening cache miss or expired; refreshing profiles and scores');
      }
    } catch {
      // First boot, missing volume, or corrupt cache: perform a fresh screen.
    }
    if (!screened) {
      screened = await screening.score(candidates);
      try {
        await fs.mkdir('./data', { recursive: true });
        await fs.writeFile(screeningCachePath, JSON.stringify({ savedAt: Date.now(), cacheKey, screened }), 'utf8');
        await runtimeState.save({ screening: { savedAt: Date.now(), cacheKey, screened } });
      } catch (err) {
        log('WARN', `Could not persist wallet screening cache: ${err instanceof Error ? err.message : err}`);
      }
    }
    await runtimeState.save({ walletUniverse: screened });
    const primaries = screened.filter((w) => w.tier === 'PRIMARY' || w.tier === 'SATELLITE');
    const nPrimary = screened.filter((w) => w.tier === 'PRIMARY').length;
    const nSatellite = screened.filter((w) => w.tier === 'SATELLITE').length;
    log('QUORUM', `Screened: ${screened.length} total, ${primaries.length} PRIMARY/SATELLITE (${nPrimary}P/${nSatellite}S)`);
    if (nPrimary === 0) {
      log('WARN', 'ZERO PRIMARY wallets — tiered quorum needs 2xPRIMARY or 1P+2S; only the 5xSATELLITE escape hatch can fire');
    }

    // Debug: log top 10 candidates by CopyScore (even if not seeded) to diagnose thresholds
    const sorted = [...screened].sort((a, b) => b.copyScore - a.copyScore);
    const top10 = sorted.slice(0, 10).map((w) =>
      `${w.tier}[${w.copyScore}]${w.category}(${w.reason.slice(0, 40)})`
    ).join(' | ');
    log('QUORUM', `Top10: ${top10}`);

    if (primaries.length === 0) {
      log('WARN', 'No PRIMARY/SATELLITE wallets passed screening');
      return;
    }

    // Seed baskets with screened wallets
    basketQuorum.seed(primaries);

    // Bonferroni correction denominator = number of active baskets.
    // More filter dimensions tested → stricter significance threshold.
    setBonferroniGroups(basketQuorum.getBasketCount());

    // Anti-sniper mid feed: whenever a market+outcome builds near-miss
    // consensus or gets blocked by the guard, subscribe its book so the
    // guard accumulates real mid observations (fixes no_mid_observations).
    basketQuorum.onMidInterest = (tokenId) => requestMidFeed(tokenId);

    // Drain the buffered trades captured during screening. These are trades from
    // wallets that may already be PRIMARY/SATELLITE; replaying them lets the
    // basket-quorum count votes that arrived in the gap.
    if (tradeBuffer.length > 0) {
      log('INFO', `Replaying ${tradeBuffer.length} buffered trades post-seed`);
      for (const trade of tradeBuffer) basketQuorum.onTrade(trade);
      tradeBuffer.length = 0;
    }

  // Periodic funnel logging every 5 minutes
  setInterval(() => {
    if (basketQuorum) {
      basketQuorum.logFunnel();
      const stats = basketQuorum.getStats();
      log('INFO',
        `Quorum stats: fired=${stats.quorumFired} executed=${stats.executed} failed=${stats.failed}` +
        ` antiSniper=${stats.quorumSkippedAntiSniper ?? 0}` +
        ` twapStale=${stats.quorumSkippedTwapStale ?? 0}` +
        ` twapMisaligned=${stats.quorumSkippedTwapMisaligned ?? 0}` +
        ` thinLiq=${stats.quorumSkippedThinLiquidity ?? 0}` +
        ` negEdge=${stats.quorumSkippedNegativeEdge ?? 0}`,
      );
    }
  }, 5 * 60 * 1000);

  // NOTE: no separate firehose subscription. subscribeSmartMoneyTrades already
  // subscribes to all activity; a SECOND subscribeAllActivity sends a duplicate
  // subscription that the Polymarket server rejects (connection_id_fk error),
  // disconnecting the websocket and killing the quorum trade feed. observed =
  // trades from seeded wallets is logged by the funnel every 5 min.

  const basketCount = basketQuorum.getBasketCount();
  log('QUORUM', `Basket quorum running — monitoring ${primaries.length} wallets across ${basketCount} baskets`);
}


// ============================================================================
// STATUS DISPLAY
// ============================================================================

function displayStatus() {
  const runtime = Math.round((Date.now() - state.startTime) / 1000 / 60);
  const mode = CONFIG.dryRun ? 'DRY RUN' : 'LIVE';
  const status = state.permanentlyHalted ? 'HALTED' : state.isPaused ? 'PAUSED' : 'ACTIVE';

  // Pull live quorum funnel + edge audit stats.
  const f = basketQuorum ? basketQuorum.getStats() : null;
  const e = signalAuditStore.getStats();

  const lines: string[] = [];
  lines.push(`[status] t=${runtime}m mode=${mode} ${status}`);
  if (f) {
    const conversion = f.quorumFired === 0 ? 0 : (f.executed / f.quorumFired * 100).toFixed(1);
    const antiSniper = f.quorumSkippedAntiSniper ?? 0;
    const twapStale = f.quorumSkippedTwapStale ?? 0;
    const twapMisaligned = f.quorumSkippedTwapMisaligned ?? 0;
    const thinLiq = f.quorumSkippedThinLiquidity ?? 0;
    const negEdge = f.quorumSkippedNegativeEdge ?? 0;
    lines.push(
      `[quorum] received=${f.feedReceived} ignored=${f.ignoredNoBasket + f.ignoredNotMember + f.ignoredUnsupportedSide + f.ignoredInvalidMarket} ` +
      `recorded=${f.votesRecorded} ` +
      `filtered=${f.quorumSkippedThinEdge + f.quorumSkippedStaleMarket}` +
      `(thin=${f.quorumSkippedThinEdge},stale=${f.quorumSkippedStaleMarket}) fired=${f.quorumFired}` +
      ` risk=${f.quorumSkippedRiskHalt} bankroll=${f.quorumSkippedBankroll} drift=${f.quorumSkippedDrift}` +
      ` antiSniper=${antiSniper} twap=${twapStale}/${twapMisaligned} liq=${thinLiq} negEdge=${negEdge}` +
      ` executed=${f.executed} failed=${f.failed} conv=${conversion}%`
    );
  }
  if (e.signalsSettled > 0) {
    lines.push(
      `[edge] exp=${e.meanExpectedEdge.toFixed(4)} real=${e.meanRealizedEdge.toFixed(4)}` +
      ` alpha=${e.edgeAlpha.toFixed(4)} sig=${e.isSignificant}` +
      ` (n=${e.signalsSettled} settled/${e.signalsFired} fired)`
    );
  } else {
    lines.push(`[edge] no settled signals yet (fired=${e.signalsFired})`);
  }
  const dailyPct = (Math.abs(state.dailyPnL) / CONFIG.capital.totalUsd * 100).toFixed(1);
  const monthlyPct = (Math.abs(state.monthlyPnL) / CONFIG.capital.totalUsd * 100).toFixed(1);
  lines.push(
    `[risk] daily=${dailyPct}% monthly=${monthlyPct}% drawdown=${(state.currentDrawdown * 100).toFixed(1)}%` +
    ` streak=${state.consecutiveLosses}L/${state.consecutiveWins}W`
  );
  console.log(lines.join('\n'));
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.clear();
  console.log('POLYMARKET BASKET-QUORUM COPY TRADER v1.0');
  console.log('mode: ' + (CONFIG.dryRun ? 'DRY RUN (paper)' : 'LIVE') + '\n');

  // Paper mode: DRY_RUN defaults to true (process.env.DRY_RUN !== 'false').
  // A missing key boots with an ephemeral read-only wallet — the bot runs
  // the full quorum pipeline (ingest → screen → seed → funnel logs) but
  // cannot and will not place orders. Live mode requires a real key.
  const hasKey = Boolean(process.env.POLYMARKET_PRIVATE_KEY);
  if (!hasKey && !CONFIG.dryRun) {
    log('ERROR', 'POLYMARKET_PRIVATE_KEY required for live trading (DRY_RUN=false). Set it in Zeabur → Service → Variables.');
    process.exit(1);
  }
  if (!hasKey) {
    log('WARN', 'POLYMARKET_PRIVATE_KEY not set — booting in PAPER MODE (read-only, no orders).');
    log('WARN', 'Set POLYMARKET_PRIVATE_KEY in Zeabur → Service → Variables to enable live copy trading.');
    process.env.POLYMARKET_PRIVATE_KEY = '0x' + '11'.repeat(32);  // ephemeral, never funds anything
  }

  log('INFO', 'Configuration', {
    capital: `$${CONFIG.capital.totalUsd}`,
    dryRun: CONFIG.dryRun,
    strategy: 'basket-quorum',
  });

  const sdk = await PolymarketSDK.create({
    privateKey: process.env.POLYMARKET_PRIVATE_KEY,
  });

  log('INFO', `Wallet: ${sdk.tradingService.getAddress()}`);

  await setupBasketQuorum(sdk);

  displayStatus();
  setInterval(displayStatus, 60000);

  const shutdown = async (sig: string) => {
    console.log(`\n\nShutting down (${sig})...`);
    if (quorumSubscription) quorumSubscription.unsubscribe();
    if (gammaPoller) gammaPoller.stop();
    if (clobWs) clobWs.stop();
    if (midFeedSubscription) midFeedSubscription.unsubscribe();
    sdk.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  // Zeabur sends SIGTERM before killing the container on redeploy — without
  // this handler, deploys orphan in-flight state (no vote persist, no WS close).
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  log('INFO', '🚀 Bot v3.0 running! Press Ctrl+C to stop.\n');
}

main().catch((err) => {
  log('ERROR', `Fatal: ${err.message}`);
  console.error(err);
  process.exit(1);
});
