/**
 * Polyland — Basket-Quorum Copy Trading Bot
 *
 * The ONLY active strategy is basket-quorum copy trading: watch a screened
 * set of expert wallets, fire only when K distinct wallets in a category
 * basket agree on the same outcome within a rolling window, then copy with
 * risk-managed sizing.
 */
import 'dotenv/config';
import { PolymarketSDK, PolylandRuntime, type BasketQuorumConfig } from './src/index.js';
import { BotMetrics, startMetricsServer } from './src/services/bot-metrics.js';
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
      topN: Number(process.env.SMART_MONEY_TOP_N ?? 100), // expanded candidate pool for quality-basket discovery
      // Screening thresholds remain strict by default; paper mode can widen
      // discovery without enabling live risk by setting SMART_MONEY_MIN_PNL.
      minWinRate: 0.60,
      minPnl: Number(process.env.SMART_MONEY_MIN_PNL ?? 500),  // paper mode can lower via env
      minTrades: 30,     // Up from 20 to 30
      // 🔴 NEW: Quality filters
      minProfitFactor: 1.5,  // Total wins / total losses >= 1.5x
      minConsistencyScore: 0.7,  // Recent performance score
      maxSingleTradeExposure: 0.3,  // Max 30% of PnL from one trade
      checkLastNTrades: 10,  // Analyze last 10 trades for consistency
      sizeScale: 0.2,
            maxSizePerTrade: 15,
            maxSlippage: 0.10,
            minTradeSize: 1,
      // 🔴 ENTRY CEILING: never buy consensus above this price (asymmetry guard).
      // 0.85 default — the audit's 0.90-0.95 top-buy loss driver. Now env-tunable
      // via BASKET_MAX_ENTRY_PRICE so the cap is actually CONFIGURABLE (it was a
      // hardcoded engine/planner default before; the effective executed price
      // could still reach 0.90 via the CopyPlanner VWAP adoption).
      maxEntryPrice: parseFloat(process.env.BASKET_MAX_ENTRY_PRICE ?? '0.85'),
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
const BASKET_QUORUM_CONFIG: BasketQuorumConfig = {
  // Quorum of 2 distinct, vetted wallets per basket. With ~67 leaderboard
  // candidates yielding only 2-7 quality wallets, 2 is the minimum viable
  // consensus (still "two independent experts agreed", not one wallet's luck).
  // Raise to 3+ if the candidate pool grows.
  defaultQuorum: 2,
    defaultWindowMs: 4 * 60 * 60 * 1000,   // 4-hour rolling window — accumulate more votes
    maxPriceDrift: 0.30,                   // loosened from 0.05 — drift=297/10min was the #1 kill
    fireCooldownMs: 10 * 60 * 1000,
    sizeScale: CONFIG.smartMoney.sizeScale,
    maxSizePerTrade: CONFIG.smartMoney.maxSizePerTrade,
    maxSlippage: CONFIG.smartMoney.maxSlippage,
    orderType: 'FOK',
    minTradeSize: CONFIG.smartMoney.minTradeSize,
  dryRun: CONFIG.dryRun,
  /** Entry-price ceiling (0-1): reject consensus above this. 0.85 default. */
  maxEntryPrice: CONFIG.smartMoney.maxEntryPrice,
  bankrollAllocation: {
    crypto: 0.20,
    politics: 0.10,
    sports: 0.03,
    football: 0.06,
    basketball: 0.06,
    tennis: 0.02,
    motorsports: 0.04,
    boxing_ufc: 0.05,
    esports: 0.05,
    baseball: 0.04,
    cricket: 0.03,
    economics: 0.04,
    entertainment: 0.04,
    science: 0.04,
    other: 0.02,
    // remainder (0.18) = reserve, unallocated.
    // NOTE: every category MUST be listed — seed() rebuilds baskets for all
    // 15 categories from wallet data, and an unlisted category defaults to a
    // 100%-of-capital slice (observed: other=107 wallets got the full bankroll).
  },
  baskets: [
    {
      name: 'Crypto Quorum',
      category: 'crypto',
      enabled: true,
      wallets: [],
      quorum: 1,
      windowMs: 4 * 60 * 60 * 1000,
      winRate: 0.52,
    },
    {
      name: 'Sports Quorum',
      category: 'sports',
      enabled: true,
      wallets: [],
      quorum: 1,
      windowMs: 4 * 60 * 60 * 1000,
      winRate: 0.52,
    },
    {
      name: 'Football Quorum',
      category: 'football',
      enabled: true,
      wallets: [],
      quorum: 1,
      windowMs: 4 * 60 * 60 * 1000,
      winRate: 0.52,
    },
    {
      name: 'Basketball Quorum',
      category: 'basketball',
      enabled: true,
      wallets: [],
      quorum: 1,
      windowMs: 4 * 60 * 60 * 1000,
      winRate: 0.52,
    },
    {
      name: 'Tennis Quorum',
      category: 'tennis',
      enabled: true,
      wallets: [],
      quorum: 1,
      windowMs: 4 * 60 * 60 * 1000,
      winRate: 0.5,
    },
    {
      name: 'Motorsports Quorum',
      category: 'motorsports',
      enabled: true,
      wallets: [],
      quorum: 1,
      windowMs: 4 * 60 * 60 * 1000,
      winRate: 0.52,
    },
    {
      name: 'Boxing/UFC Quorum',
      category: 'boxing_ufc',
      enabled: true,
      wallets: [],
      quorum: 1,
      windowMs: 4 * 60 * 60 * 1000,
      winRate: 0.52,
    },
    {
      name: 'Baseball Quorum',
      category: 'baseball',
      enabled: true,
      wallets: [],
      quorum: 1,
      windowMs: 4 * 60 * 60 * 1000,
      winRate: 0.52,
    },
    {
      name: 'Cricket Quorum',
      category: 'cricket',
      enabled: true,
      wallets: [],
      quorum: 1,
      windowMs: 4 * 60 * 60 * 1000,
      winRate: 0.52,
    },
    {
      name: 'Politics Quorum',
      category: 'politics',
      enabled: true,
      wallets: [],
      quorum: 1,
      windowMs: 4 * 60 * 60 * 1000,
      winRate: 0.5,
    },
    {
      name: 'Esports Quorum',
      category: 'esports',
      enabled: true,
      wallets: [],
      quorum: 1,
      windowMs: 4 * 60 * 60 * 1000,
      winRate: 0.52,
    },
    {
      name: 'Economics Quorum',
      category: 'economics',
      enabled: true,
      wallets: [],
      quorum: 1,
      windowMs: 4 * 60 * 60 * 1000,
      winRate: 0.5,
    },
    {
      name: 'Entertainment Quorum',
      category: 'entertainment',
      enabled: true,
      wallets: [],
      quorum: 1,
      windowMs: 4 * 60 * 60 * 1000,
      winRate: 0.5,
    },
    {
      name: 'Science Quorum',
      category: 'science',
      enabled: true,
      wallets: [],
      quorum: 1,
      windowMs: 4 * 60 * 60 * 1000,
      winRate: 0.5,
    },
    {
      name: 'Other Quorum',
      category: 'other',
      enabled: true,
      wallets: [],
      quorum: 1,
      windowMs: 4 * 60 * 60 * 1000,
      winRate: 0.5,
    },
  ],
};
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
    minCategoryTrades: 12,
    maxInactiveDays: 60,   // edge decays — 60d matches Poly Syncer window
  };
// ============================================================================
// STATUS DISPLAY
// ============================================================================
function displayStatus(runtime: PolylandRuntime) {
  const snapshot = runtime.getStateSnapshot();
  const f = runtime.getFunnelStats();
  const e = runtime.getAuditStats();
  const runtimeMinutes = Math.round((Date.now() - snapshot.startTime) / 60000);
  const status = snapshot.permanentlyHalted ? 'HALTED' : snapshot.isPaused ? 'PAUSED' : 'ACTIVE';
  const lines: string[] = [`[status] t=${runtimeMinutes}m mode=${CONFIG.dryRun ? 'DRY RUN' : 'LIVE'} ${status}`];
  if (f) {
    const conversion = f.quorumFired === 0 ? 0 : (f.executed / f.quorumFired * 100).toFixed(1);
    lines.push(`[quorum] received=${f.feedReceived} ignored=${f.ignoredNoBasket + f.ignoredNotMember + f.ignoredUnsupportedSide + f.ignoredInvalidMarket} recorded=${f.votesRecorded} filtered=${f.quorumSkippedThinEdge + f.quorumSkippedStaleMarket} fired=${f.quorumFired} risk=${f.quorumSkippedRiskHalt} bankroll=${f.quorumSkippedBankroll} drift=${f.quorumSkippedDrift} antiSniper=${f.quorumSkippedAntiSniper ?? 0} twap=${f.quorumSkippedTwapStale ?? 0}/${f.quorumSkippedTwapMisaligned ?? 0} liq=${f.quorumSkippedThinLiquidity ?? 0} negEdge=${f.quorumSkippedNegativeEdge ?? 0} execSkips=${f.quorumSkippedStaleQuote ?? 0}/${f.quorumSkippedFeedStale ?? 0}/${f.quorumSkippedQuality ?? 0} nearMiss=${f.quorumNearMissIndependence ?? 0}/${f.quorumNearMissConsensus ?? 0}/${f.quorumNearMissExecution ?? 0} executed=${f.executed} failed=${f.failed} conv=${conversion}%`);
  }
  lines.push(e.signalsSettled > 0 ? `[edge] exp=${e.meanExpectedEdge.toFixed(4)} real=${e.meanRealizedEdge.toFixed(4)} alpha=${e.edgeAlpha.toFixed(4)} sig=${e.isSignificant} (n=${e.signalsSettled} settled/${e.signalsFired} fired)` : `[edge] no settled signals yet (fired=${e.signalsFired})`);
    lines.push(runtime.goLiveStatusLine());
    lines.push(`[risk] daily=${(snapshot.dailyPnL / CONFIG.capital.totalUsd * 100).toFixed(1)}% monthly=${(snapshot.monthlyPnL / CONFIG.capital.totalUsd * 100).toFixed(1)}% drawdown=${(snapshot.currentDrawdown * 100).toFixed(1)}% streak=${snapshot.consecutiveLosses}L/${snapshot.consecutiveWins}W`);
  console.log(lines.join('\n'));
}
// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.clear();
  console.log('POLYMARKET BASKET-QUORUM COPY TRADER v1.0');
  console.log('mode: ' + (CONFIG.dryRun ? 'DRY RUN (paper)' : 'LIVE') + '\n');
  const hasKey = Boolean(process.env.POLYMARKET_PRIVATE_KEY);
  if (!hasKey && !CONFIG.dryRun) {
    log('ERROR', 'POLYMARKET_PRIVATE_KEY required for live trading (DRY_RUN=false).');
    process.exit(1);
  }
  if (!hasKey) {
    log('WARN', 'POLYMARKET_PRIVATE_KEY not set — booting in PAPER MODE (read-only, no orders).');
    process.env.POLYMARKET_PRIVATE_KEY = '0x' + '11'.repeat(32);
  }
  const sdk = await PolymarketSDK.create({ privateKey: process.env.POLYMARKET_PRIVATE_KEY });
  log('INFO', `Wallet: ${sdk.tradingService.getAddress()}`);
  // Prometheus-format metrics: histograms of entry price / PnL per share /
  // hold duration that the funnel log line cannot express. Disabled unless
  // PROMETHEUS_PORT is set. Once a `curl http://host:9090/metrics` works, a
  // notebook can query "what's the realized-edge p50 in crypto sub-hour?" —
  // the question the audit repeatedly couldn't answer from the log line.
  const botMetrics = new BotMetrics();
  const promPort = Number(process.env.PROMETHEUS_PORT ?? 0);
  let metricsServer: import('node:http').Server | null = null;
  if (promPort > 0) {
    metricsServer = startMetricsServer(botMetrics, promPort);
  } else {
    log('INFO', 'Prometheus /metrics disabled (set PROMETHEUS_PORT to enable)');
  }
  const runtime = new PolylandRuntime(
    sdk,
    {
      dryRun: CONFIG.dryRun,
      capital: CONFIG.capital,
      risk: CONFIG.risk,
      smartMoney: CONFIG.smartMoney,
      botMetrics, // wire the parallel Prometheus surface
      // Paper-fire window: broaden basket membership so consensus can form
      // and exercise the full pipeline in DRY_RUN (PAPER_BROADEN_MEMBERSHIP=true).
      paperExploration: process.env.PAPER_BROADEN_MEMBERSHIP === 'true',
    },
    screeningConfig,
    BASKET_QUORUM_CONFIG,
    recordTrade,
  );
  await runtime.start();
  displayStatus(runtime);
  const statusTimer = setInterval(() => displayStatus(runtime), 60000);
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(statusTimer);
    console.log(`\\n\\nShutting down (${sig})...`);
    if (metricsServer) {
      await new Promise<void>((resolve) => metricsServer!.close(() => resolve()));
    }
    await runtime.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  log('INFO', '🚀 Bot v3.0 running! Press Ctrl+C to stop.\\n');
}
main().catch((err) => {
  log('ERROR', `Fatal: ${err.message}`);
  console.error(err);
  process.exit(1);
});
