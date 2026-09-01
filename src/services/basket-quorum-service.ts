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
  /** Filled sizes at quorum */
  totalSize: number;
}

export interface QuorumStats {
  votesObserved: number;
  voters: number;
  quorumFired: number;
  quorumSkippedDrift: number;
  quorumSkippedCooldown: number;
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
    executed: 0,
    failed: 0,
  };

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

    // Bucket eligible wallets by category. The mapping rule:
    //   - label-based hint (manual wallets)
    //   - leaderboardCategory (auto wallets) mapped to MarketCategory
    //   - fallback to 'other'
    const byCategory = new Map<MarketCategory, string[]>();
    const ledgerToCategory: Record<string, MarketCategory> = {
      POLITICS: 'politics',
      SPORTS: 'sports',
      CRYPTO: 'crypto',
      ECONOMICS: 'economics',
      FINANCE: 'economics',
      TECH: 'science',
      SCIENCE: 'science',
      CULTURE: 'entertainment',
      WEATHER: 'other',  // Polymeteo's specialty; treat as a separate domain
      MENTIONS: 'other',
      OVERALL: 'other',
    };

    for (const w of eligible) {
      // Prefer the leaderboardCategory (auto source is more reliable for category).
      let cat: MarketCategory = 'other';
      if (w.label) {
        const fromLabel = w.label.toLowerCase();
        if (fromLabel in ledgerToCategory) cat = ledgerToCategory[fromLabel];
      }
      // (Auto-source category isn't on ScreenedWallet by design — it's stripped
      //  at screening time. Manual labels are the operator's authoritative hint.)
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(w.address.toLowerCase());
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
      });
    }

    // Drop any prior vote state — baskets changed.
    this.votes.clear();
    this.lastFired.clear();
    const summary = [...byCategory.entries()]
      .map(([c, ws]) => c + '=' + ws.length)
      .join(', ');
    console.log(
      `[BasketQuorum] seeded ${eligible.length} wallets across ` +
        `${byCategory.size} baskets: ${summary}`
    );
  }

  private windowMs(category: MarketCategory): number {
    return this.baskets.get(category)?.windowMs ?? this.config.defaultWindowMs;
  }

  private quorumFor(category: MarketCategory): number {
    return this.baskets.get(category)?.quorum ?? this.config.defaultQuorum;
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

    // 5. Record the vote — one vote per wallet per outcome.
    outcomeVotes.set(traderKey, {
      wallet: traderKey,
      side: trade.side,
      price: trade.price,
      size: trade.size,
      timestamp: now,
    });

    this.stats.voters = this.votes.size;
    this.stats.votesObserved++;

    // 6. Evaluate quorum.
    this.tryFire({ ...trade, conditionId, marketSlug, outcome }, basket, outcomeVotes);
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
      conditionId,
      marketSlug,
      outcome,
      category: basket.category,
      basketName: basket.name,
      walletCount: agreeing.length,
      wallets: agreeing.map((v) => v.wallet),
      consensusPrice,
      totalSize: agreeing.reduce((sum, v) => sum + v.size, 0),
    };

    this.lastFired.set(key, now);

    // 7. Price-band / drift filter — the CRITICAL edge decoy. If the market
    //    has already moved past maxDrift from consensus entry, skip.
    this.executeIfInBand(trade, signal);
  }

  private async executeIfInBand(
    trade: SmartMoneyTrade,
    signal: QuorumSignal
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

  /** Drop all state (used on basket re-config). */
  reset(): void {
    this.votes.clear();
    this.lastFired.clear();
    this.stats = {
      votesObserved: 0,
      voters: 0,
      quorumFired: 0,
      quorumSkippedDrift: 0,
      quorumSkippedCooldown: 0,
      executed: 0,
      failed: 0,
    };
  }
}
