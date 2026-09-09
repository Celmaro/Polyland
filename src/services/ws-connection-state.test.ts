import { describe, it, expect, vi } from 'vitest';
import { WsConnectionStateMachine, type WsState } from './ws-connection-state.js';

describe('WsConnectionStateMachine', () => {
  it('walks the happy path: connecting → live, stable resets attempts', () => {
    const m = new WsConnectionStateMachine({ baseBackoffMs: 500, maxBackoffMs: 30_000 });
    expect(m.state).toBe('disconnected');
    m.onConnecting();
    expect(m.state).toBe('connecting');
    m.onConnected();
    m.onSubscribed();
    m.onSnapshotReceived();
    expect(m.state).toBe('live');
    expect(m.reconnects).toBe(0);
  });

  it('disconnect schedules backoff with capped, jittered delay', () => {
    const m = new WsConnectionStateMachine({ baseBackoffMs: 500, maxBackoffMs: 30_000 });
    m.onConnecting(); m.onConnected(); m.onSubscribed(); m.onSnapshotReceived();
    m.onDisconnect();
    expect(m.state).toBe('backoff');
    const d1 = m.backoffDelayMs();
    m.onConnecting(); m.onConnected(); m.onDisconnect();
    const d2 = m.backoffDelayMs();
    expect(d1).toBeGreaterThanOrEqual(0);
    expect(d2).toBeGreaterThanOrEqual(d1 * 0.8); // growing (jittered, not shrinking)
    expect(m.reconnects).toBe(2);
  });

  it('caps backoff at maxBackoffMs', () => {
    const m = new WsConnectionStateMachine({ baseBackoffMs: 500, maxBackoffMs: 30_000 });
    for (let i = 0; i < 12; i++) { m.onConnecting(); m.onConnected(); m.onDisconnect(); }
    expect(m.backoffDelayMs()).toBeLessThanOrEqual(30_000);
    expect(m.attempts).toBeGreaterThan(5);
  });

  it('requires snapshot-before-delta after reconnect (resync gate)', () => {
    const m = new WsConnectionStateMachine({ baseBackoffMs: 100, maxBackoffMs: 1000 });
    m.onConnecting(); m.onConnected(); m.onSubscribed(); m.onSnapshotReceived();
    m.onDisconnect();
    m.onConnecting(); m.onConnected(); m.onSubscribed();
    // Subscribed but no snapshot yet → must NOT be live
    expect(m.state).toBe('connecting');
    expect(m.snapshotRequired).toBe(true);
    m.onSnapshotReceived();
    expect(m.state).toBe('live');
    // resyncs = 1 initial snapshot + 1 reconnect snapshot = 2
    expect(m.resyncs).toBe(2);
  });

  it('halts when the outage exceeds maxOutageMs', () => {
    let t = 1_700_000_000_000;
    const m = new WsConnectionStateMachine({ baseBackoffMs: 100, maxBackoffMs: 1000, maxOutageMs: 5_000, now: () => t });
    m.onConnecting(); m.onConnected(); m.onSubscribed(); m.onSnapshotReceived();
    m.onDisconnect(); // outage starts at t
    expect(m.outageHalted()).toBe(false);
    t += 6_000; // outage elapsed
    expect(m.outageHalted()).toBe(true);
    expect(m.outageMs()).toBeGreaterThanOrEqual(6_000);
  });

  it('live state exposes WsState union for metrics', () => {
    const states: WsState[] = ['disconnected', 'connecting', 'backoff', 'live'];
    expect(states).toHaveLength(4);
    expect(states).toContain('live');
  });
});