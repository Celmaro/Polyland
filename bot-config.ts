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
    lines.push(`[quorum] received=${f.feedReceived} ignored=${f.ignoredNoBasket + f.ignoredNotMember + f.ignoredUnsupportedSide + f.ignoredInvalidMarket} recorded=${f.votesRecorded} filtered=${f.quorumSkippedThinEdge + f.quorumSkippedStaleMarket} fired=${f.quorumFired} risk=${f.quorumSkippedRiskHalt} bankroll=${f.quorumSkippedBankroll} drift=${f.quorumSkippedDrift} antiSniper=${f.quorumSkippedAntiSniper ?? 0} twap=${f.quorumSkippedTwapStale ?? 0}/${f.quorumSkippedTwapMisaligned ?? 0} liq=${f.quorumSkippedThinLiquidity ?? 0} negEdge=${f.quorumSkippedNegativeEdge ?? 0} executed=${f.executed} failed=${f.failed} conv=${conversion}%`);
  }
  lines.push(e.signalsSettled > 0 ? `[edge] exp=${e.meanExpectedEdge.toFixed(4)} real=${e.meanRealizedEdge.toFixed(4)} alpha=${e.edgeAlpha.toFixed(4)} sig=${e.isSignificant} (n=${e.signalsSettled} settled/${e.signalsFired} fired)` : `[edge] no settled signals yet (fired=${e.signalsFired})`);
    lines.push(runtime.goLiveStatusLine());
    lines.push(`[risk] daily=${(Math.abs(snapshot.dailyPnL) / CONFIG.capital.totalUsd * 100).toFixed(1)}% monthly=${(Math.abs(snapshot.monthlyPnL) / CONFIG.capital.totalUsd * 100).toFixed(1)}% drawdown=${(snapshot.currentDrawdown * 100).toFixed(1)}% streak=${snapshot.consecutiveLosses}L/${snapshot.consecutiveWins}W`);
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
  const runtime = new PolylandRuntime(
    sdk,
    { dryRun: CONFIG.dryRun, capital: CONFIG.capital, risk: CONFIG.risk, smartMoney: CONFIG.smartMoney },
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
