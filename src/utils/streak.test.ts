import { describe, it, expect } from 'vitest';
import { initialStreakState, updateStreak } from './streak.js';

describe('streak / cumulative tally semantics', () => {
  it('win increments consecutive + total wins and resets loss streak', () => {
    const s = updateStreak(initialStreakState(), 0.5);
    expect(s.consecutiveWins).toBe(1);
    expect(s.totalWins).toBe(1);
    expect(s.consecutiveLosses).toBe(0);
    expect(s.totalLosses).toBe(0);
    expect(s.scratchTrades).toBe(0);
  });

  it('loss increments consecutive + total losses and resets win streak', () => {
    const s = updateStreak(updateStreak(initialStreakState(), 0.5), -0.3);
    expect(s.consecutiveWins).toBe(0);
    expect(s.totalWins).toBe(1);
    expect(s.consecutiveLosses).toBe(1);
    expect(s.totalLosses).toBe(1);
  });

  it('zero PnL is a scratch: preserves both streaks, counts no win/loss', () => {
    // Two wins then a scratch must NOT be counted as a third win NOR reset losses.
    let s = updateStreak(initialStreakState(), 0.5);
    s = updateStreak(s, 0.4);
    s = updateStreak(s, 0.0);
    expect(s.consecutiveWins).toBe(2); // unchanged by scratch
    expect(s.totalWins).toBe(2);
    expect(s.consecutiveLosses).toBe(0); // not reset to something
    expect(s.scratchTrades).toBe(1);
  });

  it('scratch on a loss streak preserves the loss streak', () => {
    let s = updateStreak(initialStreakState(), -0.2);
    s = updateStreak(s, 0.0);
    expect(s.consecutiveLosses).toBe(1);
    expect(s.consecutiveWins).toBe(0);
    expect(s.scratchTrades).toBe(1);
  });

  it('accumulates totals across alternating outcomes', () => {
    const s = [0.5, -0.3, 0.2, 0.0, -0.1].reduce((acc, p) => updateStreak(acc, p), initialStreakState());
    expect(s.totalWins).toBe(2);
    expect(s.totalLosses).toBe(2);
    expect(s.scratchTrades).toBe(1);
    expect(s.consecutiveWins).toBe(0); // last was a loss
    expect(s.consecutiveLosses).toBe(1);
  });
});