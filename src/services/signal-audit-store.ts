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
 * Bonferroni correction: α=0.05 / N groups tested.  N is incremented each
 * time a new filter dimension is added, keeping false-positive rate in check.
 */

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
}

interface SignalMap {
  [id: string]: FiredSignal;
}

// ============================================================================
// Constants
// ============================================================================

/** Rough Polymarket taker fee per share (probability points). Updated from fe schedule. */
export const TAKER_FEE_PER_SHARE = 0.003; // ~0.3%

/** Rolling window for edge stats (ms). 30 days. */
const EDGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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
  }): string {
    const id = `${params.conditionId}-${params.outcome}-${Date.now()}`;
    const impliedProb = params.side === 'BUY' ? params.pricePaid : (1 - params.pricePaid);
    const fee = TAKER_FEE_PER_SHARE;
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

    this.signals[id] = signal;
    const list = this.byConditionId.get(params.conditionId) ?? [];
    list.push(id);
    this.byConditionId.set(params.conditionId, list);
    return id;
  }

  /**
   * Record settlement for a condition.  All signals on this conditionId share
   * the same resolution — apply it to every signal and compute realized_edge.
   *
   * realized_edge = payout − pricePaid − fee
   *   BUY  → payout = size * (1 − pricePaid)   if resolved=1, else 0
   *   SELL → payout = size * pricePaid          if resolved=0, else 0
   *
   * (Binary, winner-take-all: if your side wins you get 1 − price per share;
   *  if you lose you get 0.)
   */
  recordSettlement(conditionId: string, resolved: 0 | 1): void {
    const ids = this.byConditionId.get(conditionId) ?? [];
    const settledAt = Date.now();

    for (const id of ids) {
      const s = this.signals[id];
      if (!s || s.settledAt) continue; // already settled

      s.resolved = resolved;
      s.settledAt = settledAt;

      // payout logic: binary winner-take-all
      const payoutPerShare = resolved === 1
        ? (s.side === 'BUY' ? 1 - s.pricePaid : s.pricePaid)
        : (s.side === 'BUY' ? 0 : s.pricePaid);

      const grossPayout = s.size * payoutPerShare;
      const netPayout = grossPayout - (s.size * s.feePerShare);
      s.realizedEdge = netPayout - s.pricePaid * s.size; // net profit per share − cost
    }
  }

  /**
   * Manually mark a signal as settled (e.g., from backtest with known outcome).
   */
  recordBacktestSettlement(id: string, resolved: 0 | 1): void {
    const s = this.signals[id];
    if (!s || s.settledAt) return;
    const payoutPerShare = resolved === 1
      ? (s.side === 'BUY' ? 1 - s.pricePaid : s.pricePaid)
      : (s.side === 'BUY' ? 0 : s.pricePaid);
    const grossPayout = s.size * payoutPerShare;
    const netPayout = grossPayout - (s.size * s.feePerShare);
    s.realizedEdge = netPayout - s.pricePaid * s.size;
    s.resolved = resolved;
    s.settledAt = Date.now();
  }

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  getStats(winRateOverride?: (basket: string) => number): EdgeStats {
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
    const bonferroniAlpha = 0.05 / BONFERRONI_GROUPS;

    // Distinct markets (clusters) in the settled window — for Bonferroni denom
    const clusters = new Set(settled.map(s => s.cluster));
    BONFERRONI_GROUPS = Math.max(BONFERRONI_GROUPS, clusters.size);

    // Significance: positive alpha AND |tStat| exceeds critical value (~2 for N>30)
    const isSignificant = edgeAlpha > 0 && Math.abs(tStat) > 2.0;

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

// Singleton export — shared across BacktestRunner and BasketQuorumService
export const signalAuditStore = new SignalAuditStore();
