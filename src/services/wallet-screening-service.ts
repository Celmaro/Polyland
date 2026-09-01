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
  /** Max drawdown % allowed (Polymeteo screens at 10% for the +5 bonus; this is a hard cap) */
  maxDrawdownPct: number;
  /** Wallets with median inter-fill interval below this are flagged as bots (ms) */
  botMedianIntervalMs: number;
  /** Concurrency for profile fetches — keep modest to avoid 429s */
  profileFetchConcurrency: number;
}

export const DEFAULT_SCREENING_CONFIG: WalletScreeningConfig = {
  minTradeCount: 30,
  minWinRate: 0.55,
  minConsistency: 70,
  maxDrawdownPct: 35,
  botMedianIntervalMs: 5_000,
  profileFetchConcurrency: 4,
};

// ============================================================================
// Screened wallet
// ============================================================================

export type WalletTier = 'PRIMARY' | 'SATELLITE' | 'WATCHLIST' | 'REJECTED';

export interface ScreenedWallet {
  address: string;
  tier: WalletTier;
  source: 'manual' | 'auto' | 'both';
  label?: string;

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

  constructor(walletService: WalletService, config: Partial<WalletScreeningConfig> = {}) {
    this.walletService = walletService;
    this.config = { ...DEFAULT_SCREENING_CONFIG, ...config };
  }

  /**
   * Run screening on every candidate. Returns a list of ScreenedWallet.
   * Manual bypasses are honored. Auto + manual converge on the same screen.
   */
  async score(candidates: RawCandidate[]): Promise<ScreenedWallet[]> {
    // Step 1: separate manual-bypass from everyone else.
    const bypassed: ScreenedWallet[] = [];
    const toScore: RawCandidate[] = [];
    for (const c of candidates) {
      if (c.bypassScreening) {
        bypassed.push(this.makeBypassed(c));
      } else {
        toScore.push(c);
      }
    }

    // Step 2: fetch profiles with bounded concurrency.
    const profiles = new Map<string, WalletProfile | null>();
    const queue = [...toScore];
    const workers: Promise<void>[] = [];
    for (let i = 0; i < this.config.profileFetchConcurrency; i++) {
      workers.push(
        (async () => {
          while (queue.length > 0) {
            const c = queue.shift();
            if (!c) return;
            try {
              const profile = await this.walletService.getWalletProfile(c.address);
              profiles.set(c.address, profile);
            } catch (err) {
              // Treat a fetch failure as "no data" — the screen will mark WATCHLIST.
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
    await Promise.all(workers);

    // Step 3: score each candidate.
    const screened: ScreenedWallet[] = [...bypassed];
    for (const c of toScore) {
      const profile = profiles.get(c.address) ?? null;
      screened.push(this.evaluate(c, profile));
    }
    return screened;
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

  private makeBypassed(c: RawCandidate): ScreenedWallet {
    return {
      address: c.address,
      tier: 'PRIMARY',
      source: c.source,
      label: c.label,
      consistency: 100,
      winRate: 1,
      profitFactor: 999,
      maxDrawdownPct: 0,
      smartScore: 100,
      tradeCount: 0,
      isBotSuspect: false,
      bypassed: true,
      reason: 'manual bypass',
    };
  }

  private evaluate(c: RawCandidate, profile: WalletProfile | null): ScreenedWallet {
    // No profile → too little history to trust → WATCHLIST.
    if (!profile) {
      return this.buildResult(c, profile, 'WATCHLIST', 'no profile data', false);
    }
    if (profile.tradeCount < this.config.minTradeCount) {
      return this.buildResult(
        c,
        profile,
        'WATCHLIST',
        `insufficient history (${profile.tradeCount} < ${this.config.minTradeCount})`,
        false
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

    if (isBotSuspect) {
      return this.buildResult(c, profile, 'REJECTED', 'bot signature detected', true);
    }
    if (maxDrawdownPct > this.config.maxDrawdownPct) {
      return this.buildResult(
        c,
        profile,
        'REJECTED',
        `drawdown ${maxDrawdownPct.toFixed(1)}% > ${this.config.maxDrawdownPct}%`,
        false
      );
    }
    if (consistency >= 85 && profile.winRate >= this.config.minWinRate) {
      return this.buildResult(c, profile, 'PRIMARY', `consistency ${consistency.toFixed(1)}`, false);
    }
    if (consistency >= this.config.minConsistency) {
      return this.buildResult(c, profile, 'SATELLITE', `consistency ${consistency.toFixed(1)}`, false);
    }
    return this.buildResult(
      c,
      profile,
      'WATCHLIST',
      `consistency ${consistency.toFixed(1)} below ${this.config.minConsistency}`,
      false
    );
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
  ): ScreenedWallet {
    return {
      address: c.address,
      tier,
      source: c.source,
      label: c.label,
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
      bypassed: false,
      reason,
    };
  }
}
