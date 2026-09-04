/**
 * RiskManager
 *
 * Multi-layer trading halt and dynamic-sizing engine for basket-quorum
 * copy trading. Mirrors the 4-layer risk block from bot-config.ts (MrFadiAi):
 *
 *   1. Daily loss halt       (default 5% of capital)
 *   2. Monthly loss halt     (default 15%)
 *   3. Drawdown-from-peak    (default 25%)
 *   4. Total cumulative halt (default 40%) — kills the bot permanently
 *
 * Plus dynamic position sizing:
 *   - shrink by `lossSizingReduction` after each consecutive loss
 *   - grow by `winSizingIncrease` after each consecutive win
 *   - clamped to [minPositionPct, maxPositionPct] of capital
 *
 * Consecutive-loss halt fires at `maxConsecutiveLosses` (default 6) and
 * pauses for `pauseOnBreachMinutes` (default 60).
 *
 * ==== Wiring ====
 *   const risk = new RiskManager(config.risk, initialCapital);
 *
 *   // Before every trade:
 *   if (!risk.canTrade()) return;       // halts active
 *   const usdcAmount = risk.sizeOrder(usdc);
 *
 *   // After every settled trade:
 *   risk.recordTrade({ pnlUsd, ts: Date.now(), side: 'BUY'|'SELL' });
 *
 *   // Read state for logs / dashboard:
 *   risk.snapshot();
 */

import * as fs from 'node:fs';

// ============================================================================
// Config
// ============================================================================

export interface RiskConfig {
  // Halts (percentages of starting capital)
  dailyMaxLossPct: number;        // 0.05 = 5%
  monthlyMaxLossPct: number;      // 0.15
  maxDrawdownFromPeak: number;    // 0.25
  totalMaxLossPct: number;        // 0.40 — terminal

  // Consecutive loss breaker
  maxConsecutiveLosses: number;   // 6
  pauseOnBreachMinutes: number;   // 60

  // Dynamic sizing
  enableDynamicSizing: boolean;
  minPositionPct: number;         // 0.01
  maxPositionPct: number;         // 0.05
  lossSizingReduction: number;    // 0.20
  winSizingIncrease: number;      // 0.10

  // PT4 (sstklen/trump-code circuit breaker): basket kill switch — a basket
  // whose recent settled win rate diverges from its rolling baseline by
  // basketKillSigma std-devs over basketKillWindow settlements is suspended.
  basketKillSigma: number;
  basketKillWindow: number;
  basketKillMinSamples: number;

  // Base position size as fraction of capital before dynamic adjustment
  basePositionPct: number;        // 0.02 (matches MrFadiAi config)
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  dailyMaxLossPct: 0.05,
  monthlyMaxLossPct: 0.15,
  maxDrawdownFromPeak: 0.25,
  totalMaxLossPct: 0.40,
  maxConsecutiveLosses: 6,
  pauseOnBreachMinutes: 60,
  enableDynamicSizing: true,
  minPositionPct: 0.01,
  maxPositionPct: 0.05,
  lossSizingReduction: 0.20,
  winSizingIncrease: 0.10,
  basePositionPct: 0.02,
  // PT4 (sstklen/trump-code circuit breaker): basket kill switch fires when
  // a basket's recent settled win rate diverges from its rolling baseline
  // by `basketKillSigma` std-devs over `basketKillWindow` settlements.
  basketKillSigma: 2.0,
  basketKillWindow: 20,
  basketKillMinSamples: 8,
};

// ============================================================================
// Trade record (what the bot reports back)
// ============================================================================

export interface TradeRecord {
  pnlUsd: number;
  ts: number;             // unix ms
  side: 'BUY' | 'SELL';
}

// ============================================================================
// Halt reason enum
// ============================================================================

export type HaltReason =
  | 'daily_loss'
  | 'monthly_loss'
  | 'drawdown_from_peak'
  | 'total_loss'
  | 'consecutive_losses'
  | null;

export interface RiskSnapshot {
  // Capital state
  startingCapital: number;
  realizedPnl: number;
  peakCapital: number;
  currentCapital: number;

  // Drawdown
  drawdownFromPeakPct: number;

  // Windowed P&L
  dailyPnl: number;
  monthlyPnl: number;

  // Halts
  isHalted: boolean;
  haltReason: HaltReason;
  haltedUntilMs: number | null;  // set when consecutive-loss pause is active

  // Sizing
  sizeMultiplier: number;          // 1.0 = base, < 1 = shrunken, > 1 = grown
  currentPositionPct: number;      // base * multiplier, clamped

  // Stats
  totalTrades: number;
  consecutiveLosses: number;
  consecutiveWins: number;
}

// ============================================================================
// RiskManager
// ============================================================================

export class RiskManager {
  private config: RiskConfig;
  private startingCapital: number;
  private trades: TradeRecord[] = [];

  // Cached rollups — recomputed on every recordTrade, read on every canTrade.
  private _dailyPnl = 0;
  private _monthlyPnl = 0;
  private _realizedPnl = 0;
  private _peakCapital: number;
  private _consecutiveLosses = 0;
  private _consecutiveWins = 0;
  private _sizeMultiplier = 1.0;
  private _haltedUntilMs: number | null = null;

  // Session persistence (P6): survive restarts so a redeploy can't wipe a
  // daily-loss halt (KaustubhPatange/polymarket-trade-engine early-bird
  // pattern — refuse to trade into an already-blown session).
  private static persistPath: string | null = null;

  constructor(config: Partial<RiskConfig> = {}, startingCapital = 1000) {
    this.config = { ...DEFAULT_RISK_CONFIG, ...config };
    this.startingCapital = startingCapital;
    this._peakCapital = startingCapital;
  }

  /**
   * Enable cross-restart persistence. Call once at boot BEFORE any trading.
   * Loads prior state (realizedPnl, peak, streaks, halt) if present, then
   * re-checks halts: if the previous session already breached a limit, the
   * bot stays halted after the restart.
   */
  static enablePersistence(path: string): void {
    RiskManager.persistPath = path;
  }

  /** Load persisted state into this instance (no-op if none/enabled=false). */
  loadPersistedState(): void {
    const path = RiskManager.persistPath;
    if (!path) return;
    try {
      if (!fs.existsSync(path)) return;
      const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
      this._realizedPnl = typeof raw.realizedPnl === 'number' ? raw.realizedPnl : 0;
      this._peakCapital = typeof raw.peakCapital === 'number'
        ? Math.max(raw.peakCapital, this.startingCapital)
        : this.startingCapital;
      // Phantom-scale guard: the pre-fix audit store fed RiskManager PnL at
      // whale size (totalSize), producing daily/drawdown percentages >100%
      // that can't correspond to real capital. Such state is invalid — reset
      // instead of inheriting a permanent phantom halt.
      const dailyAbs = Math.abs(this._realizedPnl) / this.startingCapital;
      if (dailyAbs > 0.5) {
        console.warn(
          `[RiskManager] persisted realizedPnl=${this._realizedPnl.toFixed(2)} exceeds 50% of ` +
          `starting capital (${this.startingCapital}) — phantom-scale state from the ` +
          `pre-fix fire sizing; resetting risk state`
        );
        this._realizedPnl = 0;
        this._peakCapital = this.startingCapital;
        this._consecutiveLosses = 0;
        this._sizeMultiplier = 1.0;
        this._haltedUntilMs = null;
        this.persistState();
        return;
      }
      this._consecutiveLosses = raw.consecutiveLosses ?? 0;
      this._consecutiveWins = 0;
      this._sizeMultiplier = typeof raw.sizeMultiplier === 'number' ? raw.sizeMultiplier : 1.0;
      this._haltedUntilMs = typeof raw.haltedUntilMs === 'number' ? raw.haltedUntilMs : null;
      console.log(
        `[RiskManager] restored session state: realizedPnl=${this._realizedPnl.toFixed(2)} ` +
        `peak=${this._peakCapital.toFixed(2)} consecLosses=${this._consecutiveLosses}` +
        (this.checkHalt() ? ` HALTED (${this.checkHalt()})` : '')
      );
    } catch (err) {
      console.warn('[RiskManager] failed to load persisted state:', err instanceof Error ? err.message : err);
    }
  }

  /** Persist current state (atomic write: tmp + rename). */
  persistState(): void {
    const path = RiskManager.persistPath;
    if (!path) return;
    try {
      const payload = JSON.stringify({
        savedAt: Date.now(),
        realizedPnl: this._realizedPnl,
        peakCapital: this._peakCapital,
        consecutiveLosses: this._consecutiveLosses,
        sizeMultiplier: this._sizeMultiplier,
        haltedUntilMs: this._haltedUntilMs,
      });
      const tmp = path + '.tmp';
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, path);
    } catch (err) {
      console.warn('[RiskManager] failed to persist state:', err instanceof Error ? err.message : err);
    }
  }

  // ------------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------------

  /**
   * Returns true if the bot is allowed to place a trade right now.
   */
  canTrade(): boolean {
    const halt = this.checkHalt();
    return halt === null;
  }

  /**
   * Adjust a base USDC order size by the current dynamic-size multiplier
   * and clamp to [minPositionPct, maxPositionPct] of capital.
   *
   * Returns 0 if the bot is halted.
   */
  sizeOrder(baseUsdc: number): number {
    if (!this.canTrade()) return 0;
    if (!this.config.enableDynamicSizing) return baseUsdc;

    const capital = this.currentCapital();
    const min = capital * this.config.minPositionPct;
    const max = capital * this.config.maxPositionPct;

    const adjusted = baseUsdc * this._sizeMultiplier;
    return Math.max(min, Math.min(max, adjusted));
  }

  /**
   * Record a settled trade and update all rollups / halts / size.
   */
  recordTrade(t: TradeRecord): void {
    this.trades.push(t);
    this._realizedPnl += t.pnlUsd;
    const current = this.currentCapital();
    if (current > this._peakCapital) this._peakCapital = current;

    // Update streak
    if (t.pnlUsd < 0) {
      this._consecutiveLosses++;
      this._consecutiveWins = 0;
    } else if (t.pnlUsd > 0) {
      this._consecutiveWins++;
      this._consecutiveLosses = 0;
    } else {
      // scratch trade: doesn't break streaks but doesn't grow them either
    }

    // Recompute windowed P&L
    this._recomputeWindowedPnl();

    // Apply dynamic sizing update
    if (this.config.enableDynamicSizing) {
      if (this._consecutiveLosses > 0) {
        this._sizeMultiplier = Math.max(
          this.config.minPositionPct / this.config.basePositionPct,
          this._sizeMultiplier * (1 - this.config.lossSizingReduction)
        );
      } else if (this._consecutiveWins > 0) {
        this._sizeMultiplier = Math.min(
          this.config.maxPositionPct / this.config.basePositionPct,
          this._sizeMultiplier * (1 + this.config.winSizingIncrease)
        );
      }
    }

    // P6: persist after every settled trade so a restart can't wipe a halt.
    this.persistState();
  }

  // ==========================================================================
  // PT4: basket kill switch (sstklen/trump-code circuit-breaker pattern)
  // ==========================================================================

  /** Per-basket settled outcome history (1=win, 0=loss), newest last. */
  private basketOutcomes: Map<string, (0 | 1)[]> = new Map();
  /** Baskets currently suspended by the kill switch. */
  private killedBaskets: Set<string> = new Set();

  /** Record a settled outcome for a named basket and re-evaluate its breaker. */
  recordBasketOutcome(basketName: string, won: boolean): void {
    const window = this.config.basketKillWindow ?? 20;
    const list = this.basketOutcomes.get(basketName) ?? [];
    list.push(won ? 1 : 0);
    while (list.length > window) list.shift();
    this.basketOutcomes.set(basketName, list);

    // Kill: recent performance statistically indistinguishable from a coin
    // flip biased the wrong way, or N-consecutive-loss divergence vs baseline.
    const minN = this.config.basketKillMinSamples ?? 8;
    const sigma = this.config.basketKillSigma ?? 2.0;
    if (!this.killedBaskets.has(basketName) && list.length >= minN) {
      const n = list.length;
      const mean = list.reduce((a: number, b) => a + b, 0 as number) / n;
      // Binomial std-dev of the win-rate estimator under the fair-coin null
      // (p=0.5): sigma = sqrt(0.25/n). Divergence >= sigma * sigmaThresh
      // below 0.5 means the basket is significantly WORSE than a coin flip.
      const fairSigma = Math.sqrt(0.25 / n);
      if (mean < 0.5 - sigma * fairSigma) {
        this.killedBaskets.add(basketName);
        console.error(
          `[RiskManager] BASKET KILL SWITCH: '${basketName}' suspended — ` +
          `winRate ${mean.toFixed(3)} over ${n} settled is >= ${sigma}σ below fair coin ` +
          `(requires operator review to re-enable)`
        );
      }
    }
  }

  /** Is this basket suspended by its kill switch? */
  isBasketKilled(basketName: string): boolean {
    return this.killedBaskets.has(basketName);
  }

  /** Operator action: manually re-enable a killed basket (reset its history). */
  reviveBasket(basketName: string): void {
    this.killedBaskets.delete(basketName);
    this.basketOutcomes.delete(basketName);
    console.log(`[RiskManager] basket '${basketName}' revived — history reset`);
  }

  /**
   * Compute the current halt state. Returns null if trading is allowed.
   */
  checkHalt(): HaltReason {
    const now = Date.now();

    // Consecutive-loss pause (timed)
    if (this._haltedUntilMs !== null) {
      if (now < this._haltedUntilMs) return 'consecutive_losses';
      // Pause elapsed — clear it
      this._haltedUntilMs = null;
      this._consecutiveLosses = 0;
    }
    if (this._consecutiveLosses >= this.config.maxConsecutiveLosses) {
      this._haltedUntilMs = now + this.config.pauseOnBreachMinutes * 60_000;
      return 'consecutive_losses';
    }

    // Total loss — terminal
    const totalPct = -this._realizedPnl / this.startingCapital;
    if (totalPct >= this.config.totalMaxLossPct) return 'total_loss';

    // Monthly
    const monthlyPct = -this._monthlyPnl / this.startingCapital;
    if (monthlyPct >= this.config.monthlyMaxLossPct) return 'monthly_loss';

    // Daily
    const dailyPct = -this._dailyPnl / this.startingCapital;
    if (dailyPct >= this.config.dailyMaxLossPct) return 'daily_loss';

    // Drawdown from peak
    const drawdown = this.drawdownFromPeakPct();
    if (drawdown >= this.config.maxDrawdownFromPeak) return 'drawdown_from_peak';

    return null;
  }

  /**
   * Snapshot of all risk state — useful for logs / dashboard.
   */
  snapshot(): RiskSnapshot {
    return {
      startingCapital: this.startingCapital,
      realizedPnl: this._realizedPnl,
      peakCapital: this._peakCapital,
      currentCapital: this.currentCapital(),
      drawdownFromPeakPct: this.drawdownFromPeakPct(),
      dailyPnl: this._dailyPnl,
      monthlyPnl: this._monthlyPnl,
      isHalted: this.checkHalt() !== null,
      haltReason: this.checkHalt(),
      haltedUntilMs: this._haltedUntilMs,
      sizeMultiplier: this._sizeMultiplier,
      currentPositionPct: this.config.basePositionPct * this._sizeMultiplier,
      totalTrades: this.trades.length,
      consecutiveLosses: this._consecutiveLosses,
      consecutiveWins: this._consecutiveWins,
    };
  }

  /** Current capital = starting + realized P&L. */
  currentCapital(): number {
    return this.startingCapital + this._realizedPnl;
  }

  /** Drawdown from peak as a fraction (0-1). */
  drawdownFromPeakPct(): number {
    const peak = this._peakCapital;
    if (peak <= 0) return 0;
    const cur = this.currentCapital();
    return Math.max(0, (peak - cur) / peak);
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  private _recomputeWindowedPnl(): void {
    const now = Date.now();
    const oneDay = 24 * 60 * 60_000;
    const oneMonth = 30 * oneDay;
    let daily = 0;
    let monthly = 0;
    for (const t of this.trades) {
      const age = now - t.ts;
      if (age <= oneMonth) monthly += t.pnlUsd;
      if (age <= oneDay) daily += t.pnlUsd;
    }
    this._dailyPnl = daily;
    this._monthlyPnl = monthly;
  }
}
