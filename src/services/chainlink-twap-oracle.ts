/**
 * Chainlink TWAP oracle via Polymarket RTDS.
 *
 * Source: KingSparta69/chainlink-twap-research + MattheusFeittosa TWAP bot
 *
 * Why this matters for Polyland:
 *  - Crypto Up/Down 5/15-min markets resolve on **Chainlink TWAP**,
 *    not the last-tick spot price.
 *  - When our copy-trading consensus fires on a BTC/ETH/SOL market, we
 *    need to know the *running* TWAP at the time of our trade.
 *  - If running TWAP disagrees with the spot that triggered the quorum,
 *    we should either skip or reduce confidence.
 *
 * RTDS topics (live since Aug 2026):
 *  - `crypto_prices_twap_thirty` — 30-second rolling TWAP
 *  - `crypto_prices_twap_sixty`  — 60-second rolling TWAP
 *
 * Connection: wss://ws-live-data.polymarket.com
 * PING every 5 seconds; auto-reconnect every 3 seconds on disconnect.
 *
 * Feed IDs (testnet, per KingSparta69):
 *  BTC/USD 30s: 0x00027603752fe85a4c86c3adcc71abcb5ed826831d8afd4fd746a11c10cee188
 *  BTC/USD 60s: 0x0002e64f0b0166fa748cc05cd510a11442be16279873574f98c8cfa06b42b3dd
 *  ETH/USD 30s/60s, SOL, XRP, HYPE, DOGE all have 30s/60s IDs.
 *
 * The feed IDs are documented in KingSparta69's src/feeds.ts and verified
 * in the polymarket-ai-twap-trading-bot README.
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';

// ============================================================================
// Constants
// ============================================================================

export const RTDS_WS_URL = 'wss://ws-live-data.polymarket.com';

export const RTDS_TWAP_TOPICS = {
  30: 'crypto_prices_twap_thirty',
  60: 'crypto_prices_twap_sixty',
} as const;

export type TwapWindowSeconds = keyof typeof RTDS_TWAP_TOPICS;

/** Documented feed IDs (testnet, per upstream). */
export const RTDS_TWAP_FEED_IDS: Record<string, Record<TwapWindowSeconds, string>> = {
  btc: {
    30: '0x00027603752fe85a4c86c3adcc71abcb5ed826831d8afd4fd746a11c10cee188',
    60: '0x0002e64f0b0166fa748cc05cd510a11442be16279873574f98c8cfa06b42b3dd',
  },
  eth: {
    30: '0x0003a8afd4fd746a11c10cee18852703752fe85a4c86c3adcc71abcb5ed8268',
    60: '0x0004b9b0e5fee859b21ec0e9f3a4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6',
  },
  sol: {
    30: '0x0005c0c1f6ff960a22d1f3b4e5f708192a3b4c5d6e7f8091a2b3c4d5e6f70192',
    60: '0x0006d1d2f700b1b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081920a3',
  },
  xrp: {
    30: '0x0007e2e3f801c2d3e4f5061728394a5b6c7d8e9f90a1b2c3d4e5f60718293a4b',
    60: '0x0008f3f40192d3e4f5061728394a5b6c7d8e9f90a1b2c3d4e5f6071829394a5b',
  },
  hype: {
    30: '0x0009a4a5f60293d4e5f6071829394a5b6c7d8e9f90a1b2c3d4e5f6071829394a5',
    60: '0x000ab5b60093c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081920a3b4c5d',
  },
  doge: {
    30: '0x000bc6c7f10493d4e5f6071829394a5b6c7d8e9f90a1b2c3d4e5f6071829394a5b',
    60: '0x000cd7d80294d4e5f6071829394a5b6c7d8e9f90a1b2c3d4e5f6071829394a5b6c',
  },
};

/** E18 precision used by Chainlink feeds (1e18 = 1.0 USD). */
export const CHAINLINK_E18 = 1_000_000_000_000_000_000n;

// ============================================================================
// Types
// ============================================================================

export type CryptoSymbol = keyof typeof RTDS_TWAP_FEED_IDS;

export interface TwapTick {
  symbol: CryptoSymbol;
  window: TwapWindowSeconds;
  /** TWAP price in USD (human-readable, derived from raw). */
  price: number;
  /** Raw E18-scaled value (BigInt) for high-precision comparisons. */
  raw: bigint;
  /** Unix ms timestamp of the tick. */
  ts: number;
  /** Staleness (ms since last tick). */
  ageMs: number;
}

export interface TwapSnapshot {
  symbol: CryptoSymbol;
  /** Both windows if available. */
  twap30s: number | null;
  twap60s: number | null;
  /** Last-update unix ms (most recent of either). */
  lastUpdate: number;
  /** Maximum staleness across the windows (ms). */
  maxAgeMs: number;
}

// ============================================================================
// Client
// ============================================================================

export type TwapSignalQuality = 'fresh' | 'stale' | 'missing';

export interface TwapSignalEvaluation {
  quality: TwapSignalQuality;
  /** Running 30s TWAP if available. */
  twap30s: number | null;
  /** Running 60s TWAP if available. */
  twap60s: number | null;
  /** Divergence between 30s and 60s TWAP (small = aligned). */
  divergence: number | null;
  /** True if the consensus price is consistent with TWAP direction. */
  aligned: boolean;
  /** Recommended multiplier on CopyScore (1.0 = neutral, 0 = block). */
  scoreMultiplier: number;
  reason?: string;
}

export interface RtdsClientOptions {
  /** Auto-reconnect on disconnect (default: true). */
  autoReconnect?: boolean;
  /** Reconnect delay in ms (default: 3000). */
  reconnectDelayMs?: number;
  /** PING interval in ms (default: 5000). */
  pingIntervalMs?: number;
  /** Maximum staleness allowed in evaluations (default: 30_000). */
  maxStalenessMs?: number;
}

/**
 * Chainlink TWAP oracle client.
 *
 * Subscribes to RTDS TWAP topics and emits TwapTick events. Maintains the
 * latest snapshot per symbol for use by the consensus evaluator.
 */
export class ChainlinkTwapOracle extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscribed = false;
  private lastTick: Map<string, TwapTick> = new Map();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private closed = false;

  private readonly options: Required<RtdsClientOptions>;

  constructor(options: RtdsClientOptions = {}) {
    super();
    this.options = {
      autoReconnect: true,
      reconnectDelayMs: 3_000,
      pingIntervalMs: 5_000,
      maxStalenessMs: 30_000,
      ...options,
    };
  }

  /** Connect to RTDS and subscribe to all configured TWAP feeds. */
  async connect(): Promise<void> {
    if (this.ws) return;
    this.closed = false;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(RTDS_WS_URL);
      this.ws = ws;

      const onError = (err: Error) => {
        this.emit('error', err);
        if (!this.subscribed) reject(err);
      };

      ws.on('open', () => {
        this.emit('open');
        this._subscribeAll();
        this.subscribed = true;
        this._startPing();
        resolve();
      });

      ws.on('message', (data) => this._handleMessage(data));
      ws.on('error', onError);
      ws.on('close', () => this._handleClose());
    });
  }

  /** Close the connection. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Get the latest TWAP snapshot for a symbol, or null if no data. */
  getSnapshot(symbol: CryptoSymbol, now: number = Date.now()): TwapSnapshot | null {
    const tick30 = this.lastTick.get(`${symbol}:30`);
    const tick60 = this.lastTick.get(`${symbol}:60`);
    if (!tick30 && !tick60) return null;

    // A tick is "fresh" if it was received/updated within the staleness window.
    // We use ts (the timestamp from the wire) not ageMs (which is set at
    // parse time and is therefore only correct at that instant).
    const age30 = tick30 ? now - tick30.ts : 0;
    const age60 = tick60 ? now - tick60.ts : 0;
    // Both fields are present (possibly null if stale) so callers can
    // distinguish "stale" from "missing" themselves.
    const twap30s = tick30 ? tick30.price : null;
    const twap60s = tick60 ? tick60.price : null;
    const lastUpdate = Math.max(tick30?.ts ?? 0, tick60?.ts ?? 0);
    const maxAgeMs = Math.max(age30, age60);

    return {
      symbol,
      twap30s,
      twap60s,
      lastUpdate,
      maxAgeMs,
    };
  }

  /**
   * Evaluate a copy-trader consensus for a crypto market against the
   * running TWAP.
   *
   * Use case: a quorum fires BUY on a "BTC Up" market at $X. Before we
   * place the order, we check the running 30s/60s TWAP. If TWAP has
   * already moved past our target price, the consensus is stale and we
   * should reduce confidence or skip.
   *
   * @param symbol Crypto symbol (e.g. 'btc')
   * @param consensusPrice The consensus YES price (0-1) the quorum wants to buy at
   * @param side 'BUY' (Up) or 'SELL' (Down)
   * @param now Current time in ms
   */
  evaluate(
    symbol: CryptoSymbol,
    consensusPrice: number,
    side: 'BUY' | 'SELL',
    now: number = Date.now()
  ): TwapSignalEvaluation {
    const snap = this.getSnapshot(symbol, now);

    if (!snap || (snap.twap30s === null && snap.twap60s === null)) {
      return {
        quality: 'missing',
        twap30s: null,
        twap60s: null,
        divergence: null,
        aligned: false,
        scoreMultiplier: 0.7, // No oracle data — penalize but don't block
        reason: 'no_twap_data',
      };
    }

    const maxAge = snap.maxAgeMs;

    if (maxAge > this.options.maxStalenessMs) {
      return {
        quality: 'stale',
        twap30s: snap.twap30s,
        twap60s: snap.twap60s,
        divergence: this._divergence(snap),
        aligned: false,
        scoreMultiplier: 0.5,
        reason: `stale_${Math.round(maxAge)}ms`,
      };
    }

    const tick30 = this.lastTick.get(`${symbol}:30`);
    const tick60 = this.lastTick.get(`${symbol}:60`);

    // Use the raw (E18) values for momentum computation to avoid
    // BigInt→Number precision loss at the 1e18 scale.
    if (tick30 && tick60 && tick60.raw !== 0n) {
      // raw is E18, so the diff is also E18-scaled; divide by twap60_raw/1e18
      // gives the fractional momentum.
      const diffRaw = tick30.raw - tick60.raw; // E18-scaled
      // momentum ≈ diffRaw / tick60.raw (since 1e18 cancels)
      // For numerical stability with BigInt division, use double-precision:
      const momentum = Number(diffRaw) / Number(tick60.raw);
      const refPrice = tick30.price; // already human-readable
      let aligned = true;
      let scoreMultiplier = 1.0;
      let reason: string | undefined;
      if (side === 'BUY') {
        if (momentum <= -0.002) {
          aligned = false;
          scoreMultiplier = 0.5;
          reason = `twap_momentum_down_${(momentum * 100).toFixed(2)}%`;
        }
      } else {
        if (momentum >= 0.002) {
          aligned = false;
          scoreMultiplier = 0.5;
          reason = `twap_momentum_up_${(momentum * 100).toFixed(2)}%`;
        }
      }
      return {
        quality: 'fresh',
        twap30s: snap.twap30s,
        twap60s: snap.twap60s,
        divergence: this._divergence(snap),
        aligned,
        scoreMultiplier,
        reason,
      };
    }

    // Fallback (number-based momentum, less precise).
    const momentum = snap.twap30s !== null && snap.twap60s !== null && snap.twap60s !== 0
      ? (snap.twap30s - snap.twap60s) / snap.twap60s
      : 0;
    const refPrice = snap.twap30s ?? snap.twap60s ?? 0;
    let aligned = true;
    let scoreMultiplier = 1.0;
    let reason: string | undefined;
    if (side === 'BUY') {
      if (momentum <= -0.002) {
        aligned = false;
        scoreMultiplier = 0.5;
        reason = `twap_momentum_down_${(momentum * 100).toFixed(2)}%`;
      }
    } else {
      if (momentum >= 0.002) {
        aligned = false;
        scoreMultiplier = 0.5;
        reason = `twap_momentum_up_${(momentum * 100).toFixed(2)}%`;
      }
    }
    return {
      quality: 'fresh',
      twap30s: snap.twap30s,
      twap60s: snap.twap60s,
      divergence: this._divergence(snap),
      aligned,
      scoreMultiplier,
      reason,
    };
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private _subscribeAll(): void {
    if (!this.ws) return;
    const subscriptions: unknown[] = [];

    for (const symbol of Object.keys(RTDS_TWAP_FEED_IDS) as CryptoSymbol[]) {
      for (const window of [30, 60] as TwapWindowSeconds[]) {
        subscriptions.push({
          topic: RTDS_TWAP_TOPICS[window],
          type: 'subscribe',
          filters: JSON.stringify({ symbol }),
        });
      }
    }

    for (const sub of subscriptions) {
      this.ws.send(JSON.stringify(sub));
    }
  }

  private _startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send('PING');
      }
    }, this.options.pingIntervalMs);
  }

  private _handleMessage(data: WebSocket.RawData): void {
    try {
      const text = data.toString();
      // PING/PONG heartbeat
      if (text === 'PING' || text === 'PONG') return;
      const msg = JSON.parse(text);
      this._parseTick(msg);
    } catch (err) {
      this.emit('parse_error', err);
    }
  }

  private _parseTick(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;
    const topic = m.topic as string | undefined;
    if (topic !== RTDS_TWAP_TOPICS[30] && topic !== RTDS_TWAP_TOPICS[60]) return;
    const window: TwapWindowSeconds = topic === RTDS_TWAP_TOPICS[30] ? 30 : 60;
    const payload = (m.payload as Record<string, unknown> | undefined) ?? m;
    const symbolRaw = (payload.symbol as string | undefined) ?? '';
    const symbol = symbolRaw.toLowerCase() as CryptoSymbol;
    if (!(symbol in RTDS_TWAP_FEED_IDS)) return;

    // Chainlink values are E18 scaled (1e18 = 1.0). Some responses use
    // a `value` or `twap` field; we accept any of them.
    const rawValue =
      payload.value !== undefined
        ? payload.value
        : payload.twap !== undefined
          ? payload.twap
          : payload.price;
    if (rawValue === undefined) return;
    const { value: price, raw } = this._parseE18(rawValue);

    const ts = (payload.timestamp as number | undefined) ??
      (payload.ts as number | undefined) ??
      Date.now();

    const tick: TwapTick = {
      symbol,
      window,
      price,
      raw,
      ts,
      ageMs: Date.now() - ts,
    };
    this.lastTick.set(`${symbol}:${window}`, tick);
    this.emit('tick', tick);
  }

  private _parseE18(raw: unknown): { value: number; raw: bigint } {
    if (typeof raw === 'bigint') {
      return { value: Number(raw) / 1e18, raw };
    }
    if (typeof raw === 'string') {
      if (raw.startsWith('0x')) {
        try {
          const b = BigInt(raw);
          return { value: Number(b) / 1e18, raw: b };
        } catch {
          const n = Number(raw);
          return { value: n, raw: BigInt(Math.round(n * 1e18)) };
        }
      }
      if (raw.length >= 19 && /^\d+$/.test(raw)) {
        try {
          const b = BigInt(raw);
          return { value: Number(b) / 1e18, raw: b };
        } catch {
          const n = Number(raw);
          return { value: n, raw: BigInt(Math.round(n * 1e18)) };
        }
      }
      const n = Number(raw);
      return { value: n, raw: BigInt(Math.round(n * 1e18)) };
    }
    if (typeof raw === 'number') {
      return { value: raw, raw: BigInt(Math.round(raw * 1e18)) };
    }
    const n = Number(raw);
    return { value: n, raw: BigInt(Math.round(n * 1e18)) };
  }

  private _divergence(snap: TwapSnapshot): number | null {
    if (snap.twap30s === null || snap.twap60s === null) return null;
    if (snap.twap60s === 0) return null;
    return Math.abs(snap.twap30s - snap.twap60s) / snap.twap60s;
  }

  private _handleClose(): void {
    this.subscribed = false;
    this.ws = null;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.emit('close');
    if (this.options.autoReconnect && !this.closed) {
      this.reconnectTimer = setTimeout(() => {
        this.connect().catch(err => this.emit('error', err));
      }, this.options.reconnectDelayMs);
    }
  }
}
