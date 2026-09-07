import { describe, expect, it } from 'vitest';
import { PositionStateMachine, evaluateExit, transition, type ExitEvent, type Position } from './position-state-machine.js';

function pos(over: Partial<Position> = {}): Position {
  return {
    id: 'p1', conditionId: 'cond-1', tokenId: 'token-1', outcome: 'Yes', side: 'BUY',
    shares: 0, entryPrice: 0.5, entryTime: 1, state: 'PLANNED', basket: 'crypto', ...over,
  };
}

describe('PositionStateMachine', () => {
  it('walks the happy path OPEN -> EXIT -> CLOSED', () => {
    const m = new PositionStateMachine();
    m.open(pos());
    // entry: partial fill then full fill
    expect(m.apply('p1', { type: 'FILL', shares: 60, state: 'partial' })).toBe('PARTIAL');
    expect(m.apply('p1', { type: 'FILL', shares: 40, state: 'full' })).toBe('OPEN');
    expect(m.get('p1')?.shares).toBe(100);
    // leader exit is a trigger, not a state change
    m.apply('p1', { type: 'LEADER_EXIT', leaderShares: 100, time: 10 });
    expect(m.get('p1')?.state).toBe('OPEN');
    // exit: request, partial fill, remaining full fill -> CLOSED
    expect(m.apply('p1', { type: 'EXIT', shares: 100, reason: 'value_exit', time: 20 })).toBe('EXIT_REQUESTED');
    expect(m.get('p1')?.exitReason).toBe('value_exit');
    expect(m.apply('p1', { type: 'FILL', shares: 60, state: 'partial' })).toBe('EXIT_PARTIAL');
    expect(m.get('p1')?.shares).toBe(40);
    expect(m.apply('p1', { type: 'FILL', shares: 40, state: 'full' })).toBe('CLOSED');
    expect(m.get('p1')?.shares).toBe(0);
  });

  it('records unknown order states instead of assuming success', () => {
    const m = new PositionStateMachine();
    m.open(pos());
    m.apply('p1', { type: 'OPENED', shares: 100, price: 0.5, time: 2 });
    expect(m.apply('p1', { type: 'FILL', state: 'unknown' })).toBe('ORDER_UNKNOWN');
    expect(m.apply('p1', { type: 'FILL', state: 'failed' })).toBe('RECONCILIATION_REQUIRED');
  });

  it('handles resolution and redemption without double-counting', () => {
    const m = new PositionStateMachine();
    m.open(pos());
    m.apply('p1', { type: 'OPENED', shares: 100, price: 0.5, time: 2 });
    m.apply('p1', { type: 'RESOLVED', winningTokenId: 'token-1', time: 100 });
    expect(m.get('p1')?.state).toBe('RESOLUTION_PENDING');
    expect(m.get('p1')?.resolvedAt).toBe(100);
    expect(m.apply('p1', { type: 'REDEEMED', time: 200 })).toBe('SETTLED');
    expect(m.get('p1')?.redeemedAt).toBe(200);
    // Terminal: further events are no-ops, settlement cannot double-count.
    expect(m.apply('p1', { type: 'FILL', state: 'full' })).toBe('SETTLED');
  });

  it('risk halt is always allowed and terminal', () => {
    const m = new PositionStateMachine();
    m.open(pos());
    m.apply('p1', { type: 'OPENED', shares: 100, price: 0.5, time: 2 });
    expect(m.apply('p1', { type: 'RISK_HALT', reason: 'kill_switch', time: 3 })).toBe('HALTED');
    expect(m.apply('p1', { type: 'RESOLVED', winningTokenId: 'x', time: 4 })).toBe('HALTED');
  });

  it('rejects invalid transitions', () => {
    const m = new PositionStateMachine();
    m.open(pos());
    expect(() => m.apply('p1', { type: 'REDEEMED', time: 2 })).toThrow(/invalid transition/);
    expect(() => m.apply('missing', { type: 'OPENED', shares: 1, price: 0.5, time: 1 })).toThrow(/not found/);
  });
});

describe('evaluateExit', () => {
  const base = {
    inventoryShares: 100,
    executableBidVwap: 0.55,
    sellFeePerShare: 0.002,
    impactBufferPerShare: 0.005,
    fairProb: 0.5,
  };

  it('has no inventory -> NO_INVENTORY, never a reverse trade', () => {
    expect(evaluateExit({ ...base, inventoryShares: 0 }).action).toBe('NO_INVENTORY');
  });

  it('sells a collapsed position when fair value is the live market price', () => {
    // Audit scenario: entry 0.245, market collapsed to bid 0.044 / ask 0.06.
    // sellValue = (0.044 − 0.002 − 0.005) = 0.037/share; hold = 0.052 − 0.02 = 0.032
    // → raw edge 0.005/share is BELOW the hysteresis floor (max(0.02, 0.008)=0.02)
    // → value-exit says HOLD, but entryPrice is supplied so the TIME-SCALED
    // adverse-move cut fires: bid 0.044 ≤ 0.245 × (1 − 0.10) for any short
    // horizon. Real collapses exit via the risk cut, not the value flicker.
    const r = evaluateExit({
      inventoryShares: 100,
      entryPrice: 0.245,
      executableBidVwap: 0.044,
      sellFeePerShare: 0.002,
      impactBufferPerShare: 0.005,
      holdingRiskBufferPerShare: 0.02,
      fairProb: (0.044 + 0.06) / 2, // live mid, not the stale entry winRate
      bookSpread: 0.06 - 0.044,
      secondsToExpiry: 1800,
      leaderExit: { leaderShares: 0, confirmed: true },
    });
    expect(r.action).toBe('RISK_EXIT');
    expect(r.reason).toBe('adverse_move');
    if (r.action === 'RISK_EXIT') expect(r.quantity).toBe(100);
  });

  it('forces a bounded adverse-move exit even when live fair value says hold', () => {
    const r = evaluateExit({
      inventoryShares: 100,
      entryPrice: 0.245,
      executableBidVwap: 0.044,
      sellFeePerShare: 0.002,
      impactBufferPerShare: 0.005,
      fairProb: 0.052,
      maxAdverseMovePct: 0.35,
    });
    expect(r).toEqual({ action: 'RISK_EXIT', quantity: 100, reason: 'adverse_move' });
  });

  it('sells when the executable bid value beats holding expected value', () => {
    // sell 0.55-0.007=0.543/share; hold 0.5 → sell
    const r = evaluateExit(base);
    expect(r.action).toBe('SELL');
    if (r.action === 'SELL') expect(r.quantity).toBe(100);
  });

  it('holds when fair probability dominates the bid value', () => {
    const r = evaluateExit({ ...base, fairProb: 0.9 });
    expect(r.action).toBe('HOLD');
  });

  it('confirmed leader exit is an information event that bypasses the value check', () => {
    // The entry quorum flipping IS the alpha signal: it must not be
    // subordinate to the sell-vs-hold arithmetic (a wide-spread thin book
    // would otherwise prefer "holding" a position whose thesis just died).
    // Quantity is still capped at the leader's proportional reduction.
    const r = evaluateExit({ ...base, fairProb: 0.9, leaderExit: { leaderShares: 40, confirmed: true } });
    expect(r.action).toBe('SELL');
    if (r.action === 'SELL') expect(r.quantity).toBe(40);
    // Full flip → full exit.
    const full = evaluateExit({ ...base, fairProb: 0.9, leaderExit: { leaderShares: 100, confirmed: true } });
    expect(full).toEqual({ action: 'SELL', quantity: 100, reason: 'leader_exit' });
  });

  it('value exit respects hysteresis — a one-tick sag does not trigger a dump', () => {
    // bid 0.55 vs fair 0.50: sellValue 0.543 vs hold+hysteresis 0.48+0.03=0.51
    // → 0.043/share of real edge clears the 0.03 hysteresis → SELL.
    const r = evaluateExit({ ...base, bookSpread: 0.06 });
    expect(r.action).toBe('SELL');
    // A thin edge: bid 0.53 → sellValue 0.523 vs 0.51 → 0.013/share edge
    // does NOT clear hysteresis 0.03 → HOLD. (Pre-fix this sold and donated
    // the spread; now the market must move beyond noise.)
    const marginal = evaluateExit({ ...base, executableBidVwap: 0.53, bookSpread: 0.06 });
    expect(marginal.action).toBe('HOLD');
    // And a pure one-tick situation: bid 0.49 vs fair 0.50 → sell 0.483 vs
    // hold 0.48 + hysteresis 0.025 = 0.505 → HOLD. No more −1-tick donation.
    const onetick = evaluateExit({ ...base, executableBidVwap: 0.49, fairProb: 0.50, bookSpread: 0.05 });
    expect(onetick.action).toBe('HOLD');
  });

  it('resolved winners are redeemed, not sold', () => {
    const r = evaluateExit({ ...base, resolvedWinning: true });
    expect(r.action).toBe('RESOLVE');
  });

  it('risk halt forces a full risk exit', () => {
    const r = evaluateExit({ ...base, riskHalt: true });
    expect(r.action).toBe('RISK_EXIT');
  });

  it('requires positive margin before selling vs holding', () => {
    // sell value 0.543*100 = 54.3, hold 0.5*100 = 50 → sell only if margin 0;
    // with a large required margin, hold wins.
    const r = evaluateExit({ ...base, requiredMarginPerShare: 0.1 });
    expect(r.action).toBe('HOLD');
  });
});

describe('transition validation', () => {
  it('rejects terminal-state mutations and unknown events', () => {
    expect(transition('SETTLED', { type: 'FILL', state: 'full' })).toEqual({ ok: true, state: 'SETTLED' });
    expect(transition('OPEN', { type: 'REDEEMED', time: 1 })).toEqual({ ok: false, error: 'cannot REDEEM from OPEN' });
    expect(transition('OPEN', { type: 'CANCEL' })).toEqual({ ok: true, state: 'PLANNED' });
  });
});