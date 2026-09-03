/**
 * Anti-sniper guard unit tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AntiSniperGuard, DEFAULT_ANTI_SNIPER_CONFIG } from './anti-sniper.js';

describe('AntiSniperGuard', () => {
  let guard: AntiSniperGuard;

  beforeEach(() => {
    guard = new AntiSniperGuard(null);
  });

  it('rejects fire when no mid has been observed', () => {
    const decision = guard.allowFire('tok-1');
    // No mid stable confirm yet → reject
    expect(decision.allow).toBe(false);
  });

  it('allows fire after observing a stable mid past the confirm window', () => {
    const now = 1_000_000;
    guard.observe('tok-1', 0.5, now - 2_000); // 2s ago
    const decision = guard.allowFire('tok-1', now);
    // Mid has been stable for 2s, no jump, no recent fire
    expect(decision.allow).toBe(true);
  });

  it('rejects fire when mid jumped more than threshold', () => {
    const now = 1_000_000;
    guard.observe('tok-1', 0.5, now - 500);
    guard.observe('tok-1', 0.6, now); // 10% jump in 500ms
    const decision = guard.allowFire('tok-1', now);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toMatch(/mid_jump/);
  });

  it('rejects fire when mid is unstable (recent change within stable window)', () => {
    const now = 1_000_000;
    guard.observe('tok-1', 0.5, now - 200);
    const decision = guard.allowFire('tok-1', now);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toMatch(/mid_unstable/);
  });

  it('sub-tolerance price noise does NOT reset the stable-mid timer', () => {
    // Regression: trade-price vs book-mid observations alternate by <1 tick
    // on high-frequency markets. Previously every such observation reset
    // midLastChangeMs → mid_unstable rejected every fire (95% block rate).
    const now = 1_000_000;
    guard.observe('tok-1', 0.5, now - 5_000);          // real change: starts timer
    guard.observe('tok-1', 0.502, now - 100);          // +0.002 < 0.005 tolerance
    guard.observe('tok-1', 0.501, now - 50);           // noise again
    const decision = guard.allowFire('tok-1', now);    // stable since now-5000
    expect(decision.allow).toBe(true);
  });

  it('rejects second fire within fill cooldown', () => {
    const now = 1_000_000;
    guard.observe('tok-1', 0.5, now - 2_000);
    expect(guard.allowFire('tok-1', now).allow).toBe(true);
    guard.recordFire('tok-1', now);
    const next = guard.allowFire('tok-1', now + 1_000); // 1s later
    expect(next.allow).toBe(false);
    expect(next.reason).toMatch(/fill_cooldown/);
  });

  it('allows fire after fill cooldown elapses', () => {
    const now = 1_000_000;
    guard.observe('tok-1', 0.5, now - 10_000);
    guard.recordFire('tok-1', now);
    const decision = guard.allowFire('tok-1', now + 6_000);
    expect(decision.allow).toBe(true);
  });

  it('clamps reprice to maxRepriceTicks * tickSize', () => {
    const guard2 = new AntiSniperGuard(null, {
      ...DEFAULT_ANTI_SNIPER_CONFIG,
      maxRepriceTicks: 2,
    });
    guard2.clampReprice('tok-1', 0.50, 0.01); // first emit
    const clamped = guard2.clampReprice('tok-1', 0.60, 0.01); // want +0.10
    // 2 ticks * 0.01 = 0.02 max move
    expect(clamped).toBeCloseTo(0.52, 6);
  });

  it('does not clamp on first observation (no reference)', () => {
    const first = guard.clampReprice('tok-1', 0.5, 0.01);
    expect(first).toBe(0.5);
  });

  it('reset() clears all state', () => {
    const now = 1_000_000;
    guard.observe('tok-1', 0.5, now - 100);
    guard.reset();
    // After reset, no mid observed → reject (unstable)
    const decision = guard.allowFire('tok-1', now);
    expect(decision.allow).toBe(false);
  });

  it('tracks each token independently', () => {
    const now = 1_000_000;
    guard.observe('tok-1', 0.5, now - 2_000);
    guard.observe('tok-2', 0.5, now - 100); // unstable
    expect(guard.allowFire('tok-1', now).allow).toBe(true);
    expect(guard.allowFire('tok-2', now).allow).toBe(false);
  });
});
