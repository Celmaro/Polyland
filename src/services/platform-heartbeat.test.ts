/**
 * R8 tests: platform-level outage detection + external alerting.
 *
 * The in-process watchdog can't fire when the POD is dead (NodeNotReady). Two
 * additions:
 *  1. External heartbeat: the bot pings HEARTBEAT_URL on an interval so an
 *     external uptime monitor can alert when the pod stops responding.
 *  2. Startup stall alarm: if no feed events arrive within startStallMs of
 *     boot, fire the audit webhook (AUDIT_WEBHOOK_URL) so an operator is
 *     alerted even though the pod is alive-but-deaf.
 */
import { describe, it, expect } from 'vitest';
import {
  buildHeartbeatPayload,
  evaluateStartupStall,
  type StartupStallState,
} from './platform-heartbeat.js';

describe('R8 — external heartbeat payload', () => {
  it('builds a minimal heartbeat with uptime + feed age', () => {
    const p = buildHeartbeatPayload({ uptimeSec: 3600, feedAgeSec: 5, mode: 'DRY RUN' });
    expect(p.uptimeSec).toBe(3600);
    expect(p.feedAgeSec).toBe(5);
    expect(p.mode).toBe('DRY RUN');
    expect(p.ts).toBeGreaterThan(0);
  });
});

describe('R8 — startup stall alarm', () => {
  const BASE: StartupStallState = { startedAt: 0, now: 60_000, lastFeedEventAt: 0, startStallMs: 30_000 };

  it('alarms when no feed event within startStallMs of boot', () => {
    const r = evaluateStartupStall(BASE);
    expect(r.alarm).toBe(true);
    expect(r.reason).toContain('no feed events');
  });

  it('does NOT alarm when a feed event arrived', () => {
    const r = evaluateStartupStall({ ...BASE, lastFeedEventAt: 30_000 });
    expect(r.alarm).toBe(false);
  });

  it('does NOT alarm before the stall window elapses', () => {
    const r = evaluateStartupStall({ ...BASE, now: 10_000 });
    expect(r.alarm).toBe(false);
  });

  it('alarms once (dedup) — repeated evaluation with same lastEvent does not re-fire', () => {
    let fired = 0;
    const state: StartupStallState = { ...BASE, lastFeedEventAt: 0, alarmFiredAt: null };
    const r1 = evaluateStartupStall(state);
    if (r1.alarm) { fired++; state.alarmFiredAt = r1.at; }
    const r2 = evaluateStartupStall(state);
    if (r2.alarm) fired++;
    expect(fired).toBe(1); // deduped
  });
});
