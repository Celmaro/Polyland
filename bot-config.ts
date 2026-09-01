/**
 * Polyland — Basket-Quorum Copy Trading Bot
 *
 * The ONLY active strategy is basket-quorum copy trading: watch a screened
 * set of expert wallets, fire only when K distinct wallets in a category
 * basket agree on the same outcome within a rolling window, then copy with
 * risk-managed sizing. All other strategies (arbitrage, dip-arb, direct,
 * on-chain, bridge, binance) are disabled.
 */

import 'dotenv/config';
import {
  PolymarketSDK,
  BasketQuorumService,
  WalletIngestionService,
  WalletScreeningService,
  VoteStateStore,
  RiskManager,
  type SmartMoneyTrade,
  type BasketQuorumConfig,
} from './src/index.js';
import { signalAuditStore } from './src/services/signal-audit-store.js';

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
    strategyAllocation: {
      smartMoney: 0.60,
      arbitrage: 0.20,
      dipArb: 0.10,
      directTrades: 0.10,
    },
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
    topN: 20,
    // 🔴 FIXED: Stricter criteria
    minWinRate: 0.60,  // Up from 0.50 to 60%
    minPnl: 500,       // Up from 100 to $500
    minTrades: 30,     // Up from 20 to 30

    // 🔴 NEW: Quality filters
    minProfitFactor: 1.5,  // Total wins / total losses >= 1.5x
    minConsistencyScore: 0.7,  // Recent performance score
    maxSingleTradeExposure: 0.3,  // Max 30% of PnL from one trade
    checkLastNTrades: 10,  // Analyze last 10 trades for consistency

    sizeScale: 0.1,
    maxSizePerTrade: 15,
    maxSlippage: 0.03,
    minTradeSize: 10,
    delay: 500,
    // ADD YOUR CUSTOM WALLETS HERE (will be followed in addition to leaderboard)
    customWallets: [
      '0xc2e7800b5af46e6093872b177b7a5e7f0563be51',  // Top Polymarket trader
      '0x58c3f5d66c95d4c41b093fbdd2520e46b6c9de74',  // simonbanza
      // Add more wallet addresses here...
    ] as string[],
  },

  arbitrage: {
    enabled: false,
    // 🔴 FIXED: Higher profit threshold to account for gas fees
    profitThreshold: 0.01,  // Up from 0.5% to 1%
    minTradeSize: 20,  // Up from 5 to reduce gas impact
    maxTradeSize: 100,  // Up from 50
    minVolume24h: 5000,
    autoExecute: true,
    enableRebalancer: true,

    // 🔴 NEW: Gas fee accounting
    estimatedGasCostUSD: 0.10,  // Estimated gas per arb cycle
    minNetProfit: 0.50,  // Minimum $0.50 profit after gas
  },

  dipArb: {
    enabled: false,
    coins: ['BTC', 'ETH', 'SOL'] as const,
    shares: 10,
    sumTarget: 0.92,
    autoRotate: true,
    // 🔴 NEW: Minimum trade value enforcement
    minTradeValueUSD: 1.5,  // $1.50 minimum (buffer above $1)
  },

  onchain: {
    enabled: false,
    autoApprove: true,
    minMatic: 0.5,
  },

  binance: {
    enabled: false,
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const,
    interval: '15m' as const,
    trendThreshold: 2,
  },

  directTrading: {
    enabled: false,
    trendFollowing: true,
    minTrendStrength: 0.02,
    // 🔴 NEW: Stop-loss and take-profit
    stopLossPct: 0.15,  // 15% stop loss
    takeProfitPct: 0.25,  // 25% take profit
    trailingStopPct: 0.10,  // 10% trailing stop
    maxHoldDays: 7,  // Exit after 7 days
    minRiskReward: 1.5,  // Minimum 1.5:1 risk/reward ratio
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

  // Strategy stats
  smartMoneyTrades: number;
  arbTrades: number;
  dipArbTrades: number;
  directTrades: number;
  arbProfit: number;

  // Tracked data
  followedWallets: string[];
  activeArbMarket: string | null;
  activeDipArbMarket: string | null;

  // On-chain stats
  splits: number;
  merges: number;
  redeems: number;
  swaps: number;

  // Balances
  usdcBalance: number;
  usdcEBalance: number;
  maticBalance: number;

  // Analysis
  btcTrend: 'up' | 'down' | 'neutral';
  ethTrend: 'up' | 'down' | 'neutral';
  solTrend: 'up' | 'down' | 'neutral';
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

  smartMoneyTrades: 0,
  arbTrades: 0,
  dipArbTrades: 0,
  directTrades: 0,
  arbProfit: 0,
  followedWallets: [],
  activeArbMarket: null,
  activeDipArbMarket: null,
  splits: 0,
  merges: 0,
  redeems: 0,
  swaps: 0,
  usdcBalance: 0,
  usdcEBalance: 0,
  maticBalance: 0,
  btcTrend: 'neutral',
  ethTrend: 'neutral',
  solTrend: 'neutral',
};

// ============================================================================
// UTILITIES
// ============================================================================

function log(level: string, message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const icons: Record<string, string> = {
    INFO: '📋', WARN: '⚠️', ERROR: '❌', TRADE: '💰', SIGNAL: '🎯',
    ARB: '🔄', WALLET: '👛', CHAIN: '⛓️', SWAP: '💱', BRIDGE: '🌉',
    KLINE: '📊', TREND: '📈',
  };
  console.log(`[${timestamp}] ${icons[level] || '•'} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

// 🔴 FIXED: Comprehensive risk management with multiple layers
function canTrade(): boolean {
  // Check if permanently halted
  if (state.permanentlyHalted) {
    log('ERROR', '🛑 Trading permanently halted - total loss limit reached');
    return false;
  }

  // Reset daily PnL if new day
  const daysSinceReset = (Date.now() - state.lastDailyReset) / (1000 * 60 * 60 * 24);
  if (daysSinceReset >= 1) {
    log('INFO', `Daily PnL reset. Previous day: $${state.dailyPnL.toFixed(2)}`);
    state.dailyPnL = 0;
    state.lastDailyReset = Date.now();
  }

  // Reset monthly PnL if new month
  const daysSinceMonthStart = (Date.now() - state.monthStartTime) / (1000 * 60 * 60 * 24);
  if (daysSinceMonthStart >= 30) {
    log('INFO', `Monthly PnL reset. Previous month: $${state.monthlyPnL.toFixed(2)}`);
    state.monthlyPnL = 0;
    state.monthStartTime = Date.now();
  }

  // Update current capital and drawdown
  state.currentCapital = CONFIG.capital.totalUsd + state.totalPnL;
  if (state.currentCapital > state.peakCapital) {
    state.peakCapital = state.currentCapital;
  }
  state.currentDrawdown = (state.peakCapital - state.currentCapital) / state.peakCapital;

  // Check temporary pause
  if (state.isPaused && Date.now() < state.pauseUntil) return false;
  if (state.isPaused && Date.now() >= state.pauseUntil) {
    state.isPaused = false;
    log('INFO', 'Bot resumed after cooldown');
  }

  // 🔴 Layer 1: Daily loss limit
  const dailyLossLimit = CONFIG.capital.totalUsd * CONFIG.risk.dailyMaxLossPct;
  if (state.dailyPnL <= -dailyLossLimit) {
    state.isPaused = true;
    state.pauseUntil = Date.now() + CONFIG.risk.pauseOnBreachMinutes * 60 * 1000;
    log('WARN', `Daily loss limit breached: -$${Math.abs(state.dailyPnL).toFixed(2)} (limit: $${dailyLossLimit.toFixed(2)})`);
    log('WARN', `Bot paused for ${CONFIG.risk.pauseOnBreachMinutes} minutes`);
    return false;
  }

  // 🔴 Layer 2: Monthly loss limit (NEW)
  const monthlyLossLimit = CONFIG.capital.totalUsd * CONFIG.risk.monthlyMaxLossPct;
  if (state.monthlyPnL <= -monthlyLossLimit) {
    log('ERROR', `🛑 Monthly loss limit breached: -$${Math.abs(state.monthlyPnL).toFixed(2)} (limit: $${monthlyLossLimit.toFixed(2)})`);
    log('ERROR', 'Trading paused until next month');
    state.isPaused = true;
    state.pauseUntil = Date.now() + (30 * 24 * 60 * 60 * 1000);  // Pause for 30 days
    return false;
  }

  // 🔴 Layer 3: Drawdown from peak (NEW)
  if (state.currentDrawdown >= CONFIG.risk.maxDrawdownFromPeak) {
    log('ERROR', `🛑 Maximum drawdown reached: ${(state.currentDrawdown * 100).toFixed(1)}% (limit: ${(CONFIG.risk.maxDrawdownFromPeak * 100).toFixed(1)}%)`);
    log('ERROR', `Peak: $${state.peakCapital.toFixed(2)} → Current: $${state.currentCapital.toFixed(2)}`);
    state.isPaused = true;
    state.pauseUntil = Date.now() + (7 * 24 * 60 * 60 * 1000);  // Pause for 7 days
    return false;
  }

  // 🔴 Layer 4: Total loss limit - PERMANENT HALT (NEW)
  const totalLossLimit = CONFIG.capital.totalUsd * CONFIG.risk.totalMaxLossPct;
  if (state.totalPnL <= -totalLossLimit) {
    state.permanentlyHalted = true;
    log('ERROR', '💀 TOTAL LOSS LIMIT REACHED - TRADING PERMANENTLY HALTED');
    log('ERROR', `Total loss: -$${Math.abs(state.totalPnL).toFixed(2)} (limit: $${totalLossLimit.toFixed(2)})`);
    log('ERROR', 'Please review strategy before restarting with new capital');
    return false;
  }

  return true;
}

// 🔴 FIXED: Enhanced trade recording with win tracking
function recordTrade(profit: number, strategy: string) {
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

  if (strategy === 'smartMoney') state.smartMoneyTrades++;
  else if (strategy === 'arbitrage') state.arbTrades++;
  else if (strategy === 'dipArb') state.dipArbTrades++;
  else if (strategy === 'direct') state.directTrades++;
}

// 🔴 NEW: Dynamic position sizing based on performance
function calculatePositionSize(baseSize: number): number {
  if (!CONFIG.risk.enableDynamicSizing) return baseSize;

  let size = baseSize;

  // Reduce during losing streaks
  if (state.consecutiveLosses > 2) {
    const reduction = Math.pow(1 - CONFIG.risk.lossSizingReduction, state.consecutiveLosses - 2);
    size *= reduction;
    if (CONFIG.risk.minPositionPct && size < CONFIG.risk.minPositionPct) {
      log('WARN', `Position size reduced to minimum ${(CONFIG.risk.minPositionPct * 100).toFixed(1)}% due to ${state.consecutiveLosses} consecutive losses`);
    }
  }

  // Increase slightly during winning streaks (capped)
  if (state.consecutiveWins > 3) {
    const increase = 1 + (Math.min(state.consecutiveWins - 3, 5) * CONFIG.risk.winSizingIncrease);
    size *= increase;
  }

  // Apply floor and ceiling
  size = Math.max(CONFIG.risk.minPositionPct || 0.01, size);
  size = Math.min(CONFIG.risk.maxPositionPct || 0.05, size);

  return size;
}

// ============================================================================
// 1b. BASKET QUORUM COPY TRADING
// ============================================================================

let basketQuorum: BasketQuorumService | null = null;
let quorumSubscription: { id: string; unsubscribe: () => void } | null = null;

const BASKET_QUORUM_CONFIG: BasketQuorumConfig = {
  defaultQuorum: 3,
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
    crypto: 0.60,
    sports: 0.10,
    politics: 0.10,
    esports: 0.05,
    // remainder (0.15) = reserve, unallocated
  },
  baskets: [
    {
      name: 'Crypto Quorum',
      category: 'crypto',
      enabled: true,
      wallets: [],
      quorum: 3,
      windowMs: 30 * 60 * 1000,
      winRate: 0.6,
    },
    {
      name: 'Sports Quorum',
      category: 'sports',
      enabled: true,
      wallets: [],
      quorum: 3,
      windowMs: 30 * 60 * 1000,
      winRate: 0.6,
    },
    {
      name: 'Politics Quorum',
      category: 'politics',
      enabled: true,
      wallets: [],
      quorum: 3,
      windowMs: 30 * 60 * 1000,
      winRate: 0.6,
    },
    {
      name: 'Esports Quorum',
      category: 'esports',
      enabled: true,
      wallets: [],
      quorum: 3,
      windowMs: 30 * 60 * 1000,
      winRate: 0.6,
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
      categories: ['OVERALL', 'CRYPTO', 'SPORTS', 'POLITICS'],
      refreshIntervalMs: 6 * 60 * 60 * 1000,
      sortBy: 'pnl',
    },
  });
  const screening = new WalletScreeningService(sdk.wallets, {
    profileFetchConcurrency: 10,
  });
  const stateStore = new VoteStateStore('./data/quorum-state.json');
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

  basketQuorum = new BasketQuorumService(sdk.tradingService, BASKET_QUORUM_CONFIG);
  basketQuorum.setRiskManager(risk);
  basketQuorum.setStateStore(stateStore);
  basketQuorum.setGammaApi(sdk.gammaApi);

  // Collect wallets from all sources (manual + auto)
  log('QUORUM', 'Collecting wallets...');
  const candidates = await ingestion.collect();
  log('QUORUM', `Ingested ${candidates.length} candidates`);

  if (candidates.length === 0) {
    log('WARN', 'No wallet candidates — check WALLET_SOURCES or leaderboard access');
    return;
  }

  // Screen and score wallets
  log('QUORUM', 'Screening wallets...');
  const screened = await screening.score(candidates);
  const primaries = screened.filter((w) => w.tier === 'PRIMARY' || w.tier === 'SATELLITE');
  log('QUORUM', `Screened: ${screened.length} total, ${primaries.length} PRIMARY/SATELLITE`);

  if (primaries.length === 0) {
    log('WARN', 'No PRIMARY/SATELLITE wallets passed screening');
    return;
  }

  // Seed baskets with screened wallets
  basketQuorum.seed(primaries);

  // Wire trades into quorum
  quorumSubscription = sdk.smartMoney.subscribeSmartMoneyTrades((trade: SmartMoneyTrade) => {
    basketQuorum?.onTrade(trade);
  });

  // Periodic funnel logging every 5 minutes
  setInterval(() => {
    if (basketQuorum) {
      basketQuorum.logFunnel();
      const stats = basketQuorum.getStats();
      log('INFO', `Quorum stats: fired=${stats.quorumFired} executed=${stats.executed} failed=${stats.failed}`);
    }
  }, 5 * 60 * 1000);

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
    const conversion = f.votesObserved === 0 ? 0 : (f.executed / f.votesObserved * 100).toFixed(1);
    lines.push(
      `[quorum] observed=${f.votesObserved} filtered=${f.quorumSkippedThinEdge + f.quorumSkippedStaleMarket}` +
      `(thin=${f.quorumSkippedThinEdge},stale=${f.quorumSkippedStaleMarket}) fired=${f.quorumFired}` +
      ` risk=${f.quorumSkippedRiskHalt} bankroll=${f.quorumSkippedBankroll} drift=${f.quorumSkippedDrift}` +
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
    strategies: {
      smartMoney: CONFIG.smartMoney.enabled,
      arbitrage: CONFIG.arbitrage.enabled,
      dipArb: CONFIG.dipArb.enabled,
      directTrading: CONFIG.directTrading.enabled,
    },
    onchain: CONFIG.onchain.enabled,
    binance: CONFIG.binance.enabled,
  });

  const sdk = await PolymarketSDK.create({
    privateKey: process.env.POLYMARKET_PRIVATE_KEY,
  });

  log('INFO', `Wallet: ${sdk.tradingService.getAddress()}`);

  // Setup all services
  // Only basket-quorum copy trading runs.
  // Non-quorum services disabled: setupSwap, setupOnchain, setupBridge,
  // setupBinanceAnalysis, analyzeTopWallets, queryOnchainData.
  await setupBasketQuorum(sdk);
  // setupSmartMoney(sdk); // disabled — only basket quorum copy trading runs
  // setupArbitrage(sdk);  // disabled — arbitrage not used
  // setupDipArb(sdk);     // disabled — dipArb not used
  // await setupDirectTrading(sdk);  // disabled — directTrading not used

  displayStatus();
  setInterval(displayStatus, 60000);

  process.on('SIGINT', async () => {
    console.log('\n\nShutting down...');
    if (quorumSubscription) quorumSubscription.unsubscribe();
    sdk.stop();
    process.exit(0);
  });

  log('INFO', '🚀 Bot v3.0 running! Press Ctrl+C to stop.\n');
}

main().catch((err) => {
  log('ERROR', `Fatal: ${err.message}`);
  console.error(err);
  process.exit(1);
});
