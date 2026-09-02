/**
 * Anti-sniper / mid-stability guards.
 *
 * Source: lihanyu81/polymarket_lp_tool (rust_mm_bot/.env.example):
 *   PASSIVE_MID_JUMP_THRESHOLD        - reject orders if mid jumped > X in window
 *   PASSIVE_MID_STABLE_CONFIRM_MS     - require mid to be stable for X ms before fire
 *   PASSIVE_FILL_COOLDOWN_MS          - min ms between consecutive fills on same market
 *   PASSIVE_MAX_REPRICE_TICKS_PER_UPDATE - cap on ticks moved per update cycle
 *
 * These prevent the bot from "sniping" itself into thin, illiquid ticks
 * and from being picked off by faster actors who can move the mid.
 *
 * In Polyland's copy-trader context, we use these to gate `tryFire`:
 *   - mid_jump_threshold: don't fire if the CLOB mid has moved >X in the
 *     last N ms (protects against being copy-sniped)
 *   - mid_stable_confirm_ms: require the mid to have been stable for at
 *     least X ms before firing (a sanity check that consensus is real)
 *   - fill_cooldown_ms: minimum ms between consecutive fires on the same
 *     market+outcome
 *   - max_reprice_ticks: when re-quoting a limit, cap tick movement
 */

import type { UnifiedCache } from '../core/unified-cache.js';

// ============================================================================
// Config
// ============================================================================

export interface AntiSniperConfig {
  /** Reject fire if mid moved more than this fraction in the lookback window. */
  midJumpThreshold: number;
  /** Require mid to have been stable for at least this many ms. */
  midStableConfirmMs: number;
  /** Minimum ms between consecutive fills on the same market+outcome. */
  fillCooldownMs: number;
  /** Cap on tick movement per quote update. */
  maxRepriceTicks: number;
  /** Lookback window for mid-jump detection (ms). */
  midJumpLookbackMs: number;
}

export const DEFAULT_ANTI_SNIPER_CONFIG: AntiSniperConfig = {
  midJumpThreshold: 0.03,         // 3% mid move in window = reject
  midStableConfirmMs: 1_000,      // 1 second of stable mid
  fillCooldownMs: 5_000,          // 5 seconds between fills
  maxRepriceTicks: 2,             // max 2 ticks per re-quote
  midJumpLookbackMs: 2_000,       // 2-second lookback for mid jumps
};

// ============================================================================
// Guard state
// ============================================================================

interface MidSample {
  t: number;
  mid: number;
}

interface GuardState {
  /** Rolling buffer of mid prices per market+outcome key. */
  midHistory: Map<string, MidSample[]>;
  /** Last fire timestamp per market+outcome key. */
  lastFireMs: Map<string, number>;
  /** Last time the mid was seen changing (used to compute "stable since"). */
  midLastChangeMs: Map<string, number>;
  /** Last emitted price (used for maxRepriceTicks). */
  lastEmittedPrice: Map<string, number>;
}

function makeState(): GuardState {
  return {
    midHistory: new Map(),
    lastFireMs: new Map(),
    midLastChangeMs: new Map(),
    lastEmittedPrice: new Map(),
  };
}

// ============================================================================
// Guard API
// ============================================================================

export interface GuardDecision {
  allow: boolean;
  reason?: string;
}

const MAX_HISTORY_PER_KEY = 64;

/**
 * Record a mid-price observation and evaluate the anti-sniper guards.
 * Call this for every market mid update, then check `allowFire` before
 * each `tryFire` execution.
 */
export class AntiSniperGuard {
  private state: GuardState;
  private config: AntiSniperConfig;

  constructor(
    private cache: UnifiedCache | null,
    config: Partial<AntiSniperConfig> = {}
  ) {
    this.config = { ...DEFAULT_ANTI_SNIPER_CONFIG, ...config };
    this.state = makeState();
  }

  /**
   * Make a stable cache key for a market+outcome.
   * Token-id based so different neg-risk outcomes are tracked separately.
   */
  private key(tokenId: string): string {
    return tokenId;
  }

  /**
   * Update the mid-price buffer. Returns whether the mid changed (>=1 tick).
   */
  observe(tokenId: string, mid: number, now: number = Date.now()): void {
    const k = this.key(tokenId);
    const arr = this.state.midHistory.get(k) ?? [];
    const last = arr[arr.length - 1];
    if (last && Math.abs(last.mid - mid) < 1e-9) {
      // No change, no update needed
      return;
    }
    arr.push({ t: now, mid });
    if (arr.length > MAX_HISTORY_PER_KEY) arr.shift();
    this.state.midHistory.set(k, arr);
    this.state.midLastChangeMs.set(k, now);
  }

  /**
   * Decide whether a fire on this market+outcome is currently allowed.
   */
  allowFire(tokenId: string, now: number = Date.now()): GuardDecision {
    const k = this.key(tokenId);

    // Fill cooldown
    const lastFire = this.state.lastFireMs.get(k) ?? 0;
    if (now - lastFire < this.config.fillCooldownMs) {
      return {
        allow: false,
        reason: `fill_cooldown ${now - lastFire}ms<${this.config.fillCooldownMs}ms`,
      };
    }

    // No observations yet — reject (cannot verify mid-stability).
    const arr = this.state.midHistory.get(k) ?? [];
    if (arr.length === 0) {
      return {
        allow: false,
        reason: 'no_mid_observations',
      };
    }

    // Mid-jump check
    if (arr.length >= 2) {
      const lookbackStart = now - this.config.midJumpLookbackMs;
      const old = arr.find(s => s.t >= lookbackStart) ?? arr[0];
      const cur = arr[arr.length - 1];
      const move = Math.abs(cur.mid - old.mid);
      if (move > this.config.midJumpThreshold) {
        return {
          allow: false,
          reason: `mid_jump ${(move * 100).toFixed(1)}%>${(this.config.midJumpThreshold * 100).toFixed(0)}%`,
        };
      }
    }

    // Mid-stable check
    const lastChange = this.state.midLastChangeMs.get(k) ?? 0;
    const stableMs = now - lastChange;
    if (stableMs < this.config.midStableConfirmMs) {
      return {
        allow: false,
        reason: `mid_unstable ${stableMs}ms<${this.config.midStableConfirmMs}ms`,
      };
    }

    return { allow: true };
  }

  /**
   * Record that a fire was just executed on this market+outcome.
   */
  recordFire(tokenId: string, now: number = Date.now()): void {
    this.state.lastFireMs.set(this.key(tokenId), now);
  }

  /**
   * Cap the difference between `newPrice` and the last emitted price
   * for this market+outcome to `maxRepriceTicks` ticks.
   * `tickSize` is the market's minimum tick (e.g. 0.01).
   *
   * Returns the (possibly clamped) price.
   */
  clampReprice(
    tokenId: string,
    newPrice: number,
    tickSize: number
  ): number {
    const k = this.key(tokenId);
    const last = this.state.lastEmittedPrice.get(k);
    if (last === undefined) {
      this.state.lastEmittedPrice.set(k, newPrice);
      return newPrice;
    }
    const maxMove = this.config.maxRepriceTicks * tickSize;
    const diff = newPrice - last;
    let clamped = newPrice;
    if (diff > maxMove) clamped = last + maxMove;
    else if (diff < -maxMove) clamped = last - maxMove;
    this.state.lastEmittedPrice.set(k, clamped);
    return clamped;
  }

  /**
   * Reset all guard state. Useful between backtest runs.
   */
  reset(): void {
    this.state = makeState();
  }
}
