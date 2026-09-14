/**
 * Shared win/loss streak + cumulative tally semantics.
 *
 * Used by BOTH PolylandRuntime.applySettled (snapshot) and RiskManager.recordTrade
 * so the two P&L surfaces can never disagree on a trade's effect.
 *
 * Rules:
 *   - pnl < 0  → consecutiveLosses++, consecutiveWins = 0, totalLosses++
 *   - pnl > 0  → consecutiveWins++, consecutiveLosses = 0, totalWins++
 *   - pnl === 0 → SCRATCH: preserve both streaks (do NOT zero them), scratchTrades++
 *
 * The zero-PnL rule matters: a scratch/rounded exit (e.g. bid==entry) is neither
 * a win nor a loss, so it must not reset the opposite streak nor count as a win.
 */
export interface StreakState {
  consecutiveLosses: number;
  consecutiveWins: number;
  totalWins: number;
  totalLosses: number;
  scratchTrades: number;
}

export function initialStreakState(): StreakState {
  return {
    consecutiveLosses: 0,
    consecutiveWins: 0,
    totalWins: 0,
    totalLosses: 0,
    scratchTrades: 0,
  };
}

/** Apply one settled trade to a StreakState (mutates and returns it). */
export function updateStreak(state: StreakState, pnlUsd: number): StreakState {
  if (pnlUsd < 0) {
    state.consecutiveLosses++;
    state.consecutiveWins = 0;
    state.totalLosses++;
  } else if (pnlUsd > 0) {
    state.consecutiveWins++;
    state.consecutiveLosses = 0;
    state.totalWins++;
  } else {
    // Scratch — neither won nor lost; do not reset the opposite streak.
    state.scratchTrades++;
  }
  return state;
}