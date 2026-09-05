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
  // whose recent settled win rate diverges from its OWN rolling baseline by
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
  // a basket's recent settled win rate diverges from its OWN rolling baseline
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
  /** Trade history (bounded: age-evicted to windows, hard-capped at 20k). */
  private trades: TradeRecord[] = [];

  // Windowed P&L — maintained INCREMENTALLY (O(1) amortized per trade) via
  // sliding pointers instead of rescanning the whole array every trade (was
  // O(n²) over a session).
  private _dailyPnl = 0;
  private _monthlyPnl = 0;
  /** Index into trades[] of the first trade inside the trailing 24h window. */
  private _dailyStart = 0;
  /** Index into trades[] of the first trade inside the trailing 30d window. */
  private _monthlyStart = 0;

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
   * Loads prior state (realizedPnl, peak, streaks, halt, TRADE HISTORY and
   * basket kill-switch stats) if present, then re-checks halts: if the
   * previous session already breached a limit, the bot stays halted after
   * the restart.
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
        this.trades = [];
        this._dailyPnl = 0;
        this._monthlyPnl = 0;
        this._dailyStart = 0;
        this._monthlyStart = 0;
        this.basketOutcomes.clear();
        this.killedBaskets.clear();
        this.persistState();
        return;
      }
      this._consecutiveLosses = raw.consecutiveLosses ?? 0;
      this._consecutiveWins = 0;
      this._sizeMultiplier = typeof raw.sizeMultiplier === 'number' ? raw.sizeMultiplier : 1.0;
      this._haltedUntilMs = typeof raw.haltedUntilMs === 'number' ? raw.haltedUntilMs : null;

      // Restore trade history so trailing 24h/30d windows survive a redeploy
      // (was: trades[] omitted → daily/monthly halts silently reset to 0).
      if (Array.isArray(raw.trades)) {
        this.trades = (raw.trades as TradeRecord[]).filter(
          (t) => t && typeof t.pnlUsd === 'number' && typeof t.ts === 'number' && isFinite(t.pnlUsd)
        ).sort((a, b) => a.ts - b.ts).slice(-20_000);
      } else {
        this.trades = [];
      }
      this._rebuildWindowedPnl();

      // Restore basket kill-switch state (a killed basket must stay killed).
      if (Array.isArray(raw.basketOutcomes)) {
        for (const [name, outcomes] of raw.basketOutcomes as [string, (0 | 1)[]][]) {
          if (typeof name === 'string' && Array.isArray(outcomes)) {
            this.basketOutcomes.set(name, outcomes.filter((v) => v === 0 || v === 1).slice(-500));
          }
        }
      }
      if (Array.isArray(raw.killedBaskets)) {
        for (const name of raw.killedBaskets as string[]) {
          if (typeof name === 'string') this.killedBaskets.add(name);
        }
      }

      console.log(
        `[RiskManager] restored session state: realizedPnl=${this._realizedPnl.toFixed(2)} ` +
        `peak=${this._peakCapital.toFixed(2)} consecLosses=${this._consecutiveLosses} ` +
        `trades=${this.trades.length} dailyPnl=${this._dailyPnl.toFixed(2)} ` +
        `monthlyPnl=${this._monthlyPnl.toFixed(2)}` +
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
        // Trade history — the DAILY/MONTHLY halt windows depend on it.
        trades: this.trades.slice(-20_000),
        // Basket kill-switch state — a kill must survive restart.
        basketOutcomes: [...this.basketOutcomes.entries()].map(([k, v]) => [k, v.slice(-500)]),
        killedBaskets: [...this.killedBaskets],
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
    // Hard cap on history regardless of windows (defense in depth).
    if (this.trades.length > 20_000) {
      this.trades.splice(0, this.trades.length - 20_000);
      // The sliding pointers are now stale relative to a compacted prefix —
      // rebuild from scratch (only happens beyond 20k trades).
      this._dailyStart = 0;
      this._monthlyStart = 0;
      this._rebuildWindowedPnl();
    }
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

    // Incremental windowed P&L (O(1) amortized; no full rescans).
    // Add the new trade before eviction so an out-of-window trade cannot be
    // added after the eviction pass and accidentally remain in the sums.
    this._dailyPnl += t.pnlUsd;
    this._monthlyPnl += t.pnlUsd;
    this._evictExpired();

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

  /** Per-basket settled outcome history (1=win, 0=loss), newest last, capped. */
  private basketOutcomes: Map<string, (0 | 1)[]> = new Map();
  /** Baskets currently suspended by the kill switch. */
  private killedBaskets: Set<string> = new Set();

  /**
   * Record a settled outcome for a named basket and re-evaluate its breaker.
   *
   * Kill rule (fixed): a basket is suspended when its RECENT window win rate
   * is `basketKillSigma` std-devs BELOW ITS OWN long-run baseline (the
   * history mean), floored at a fair coin (p=0.5). The old code compared
   * against the fair coin only, so a basket that drifted from its baseline
   * but stayed above 50% was never killed.
   */
  recordBasketOutcome(basketName: string, won: boolean): void {
    const window = this.config.basketKillWindow ?? 20;
    const list = this.basketOutcomes.get(basketName) ?? [];
    list.push(won ? 1 : 0);
    // Bound full history (baseline reference) — 500 settles is plenty.
    while (list.length > 500) list.shift();
    this.basketOutcomes.set(basketName, list);

    const minN = this.config.basketKillMinSamples ?? 8;
    const sigmaThresh = this.config.basketKillSigma ?? 2.0;
    if (this.killedBaskets.has(basketName)) return;

    const recent = list.slice(-Math.min(window, list.length));
    if (recent.length < minN) return;
    const n = recent.length;
    const recentMean = recent.reduce<number>((a, b) => a + b, 0) / n;
    // Baseline is the basket's OWN prior history, excluding the current
    // comparison window. Excluding the recent window prevents a bad tail from
    // diluting its own baseline and prevents a perfect early history from
    // generating false kills after one or two observations.
    const prior = list.length > n ? list.slice(0, -n) : [];
    // Establish a meaningful baseline before comparing a recent window. This
    // avoids treating the first few observations as a statistically certain
    // baseline of 1.0 or 0.0.
    if (prior.length < minN) return;
    const baseline = prior.length > 0
      ? Math.max(0.5, prior.reduce<number>((a, b) => a + b, 0) / prior.length)
      : 0.5;
    // Use a conservative variance floor for near-perfect histories. Without
    // it, baseline=1 gives sigma=0 and one ordinary loss immediately kills the
    // basket, which is not a meaningful 2σ test.
    const variance = Math.max(baseline * (1 - baseline), 0.25);
    const sigma = Math.sqrt(variance / n);
    if (recentMean < baseline - sigmaThresh * sigma) {
      this.killedBaskets.add(basketName);
      this.persistState();
      console.error(
        `[RiskManager] BASKET KILL SWITCH: '${basketName}' suspended — ` +
        `winRate ${recentMean.toFixed(3)} over last ${n} settled is >= ${sigmaThresh}σ below its ` +
        `own baseline ${baseline.toFixed(3)} (requires operator review to re-enable)`
      );
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
    this.persistState();
    console.log(`[RiskManager] basket '${basketName}' revived — history reset`);
  }

  /**
   * Compute the current halt state. Returns null if trading is allowed.
   *
   * Ordering (fixed): the 4 capital halts are evaluated FIRST, then the
   * consecutive-loss pause. The old order masked a daily/drawdown breach
   * whenever a 60-min pause was active — a 5% daily loss hidden behind a
   * pause is the exact failure the halts exist to catch.
   */
  checkHalt(): HaltReason {
    const now = Date.now();

    // Capital halts first (most severe → least).
    const totalPct = -this._realizedPnl / this.startingCapital;
    if (totalPct >= this.config.totalMaxLossPct) return 'total_loss';

    const monthlyPct = -this._monthlyPnl / this.startingCapital;
    if (monthlyPct >= this.config.monthlyMaxLossPct) return 'monthly_loss';

    const dailyPct = -this._dailyPnl / this.startingCapital;
    if (dailyPct >= this.config.dailyMaxLossPct) return 'daily_loss';

    const drawdown = this.drawdownFromPeakPct();
    if (drawdown >= this.config.maxDrawdownFromPeak) return 'drawdown_from_peak';

    // Consecutive-loss pause (timed) — last now.
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

  /** Rebuild daily/monthly sums and reset the sliding pointers. Used on load. */
  private _rebuildWindowedPnl(): void {
    const now = Date.now();
    const oneDay = 24 * 60 * 60_000;
    const oneMonth = 30 * oneDay;
    let daily = 0;
    let monthly = 0;
    let dailyStart = 0;
    let monthlyStart = 0;
    // trades[] is ts-sorted at load time.
    for (let i = 0; i < this.trades.length; i++) {
      const age = now - this.trades[i].ts;
      if (age > oneMonth) { monthlyStart = i + 1; dailyStart = i + 1; continue; }
      monthly += this.trades[i].pnlUsd;
      if (age <= oneDay) daily += this.trades[i].pnlUsd;
      else dailyStart = i + 1;
    }
    this._dailyPnl = daily;
    this._monthlyPnl = monthly;
    this._dailyStart = dailyStart;
    this._monthlyStart = monthlyStart;
  }

  /**
   * Drop trades that fell out of the trailing windows, maintaining the sums
   * incrementally. Amortized O(1) per trade.
   */
  private _evictExpired(): void {
    const now = Date.now();
    const oneDay = 24 * 60 * 60_000;
    const oneMonth = 30 * oneDay;
    const n = this.trades.length;
    // Advance the daily pointer past trades older than 24h (they may still be
    // inside the monthly window, so only subtract from the daily sum).
    while (this._dailyStart < n && now - this.trades[this._dailyStart].ts > oneDay) {
      this._dailyPnl -= this.trades[this._dailyStart].pnlUsd;
      this._dailyStart++;
    }
    // Advance the monthly pointer past trades older than 30d.
    let advanced = false;
    while (this._monthlyStart < n && now - this.trades[this._monthlyStart].ts > oneMonth) {
      this._monthlyPnl -= this.trades[this._monthlyStart].pnlUsd;
      this._monthlyStart++;
      advanced = true;
    }
    // Compact the prefix once past the monthly window (bounds memory).
    if (this._monthlyStart > 0 && (advanced || this._monthlyStart > 1024)) {
      this.trades.splice(0, this._monthlyStart);
      this._dailyStart = Math.max(0, this._dailyStart - this._monthlyStart);
      this._monthlyStart = 0;
    }
  }
}