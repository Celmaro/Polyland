/**
 * R8 — platform-level outage detection + external alerting.
 *
 * The in-process feed-stall watchdog cannot fire when the POD is dead
 * (NodeNotReady). Two complementary additions:
 *
 *  1. External heartbeat: the bot pings HEARTBEAT_URL on an interval (with a
 *     small JSON body) so an external uptime monitor (cron, Healthchecks.io,
 *     Better Uptime, Zeabur health checks) can alert when the pod stops
 *     responding. The heartbeat URL is the monitor's endpoint; the monitor
 *     is what notices the silence.
 *
 *  2. Startup stall alarm: if no feed events arrive within startStallMs of
 *     boot, fire the existing AUDIT_WEBHOOK_URL so an operator is alerted
 *     even though the pod is alive-but-deaf (e.g. WS connected but upstream
 *     data-api silent). Deduped so it fires once per boot.
 *
 * Pure/stateless helpers for testability; the runtime wires them.
 */
export interface HeartbeatPayload {
  ts: number;
  uptimeSec: number;
  feedAgeSec: number;
  mode: string;
}

export function buildHeartbeatPayload(params: { uptimeSec: number; feedAgeSec: number; mode: string }): HeartbeatPayload {
  return {
    ts: Date.now(),
    uptimeSec: Math.max(0, Math.floor(params.uptimeSec)),
    feedAgeSec: Math.max(0, Math.floor(params.feedAgeSec)),
    mode: params.mode,
  };
}

export interface StartupStallState {
  startedAt: number;
  now: number;
  lastFeedEventAt: number;
  startStallMs: number;
  /** Set once the alarm has fired (dedup). */
  alarmFiredAt?: number | null;
}

export interface StallAlarmResult {
  alarm: boolean;
  at?: number;
  reason?: string;
}

/**
 * Evaluate whether the startup stall window elapsed with no feed events.
 * Deduped: after firing once (alarmFiredAt set), later evaluations no-op.
 */
export function evaluateStartupStall(state: StartupStallState): StallAlarmResult {
  const { startedAt, now, lastFeedEventAt, startStallMs } = state;
  if (state.alarmFiredAt) return { alarm: false };
  const elapsed = now - startedAt;
  if (elapsed < startStallMs) return { alarm: false };
  // A feed event at/after boot clears the stall.
  if (lastFeedEventAt > startedAt) return { alarm: false };
  return {
    alarm: true,
    at: now,
    reason: `no feed events within ${(startStallMs / 1000).toFixed(0)}s of startup (feed age ${((now - Math.max(lastFeedEventAt, startedAt)) / 1000).toFixed(0)}s)`,
  };
}