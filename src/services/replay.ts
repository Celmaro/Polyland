/**
 * ============================================================================
 * QUARANTINED — DIAGNOSTIC ONLY. NOT GO-LIVE EVIDENCE.
 * ============================================================================
 * This module is the NAIVE diagnostic replay: it invents exit prices from
 * entry price + final resolution (won ? entry+takeProfit : entry-stopLoss) and
 * has no historical book path. It must NEVER feed the go-live gate.
 *
 * The go-live evidence path is: SignalAuditStore.getSettledSignals() ->
 * computeGoLiveReport() in go-live-gate.ts (real fills, fees, partials).
 * The trustworthy replay path is ReplayEvaluator (replay-evaluator.ts),
 * which prices fills from decision-time books through the shared fill-engine.
 *
 * Only the diagnostic CLI (replay-cli.ts) imports this module. Do not import
 * it from the runtime, the gate, or any evidence-producing path.
 * ============================================================================
 */
export const REPLAY_DIAGNOSTIC_MODE = 'DIAGNOSTIC_ONLY' as const;
/**
 * replay.ts — backtest-replay over historical fired signals.
 *
 * Why: the audit identified 60%+ of losses as basket-design / exit-design
 * problems. We can't tell whether the new exit math is actually better
 * without re-running it against historical fired signals. This module
 * is the offline-only answer: takes a FiredSignal[] (read from JSONL,
 * not from a live run), pumps each one through the same `evaluateExit`
 * shape the live bot uses, and reports the per-signal simulated PnL
 * vs. recorded PnL.
 *
 * NOT used at runtime. Always opt-in via REPLAY_MODE=true or `npm run
 * replay`. The live bot never calls into this file.
 */
import type { FiredSignal } from './signal-audit-store.js';

export interface ReplayConfig {
  /** Which exit-config profile to simulate against. */
  exitConfig?: 'audit' | 'aggressive' | 'conservative';
  /** Stop-loss fraction per share. */
  stopLossPct?: number;
  /** Take-profit fraction per share. */
  takeProfitPct?: number;
  /** Max hold time, in seconds. */
  maxHoldSeconds?: number;
  /** How much disagreement (in $/share) flags an outlier. */
  slippageFlagThreshold?: number;
}

export interface ReplayEntry {
  id: string;
  category: string;
  side: 'BUY' | 'SELL';
  pricePaid: number;
  resolved?: number;
  recordedPnl: number;
  simulatedPnl: number;
  delta: number;
  holdSeconds: number;
  exitReason: string;
  slippageFlag: boolean;
}

export interface ReplayResult {
  entries: ReplayEntry[];
  byCategory: Record<string, { n: number; totalPnl: number; avgDelta: number }>;
  totalRecorded: number;
  totalSimulated: number;
  totalDelta: number;
  slippageFlags: number;
}

const DEFAULT_EXIT_PROFILES: Record<string, { stop: number; tp: number; holdMax: number; slipThresh: number }> = {
  audit:        { stop: 0.10, tp: 0.05, holdMax: 86_400, slipThresh: 0.05 },
  aggressive:   { stop: 0.05, tp: 0.03, holdMax: 600,    slipThresh: 0.05 },
  conservative: { stop: 0.15, tp: 0.10, holdMax: 1_800,  slipThresh: 0.05 },
};

/**
 * Re-run exit math over historical fired signals.
 *
 * Each signal is replayed:
 *   1. If it has a recorded `realizedEdge` (settlement PnL), that is the
 *      "recorded" baseline.
 *   2. We simulate the new exit ladder: stop-loss, take-profit, max hold,
 *      with the configured profile. The simulated exit price is computed
 *      from the entry price + exit-config thresholds. If the signal was
 *      resolved (resolved ∈ {0,1}), the simulated PnL is payout − entry.
 *   3. `delta = simulated − recorded` flags where the new logic would
 *      have produced a materially different PnL.
 *
 * No exchange connectivity. No async I/O. Pure function over its inputs.
 */
export function replaySettlements(
  signals: FiredSignal[],
  config: ReplayConfig = {},
): ReplayResult {
  const profile = DEFAULT_EXIT_PROFILES[config.exitConfig ?? 'audit'];
  const stopLoss = config.stopLossPct ?? profile.stop;
  const takeProfit = config.takeProfitPct ?? profile.tp;
  const maxHold = config.maxHoldSeconds ?? profile.holdMax;
  const slipThresh = config.slippageFlagThreshold ?? profile.slipThresh;

  const entries: ReplayEntry[] = [];
  const byCat = new Map<string, { n: number; totalPnl: number; sumDelta: number }>();
  let totalRecorded = 0;
  let totalSimulated = 0;
  let totalDelta = 0;
  let slippageFlags = 0;

  for (const sig of signals) {
    if (sig.settledAt === undefined || sig.resolved === undefined) continue;
    const entry = sig.pricePaid;
    const won = sig.resolved === 1;
    // Naive simulation: assume the new exit math hits TP first if entry+rising,
    // SL first if entry+falling. Without price history we approximate: use
    // entry+take-profit-or-stop-loss depending on resolution direction.
    const exitPrice = won ? Math.min(1, entry + takeProfit) : Math.max(0, entry - stopLoss);
    const pnlPerShare = sig.side === 'BUY'
      ? (won ? exitPrice - entry : exitPrice - entry)
      : (won ? entry - exitPrice : entry - exitPrice);
    const simulated = pnlPerShare * sig.size;
    const recorded = sig.realizedEdge ?? 0;
    const delta = simulated - recorded;
    const holdSec = Math.max(0, ((sig.exitedAt ?? sig.settledAt) - sig.firedAt) / 1000);
    const exitReason = holdSec > maxHold ? 'MAX_HOLD' : (won ? 'TAKE_PROFIT' : 'STOP_LOSS');
    const slip = Math.abs(delta) > slipThresh * sig.size;
    if (slip) slippageFlags++;

    entries.push({
      id: sig.id,
      category: sig.basket,
      side: sig.side,
      pricePaid: entry,
      resolved: sig.resolved,
      recordedPnl: recorded,
      simulatedPnl: simulated,
      delta,
      holdSeconds: holdSec,
      exitReason,
      slippageFlag: slip,
    });

    totalRecorded += recorded;
    totalSimulated += simulated;
    totalDelta += delta;

    const cat = byCat.get(sig.basket) ?? { n: 0, totalPnl: 0, sumDelta: 0 };
    cat.n += 1;
    cat.totalPnl += recorded;
    cat.sumDelta += delta;
    byCat.set(sig.basket, cat);
  }

  const byCategory: ReplayResult['byCategory'] = {};
  for (const [k, v] of byCat.entries()) {
    byCategory[k] = { n: v.n, totalPnl: v.totalPnl, avgDelta: v.n > 0 ? v.sumDelta / v.n : 0 };
  }

  return {
    entries,
    byCategory,
    totalRecorded,
    totalSimulated,
    totalDelta,
    slippageFlags,
  };
}
