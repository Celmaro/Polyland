/**
 * R1 tests: fire-on-first-vote confirm window. When a basket fires on a single
 * vote (quorum=1), a contradictory second vote arriving within confirmWindowMs
 * is a post-hoc reversal signal (paper flag / reversal). Pure/stateless.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateConfirmWindow,
  type ConfirmWindowInput,
} from './fire-first-vote.js';

const BASE: ConfirmWindowInput = {
  firstVote: { wallet: '0xa', outcome: 'Yes', side: 'BUY', price: 0.6, ts: 1000 },
  confirmWindowMs: 60_000,
};

describe('R1 — fire-on-first-vote confirm window', () => {
  it('confirms a same-direction second vote inside the window', () => {
    const r = evaluateConfirmWindow({
      ...BASE,
      secondVote: { wallet: '0xb', outcome: 'Yes', side: 'BUY', price: 0.61, ts: 2000 },
    });
    expect(r.action).toBe('confirm');
    expect(r.reason).toContain('aligned');
  });

  it('flags a contradictory second vote inside the window as reversal risk', () => {
    const r = evaluateConfirmWindow({
      ...BASE,
      // Opposite side on same outcome = contradictory
      secondVote: { wallet: '0xb', outcome: 'Yes', side: 'SELL', price: 0.6, ts: 2000 },
    });
    expect(r.action).toBe('reversal_risk');
    expect(r.reason).toContain('contradict');
  });

  it('treats a same-outcome BUY outside the window as no-longer-relevant', () => {
    const r = evaluateConfirmWindow({
      ...BASE,
      secondVote: { wallet: '0xb', outcome: 'Yes', side: 'BUY', price: 0.61, ts: 1000 + 120_000 },
    });
    expect(r.action).toBe('outside_window');
  });

  it('returns no_second_vote when none arrives', () => {
    const r = evaluateConfirmWindow({ ...BASE, secondVote: undefined });
    expect(r.action).toBe('no_second_vote');
  });

  it('flags a flip to the opposite outcome inside the window', () => {
    const r = evaluateConfirmWindow({
      ...BASE,
      secondVote: { wallet: '0xb', outcome: 'No', side: 'BUY', price: 0.4, ts: 2000 },
    });
    expect(r.action).toBe('reversal_risk');
  });
});