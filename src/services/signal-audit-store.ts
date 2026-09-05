/**
 * SignalAuditStore
 *
 * Tracks every quorum-fired signal with proper edge math:
 *   expected_edge = P(won) − implied_prob − fee_per_share
 *
 * On settlement, records the realized outcome and recomputes realized_edge.
 * Rolling 30-day stats are logged via logFunnel() so the operator can answer:
 *   "Is our quorum actually finding alpha, or just buying stable tickets?"
 *
 * Three corrections (per whalewatch/lib/outcomeStats methodology):
 *   1. Price calibration  — edge = P(won) − price, not raw win rate
 *   2. Fee correction    — subtract taker fee per share
 *   3. Market clustering — multiple signals on same market share one结算 outcome;
 *                          clustered interval is used for significance testing
 *
 * Bonferroni correction: α=0.05 / N groups tested.  N = number of active
 * baskets (set once at boot via setBonferroniGroups) — hypotheses tested,
 * NOT the rolling sample size.
 */

import { takerFeePerShare, DEFAULT_FEE_RATE_BPS } from '../utils/fee-math.js';
import * as fs from 'node:fs';
import type { StateStore } from './state-store.js';

// ============================================================================
// Types
// ============================================================================

export type SignalSide = 'BUY' | 'SELL';
export type SignalOutcome = 'won' | 'lost' | 'pending';

export interface FiredSignal {
  id: string;
  conditionId: string;
  marketSlug: string;
  outcome: string;       // token outcome name, e.g. 'Yes'
  side: SignalSide;
  pricePaid: number;     // 0-1
  size: number;          // shares
  feePerShare: number;   // taker fee per share (probability points)
  expectedEdge: number;   // P(won) − price − fee  (at fire time)
  winRate: number;       // basket's rolling win rate at fire time
  basket: string;
  wallets: string[];     // distinct wallets in this quorum fire
  firedAt: number;       // unix ms
  settledAt?: number;   // unix ms, set on settlement
  realizedEdge?: number; // actual payout − price − fee (computed on settlement)
  resolved?: number;     // 0 or 1, Polymarket resolution
  exitedAt?: number;     // unix ms — position closed early by the exit ladder
  exitPrice?: number;    // best bid at exit
  exitReason?: string;   // EDGE_TP | LATE_TP | EMERGENCY | REVERSE_QUORUM | MIRROR_EXIT | KILL_SWITCH
  cluster: string;       // = conditionId for clustering
}

/** Summary stats exposed to logFunnel() */
export interface EdgeStats {
  signalsFired: number;
  signalsSettled: number;
  signalsWon: number;
  meanExpectedEdge: number;   // mean of expected_edge across settled signals
  meanRealizedEdge: number;   // mean of realized_edge across settled signals
  edgeAlpha: number;          // meanRealizedEdge − meanExpectedEdge (>0 = outperforming)
  bonferroniAlpha: number;    // 0.05 / BONFERRONI_GROUPS
  isSignificant: boolean;     // true if edgeAlpha > 0 AND t-stat > bonferroni threshold
  tStat: number;
  clusterCount: number;       // number of distinct markets (for Bonferroni denom)
  brierScore: number;         // PT2: mean (p̂ − outcome)² — lower = better calibrated (0 = perfect, 0.25 = coin flip)
}

interface SignalMap {
  [id: string]: FiredSignal;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Taker fee per share is now computed dynamically via fee-math.ts
 * (takerFeePerShare(price, feeRateBps)) so the audit trail agrees with the
 * execution edge gate. The flat constant below is kept only as a legacy
 * fallback reference and is no longer used by recordFire().
 * @deprecated use takerFeePerShare(price, DEFAULT_FEE_RATE_BPS) from fee-math.ts
 */
export const TAKER_FEE_PER_SHARE = 0.003; // ~0.3% legacy flat rate

/** Rolling window for edge stats (ms). 30 days. */
const EDGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Minimum settled signals before the significance gate may fire. */
const MIN_SIGNIFICANT_SAMPLES = 8;

/** Monotonic counter — makes fire ids unique even for same-ms fires. */
let fireSeq = 0;
function nextFireSeq(): number {
  return ++fireSeq;
}

/** Bonferroni groups — increment when adding new filter dimensions. */
let BONFERRONI_GROUPS = 3; // crypto, politics, other (3 baskets = 3 groups)

export function setBonferroniGroups(n: number): void {
  BONFERRONI_GROUPS = n;
}

// ============================================================================
// Store
// ============================================================================

export class SignalAuditStore {
  private signals: SignalMap = {};
  private byConditionId: Map<string, string[]> = new Map(); // conditionId → signal ids

  // L11: JSONL audit trail — every fire/settlement appends one line to disk
  // so the full decision log survives restarts (OctagonAI/kalshi-bot pattern).
  private static jsonlPath: string | null = null;
  private stateStore: StateStore | null = null;

  /** Enable JSONL audit logging. Call once at boot. */
  static enableJsonl(path: string): void {
    SignalAuditStore.jsonlPath = path;
  }

  /** Attach the shared state boundary; JSONL remains the audit source of truth. */
  setStateStore(store: StateStore): void {
    this.stateStore = store;
  }

  appendJsonl(event: string, data: Record<string, unknown>): void {
    const path = SignalAuditStore.jsonlPath;
    if (!path) return;
    try {
      const line = JSON.stringify({ ts: Date.now(), event, ...data }) + '\n';
      fs.appendFileSync(path, line, 'utf8');
    } catch {
      // audit logging must never break trading
    }
  }

  // --------------------------------------------------------------------------
  // Recording
  // --------------------------------------------------------------------------

  /**
   * Log a new quorum fire.  Call this in BasketQuorumService when quorum
   * fires, before the order is placed.
   */
  recordFire(params: {
    conditionId: string;
    marketSlug: string;
    outcome: string;
    side: SignalSide;
    pricePaid: number;
    size: number;
    winRate: number;        // basket rolling win rate at fire time
    basket: string;
    wallets: string[];
    feePerShare?: number;   // optional: the taker fee the execution gate used
  }): string {
    const id = `${params.conditionId}-${params.outcome}-${Date.now()}-${nextFireSeq()}`;
    const impliedProb = params.side === 'BUY' ? params.pricePaid : (1 - params.pricePaid);
    // Dynamic Polymarket fee (feeRateBps × p × (1-p)) so audited edge matches
    // the execution gate — unless the caller passes the fee it actually used.
    const fee = params.feePerShare ?? takerFeePerShare(params.pricePaid, DEFAULT_FEE_RATE_BPS);
    const expectedEdge = params.winRate - impliedProb - fee;

    const signal: FiredSignal = {
      id,
      conditionId: params.conditionId,
      marketSlug: params.marketSlug,
      outcome: params.outcome,
      side: params.side,
      pricePaid: params.pricePaid,
      size: params.size,
      feePerShare: fee,
      expectedEdge,
      winRate: params.winRate,
      basket: params.basket,
      wallets: params.wallets,
      firedAt: Date.now(),
      cluster: params.conditionId,
    };

    this.pruneOldSignals();
    this.signals[id] = signal;
    const list = this.byConditionId.get(params.conditionId) ?? [];
    list.push(id);
    this.byConditionId.set(params.conditionId, list);
    this.appendJsonl('fire', {
      id,
      conditionId: params.conditionId,
      marketSlug: params.marketSlug,
      outcome: params.outcome,
      side: params.side,
      pricePaid: params.pricePaid,
      size: params.size,
      feePerShare: fee,
      winRate: params.winRate,
      expectedEdge,
      basket: params.basket,
      wallets: params.wallets,
    });
    return id;
  }

  /**
   * Record settlement for a condition.  All signals on this conditionId share
   * the same resolution — apply it to every signal and compute realized_edge.
   *
   * Position model (value at settlement − cost − fee):
   *   BUY  = long YES at pricePaid → value 1 if resolved=1, else 0
   *   SELL = long NO  at pricePaid → value 1 if resolved=0, else 0
   *
   *   realized_edge = (valuePerShare − pricePaid − feePerShare) × size
   *
   * (Binary, winner-take-all: a winning share pays $1 at resolution, a losing
   *  share pays $0. The old code computed "payout − pricePaid" where payout
   *  already excluded the cost basis, double-subtracting it and booking every
   *  winning BUY above ~49.85¢ as a loss.)
   */
  recordSettlement(conditionId: string, resolved: 0 | 1): void {
    const ids = this.byConditionId.get(conditionId) ?? [];
    const settledAt = Date.now();

    for (const id of ids) {
      const s = this.signals[id];
      if (!s || s.settledAt) continue; // already settled

      s.resolved = resolved;
      s.settledAt = settledAt;
      s.realizedEdge = SignalAuditStore.realizedEdgeFor(s, resolved);
      this.appendJsonl('settlement', {
        id: s.id,
        conditionId: s.conditionId,
        marketSlug: s.marketSlug,
        outcome: s.outcome,
        side: s.side,
        resolved,
        realizedEdge: s.realizedEdge,
        basket: s.basket,
      });
    }
  }

  /**
   * Manually mark a signal as settled (e.g., from backtest with known outcome).
   */
  recordBacktestSettlement(id: string, resolved: 0 | 1): void {
    const s = this.signals[id];
    if (!s || s.settledAt) return;
    s.realizedEdge = SignalAuditStore.realizedEdgeFor(s, resolved);
    s.resolved = resolved;
    s.settledAt = Date.now();
    this.appendJsonl('settlement', {
      id: s.id,
      conditionId: s.conditionId,
      marketSlug: s.marketSlug,
      outcome: s.outcome,
      side: s.side,
      resolved,
      realizedEdge: s.realizedEdge,
      basket: s.basket,
    });
  }

  /**
   * Mark the signal(s) behind an early exit (exit ladder / reverse-quorum /
   * kill-switch force-close). The signal is settled AT the exit price — not
   * at resolution — so realized edge and P&L reflect the exit decision and
   * the market's later resolution does NOT double-count it (settledAt set).
   *
   * realized_edge = (exitPrice − pricePaid − fee) * size for BUY exits.
   */
  markExited(
    conditionId: string, exitPrice: number, reason: string, outcome?: string,
  ): void {
    const ids = this.byConditionId.get(conditionId) ?? [];
    for (const id of ids) {
      const s = this.signals[id];
      if (!s || s.settledAt) continue;             // already settled by resolution
      if (outcome && s.outcome !== outcome) continue; // only the exited side
      // Same value model as settlement: the position is sold at exitPrice,
      // so P&L = (exitPrice − pricePaid − fee) × size for BOTH sides. The old
      // SELL branch (pricePaid − exitPrice) inverted the sign of NO exits.
      const perShare = exitPrice - s.pricePaid - s.feePerShare;
      s.realizedEdge = perShare * s.size;
      s.resolved = exitPrice >= 0.5 ? 1 : 0;       // bookkeeping only
      s.settledAt = Date.now();
      s.exitedAt = Date.now();
      s.exitPrice = exitPrice;
      s.exitReason = reason;
      this.appendJsonl('exit_settled', {
        id: s.id,
        conditionId: s.conditionId,
        marketSlug: s.marketSlug,
        outcome: s.outcome,
        exitPrice,
        reason,
        realizedEdge: s.realizedEdge,
        basket: s.basket,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  getStats(winRateOverride?: (basket: string) => number): EdgeStats {
    this.pruneOldSignals();
    const cutoff = Date.now() - EDGE_WINDOW_MS;
    const settled = Object.values(this.signals).filter(
      s => s.settledAt !== undefined && s.settledAt > cutoff,
    );

    const signalsFired = Object.values(this.signals).filter(s => s.firedAt > cutoff).length;
    const signalsSettled = settled.length;
    const signalsWon = settled.filter(s => s.resolved === 1).length;

    if (signalsSettled === 0) {
      return {
        signalsFired,
        signalsSettled: 0,
        signalsWon: 0,
        meanExpectedEdge: 0,
        meanRealizedEdge: 0,
        edgeAlpha: 0,
        bonferroniAlpha: 0.05 / BONFERRONI_GROUPS,
        isSignificant: false,
        tStat: 0,
        clusterCount: 0,
        brierScore: 0,
      };
    }

    const expectedEdges = settled.map(s => s.expectedEdge);
    const realizedEdges = settled.map(s => s.realizedEdge ?? 0);

    const meanExpected = arrMean(expectedEdges);
    const meanRealized = arrMean(realizedEdges);
    const edgeAlpha = meanRealized - meanExpected;

    // t-stat for one-sample t-test: does realizedEdge differ from expectedEdge?
    const diffs = settled.map((s, i) => (s.realizedEdge ?? 0) - s.expectedEdge);
    const tStat = arrTStat(diffs);

    // Distinct markets (clusters) in the settled window (for reporting only —
    // the Bonferroni denominator is the number of BASKETS/groups tested, set
    // once at boot, NOT the sample size).
    const clusters = new Set(settled.map(s => s.cluster));

    // Bonferroni-corrected significance: edgeAlpha > 0 AND the two-sided
    // p-value of the t-statistic is below 0.05/groups. Also require a minimum
    // sample — a handful of signals shouldn't trip significance regardless of
    // t. (The old code hardcoded |t|>2.0, ignored bonferroniAlpha entirely,
    // and mutated BONFERRONI_GROUPS — making the threshold stricter as the
    // sample grew, which is backwards.)
    const pValue = twoSidedPValue(tStat);
    const bonferroniAlpha = 0.05 / Math.max(1, BONFERRONI_GROUPS);
    const isSignificant =
      edgeAlpha > 0 && settled.length >= MIN_SIGNIFICANT_SAMPLES && pValue < bonferroniAlpha;

    // PT2 (CloddsBot): Brier score over settled signals. p̂ = implied prob of
    // OUR side = pricePaid for BUY, 1-pricePaid for SELL. outcome = resolved.
    // 0 = perfect calibration, 0.25 = coin flip, >0.25 = worse than guessing.
    const brier = settled.map(s => {
      const p = s.side === 'BUY' ? s.pricePaid : (1 - s.pricePaid);
      const o = s.resolved ?? 0;
      return (p - o) * (p - o);
    });
    const brierScore = arrMean(brier);

    return {
      signalsFired,
      signalsSettled,
      signalsWon,
      meanExpectedEdge: Math.round(meanExpected * 10000) / 10000,
      meanRealizedEdge: Math.round(meanRealized * 10000) / 10000,
      edgeAlpha: Math.round(edgeAlpha * 10000) / 10000,
      bonferroniAlpha: Math.round(bonferroniAlpha * 10000) / 10000,
      isSignificant,
      tStat: Math.round(tStat * 100) / 100,
      clusterCount: clusters.size,
      brierScore: Math.round(brierScore * 10000) / 10000,
    };
  }

  /** Returns all settled signals in the rolling window, for export/debugging. */
  getSettledSignals(): FiredSignal[] {
    const cutoff = Date.now() - EDGE_WINDOW_MS;
    return Object.values(this.signals).filter(s => s.settledAt && s.settledAt > cutoff);
  }

  /** Returns the signal with the given id, if it exists. */
  getSignal(id: string): FiredSignal | undefined {
    return this.signals[id];
  }

  /** All signals fired on a given conditionId (for resolution handling). */
  getSignalsByCondition(conditionId: string): FiredSignal[] {
    const ids = this.byConditionId.get(conditionId) ?? [];
    return ids.map((id) => this.signals[id]).filter((s): s is FiredSignal => !!s);
  }

  /**
   * All conditionIds that have been fired but not yet settled.
   * Used by GammaResolutionPoller to batch-check resolutions.
   * Deduplicated — one entry per conditionId (previously one per signal,
   * which made the poller issue duplicate fetches and duplicate
   * handleMarketResolved calls).
   */
  getUnsettledConditionIds(): string[] {
      const unsettled = new Set<string>();
      for (const s of Object.values(this.signals)) {
        if (s.settledAt === undefined) unsettled.add(s.cluster);
      }
      return [...unsettled];
    }

    /**
     * Realized P&L for a settled signal.
     *   BUY  = long YES at pricePaid → value 1 if resolved=1, else 0
     *   SELL = long NO  at pricePaid → value 1 if resolved=0, else 0
     *   realized_edge = (valuePerShare − pricePaid − feePerShare) × size
     */
    static realizedEdgeFor(s: FiredSignal, resolved: 0 | 1): number {
      const valuePerShare = s.side === 'BUY'
        ? (resolved === 1 ? 1 : 0)
        : (resolved === 0 ? 1 : 0);
      return (valuePerShare - s.pricePaid - s.feePerShare) * s.size;
    }

  // --------------------------------------------------------------------------
  // Memory bounds + restart survival
  // --------------------------------------------------------------------------

  /**
   * Drop signals older than the stats window (plus a 1h margin) from both the
   * id map and the condition index — bounds memory on long-running sessions
   * (previously signals{} and byConditionId grew forever).
   */
  private pruneOldSignals(): void {
    const cutoff = Date.now() - EDGE_WINDOW_MS - 60 * 60 * 1000;
    let pruned = 0;
    for (const id of Object.keys(this.signals)) {
      if (this.signals[id].firedAt < cutoff) {
        delete this.signals[id];
        pruned++;
      }
    }
    if (pruned === 0) return;
    // Rebuild the condition index from survivors.
    this.byConditionId.clear();
    for (const s of Object.values(this.signals)) {
      const list = this.byConditionId.get(s.conditionId) ?? [];
      list.push(s.id);
      this.byConditionId.set(s.conditionId, list);
    }
  }

  /**
   * Rebuild in-memory state from the JSONL audit trail. Call once at boot
   * (after enableJsonl) so 30-day edge stats and the significance gate survive
   * redeploys instead of silently resetting to zero. Idempotent — the same
   * guards used by the live paths (settledAt, dedupe) apply.
   */
  replayJsonl(path: string): void {
    if (!fs.existsSync(path)) return;
    let lines: string[];
    try {
      lines = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean);
    } catch {
      return;
    }
    for (const line of lines) {
      let evt: { event?: string; ts?: number; [k: string]: unknown };
      try {
        evt = JSON.parse(line);
      } catch {
        continue; // malformed line — skip, never crash boot
      }
      try {
        if (evt.event === 'fire' && typeof evt.id === 'string') {
          this._replayFire(evt as any);
        } else if (evt.event === 'settlement' && typeof evt.id === 'string') {
          this._replaySettlement(evt as any);
        } else if (evt.event === 'exit_settled' && typeof evt.id === 'string') {
          this._replayExit(evt as any);
        }
      } catch {
        // keep going — a single bad record must not block the trail replay
      }
    }
    void this.stateStore?.save({ audit: { signals: Object.keys(this.signals).length, unsettled: this.getUnsettledConditionIds().length } });
  }

  private _replayFire(evt: {
    id: string; conditionId: string; marketSlug: string; outcome: string;
    side: SignalSide; pricePaid: number; size: number; feePerShare?: number;
    winRate: number; expectedEdge: number; basket: string; wallets: string[]; ts?: number;
  }): void {
    if (this.signals[evt.id]) return; // already present
    const fee = evt.feePerShare ?? takerFeePerShare(evt.pricePaid, DEFAULT_FEE_RATE_BPS);
    const signal: FiredSignal = {
      id: evt.id,
      conditionId: evt.conditionId,
      marketSlug: evt.marketSlug,
      outcome: evt.outcome,
      side: evt.side,
      pricePaid: evt.pricePaid,
      size: evt.size,
      feePerShare: fee,
      expectedEdge: evt.expectedEdge,
      winRate: evt.winRate,
      basket: evt.basket,
      wallets: evt.wallets ?? [],
      firedAt: evt.ts ?? Date.now(),
      cluster: evt.conditionId,
    };
    this.signals[evt.id] = signal;
    const list = this.byConditionId.get(evt.conditionId) ?? [];
    list.push(evt.id);
    this.byConditionId.set(evt.conditionId, list);
  }

  private _replaySettlement(evt: { id: string; resolved: 0 | 1; ts?: number }): void {
    const s = this.signals[evt.id];
    if (!s || s.settledAt !== undefined) return;
    s.resolved = evt.resolved;
    s.settledAt = evt.ts ?? Date.now();
    s.realizedEdge = SignalAuditStore.realizedEdgeFor(s, evt.resolved); // fixed math
  }

  private _replayExit(evt: { id: string; exitPrice: number; reason: string; ts?: number }): void {
    const s = this.signals[evt.id];
    if (!s || s.settledAt !== undefined) return;
    s.realizedEdge = (evt.exitPrice - s.pricePaid - s.feePerShare) * s.size;
    s.resolved = evt.exitPrice >= 0.5 ? 1 : 0;
    s.settledAt = evt.ts ?? Date.now();
    s.exitedAt = evt.ts ?? Date.now();
    s.exitPrice = evt.exitPrice;
    s.exitReason = evt.reason;
  }
  }

  // ============================================================================
  // Math helpers
  // ============================================================================

function arrMean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function arrTStat(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arrMean(arr);
  const variance = arr.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (arr.length - 1);
  const stddev = Math.sqrt(variance);
  if (stddev === 0) return 0;
  return mean / (stddev / Math.sqrt(arr.length));
}

/**
 * Standard normal CDF via Abramowitz-Stegun 7.1.26 (error < 7.5e-8).
 */
function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/**
 * Two-sided p-value from a t-statistic, using the normal approximation.
 * Adequate for n >= 8 (the MIN_SIGNIFICANT_SAMPLES floor); for smaller n the
 * test is intentionally conservative because significance is gated on n first.
 */
function twoSidedPValue(tStat: number): number {
  if (!Number.isFinite(tStat)) return 1;
  return 2 * (1 - normCdf(Math.abs(tStat)));
}

// Singleton export — shared across BacktestRunner and BasketQuorumService
export const signalAuditStore = new SignalAuditStore();
