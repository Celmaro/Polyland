export type WsState = 'disconnected' | 'connecting' | 'backoff' | 'live';
export interface WsStateOptions { baseBackoffMs?: number; maxBackoffMs?: number; maxOutageMs?: number; now?: () => number; random?: () => number }

/** Explicit reconnect/resync state machine for a market WebSocket. */
export class WsConnectionStateMachine {
  private _state: WsState = 'disconnected';
  private _attempts = 0;
  private _reconnects = 0;
  private _resyncs = 0;
  private _snapshotRequired = true;
  private _outageStart: number | null = null;
  private readonly o: Required<WsStateOptions>;
  constructor(options: WsStateOptions = {}) { this.o = { baseBackoffMs: 500, maxBackoffMs: 30_000, maxOutageMs: Infinity, now: () => Date.now(), random: Math.random, ...options }; }
  get state(): WsState { return this._state; }
  get attempts(): number { return this._attempts; }
  get reconnects(): number { return this._reconnects; }
  get resyncs(): number { return this._resyncs; }
  get snapshotRequired(): boolean { return this._snapshotRequired; }
  onConnecting(): void { this._state = 'connecting'; }
  onConnected(): void { this._state = 'connecting'; }
  onSubscribed(): void { this._state = 'connecting'; this._snapshotRequired = true; }
  onSnapshotReceived(): void { this._snapshotRequired = false; this._state = 'live'; this._resyncs += 1; }
  onDisconnect(): void { this._state = 'backoff'; this._reconnects++; this._attempts++; if (this._outageStart === null) this._outageStart = this.o.now(); }
  markStable(): void { this._attempts = 0; if (this._state === 'live') this._outageStart = null; }
  backoffDelayMs(): number { const max = Math.min(this.o.maxBackoffMs, this.o.baseBackoffMs * 2 ** Math.min(this._attempts - 1, 16)); return this.o.random() * max; }
  outageMs(): number { return this._outageStart === null ? 0 : Math.max(0, this.o.now() - this._outageStart); }
  outageHalted(): boolean { return this.outageMs() > this.o.maxOutageMs; }
}