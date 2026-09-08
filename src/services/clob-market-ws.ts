/**
 * ClobMarketWsService
 *
 * Lightweight WebSocket client for the official Polymarket CLOB market channel.
 * Replacement for the dead `clob_market` topic on RTDS (wss://ws-live-data.polymarket.com).
 *
 * Protocol: wss://ws-subscriptions-clob.polymarket.com/ws/market
 * Docs:    https://docs.polymarket.com
 *
 * Supports: book_update, price_change, last_trade_price, tick_size_change
 *
 * Also serves as the mid-price feed for the anti-sniper guard: on each
 * price_change or last_trade_price, calls onMid(price) so the guard
 * accumulates real mid observations and stops blocking with
 * `no_mid_observations` / `mid_unstable`.
 */

import WebSocket from 'isomorphic-ws';
import { sanitizeErrorMessage } from '../core/errors.js';

// ============================================================================
// Types
// ============================================================================

export interface ClobMidObservation {
  assetId: string;
  price: number;
  timestamp: number;
}

export type MidObserver = (obs: ClobMidObservation) => void;

export type BookInvalidationReason = 'sequence_gap' | 'missing_sequence' | 'malformed_sequence';
export interface ClobResyncRequest { assetId: string; reason: BookInvalidationReason; expected?: number; received?: number; }
export type ResyncObserver = (request: ClobResyncRequest) => void;
export interface ClobWsIntegrityState {
  sequenceGaps: number;
  resyncs: number;
  invalidBooks: number;
  /** unix ms of the last non-PONG data message (0 = none yet). */
  lastDataMessageAt: number;
  /** Bytes buffered in the WS socket (0 when not connected). */
  bufferedAmount: number;
  /** True when bufferedAmount >= backpressureBytes threshold. */
  backpressure: boolean;
}
export interface ClobMarketWsOptions {
  /** Bytes at which the socket is considered backpressured. Default 256 KiB. */
  backpressureBytes?: number;
  /** Called when the book for an asset must be re-fetched (P0 sequencing). */
  onResync?: ResyncObserver;
  /** Compatibility: allow book updates with no sequence field (P0, default false). */
  allowUnsequencedBooks?: boolean;
}

interface ClobInitialMessage {
  assets_ids: string[];
  type: 'market';
  /**
   * Note: setting custom_feature_enabled: true triggers full book_snapshot
   * delivery on subscribe (one per asset, hundreds of bytes each).
   * For 20+ assets the server floods the buffer → 1013 slow-consumer.
   * Default (no custom_feature_enabled) gives price_change and
   * last_trade_price only, which is all the anti-sniper guard needs.
   */
  custom_feature_enabled?: false;
}

interface ClobSubscribeMessage {
  assets_ids: string[];
  operation: 'subscribe' | 'unsubscribe';
  custom_feature_enabled?: false;
}

interface ClobBookUpdate {
  asset_id: string;
  sequence?: unknown;
  seq?: unknown;
  // The CLOB has emitted both tuple levels and object levels across message
  // versions: [price, size] or { price, size }.
  bids?: Array<[string, string] | { price: string; size: string }>;
  asks?: Array<[string, string] | { price: string; size: string }>;
}

interface ClobPriceChange {
  asset_id: string;
  price: string;
}

interface ClobLastTrade {
  asset_id: string;
  price: string;
  size: string;
}

type ClobMessageType =
  | 'book'
  | 'book_update'
  | 'price_change'
  | 'last_trade_price'
  | 'tick_size_change'
  | 'best_bid_ask'
  | 'new_market'
  | 'market_resolved'
  | 'subscribed'
  | 'unsubscribed'
  | 'error';

interface ClobMessage {
  event_type?: ClobMessageType;
  type?: ClobMessageType;
  [key: string]: unknown;
}

// ============================================================================
// Service
// ============================================================================

export class ClobMarketWsService {
  private ws: WebSocket | null = null;
  private readonly url = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
  private subscribedAssets = new Set<string>();
  private midObservers = new Set<MidObserver>();
  private reconnectDelayMs = 1_000;
  private maxReconnectDelayMs = 30_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private intentionallyClosed = false;
  private destroyed = false;
  private pingPongSeenAt = 0;
  /** Timestamp of the last non-PONG (data) message — L12b silent-feed guard. */
  private lastDataMessageAt = 0;
  private connectPending = false;

  private readonly options: ClobMarketWsOptions;
  /** Sequence-integrity counters (P1 observability; incremented by P0 checks). */
  private sequenceGaps = 0;
  private resyncs = 0;
  private invalidBooks = 0;
  /** Last seen sequence per asset (P0-6 gap detection). */
  private sequenceByAsset = new Map<string, number>();
  /** Assets whose feed has EVER carried a sequence (feeds without it are never false-invalidated). */
  private sequencedAssets = new Set<string>();
  /** Overridable buffered amount for tests; fallback reads the live socket. */
  private bufferedAmountBytes = 0;

  constructor(options: ClobMarketWsOptions = {}) {
    this.options = options;
  }

  /** Clear an asset's book state and request a fresh snapshot (P0-6). */
  invalidateBook(assetId: string, reason: BookInvalidationReason, expected?: number, received?: number): void {
    this.bookLevels.delete(assetId);
    this.bookMids.delete(assetId);
    this.sequenceByAsset.delete(assetId);
    this.invalidBooks = Math.min(Number.MAX_SAFE_INTEGER, this.invalidBooks + 1);
    this.resyncs = Math.min(Number.MAX_SAFE_INTEGER, this.resyncs + 1);
    try { this.options.onResync?.({ assetId, reason, expected, received }); }
    catch (err) { console.error('[ClobMarketWs] resync observer error', err); }
  }

  /**
   * Bounded, read-only telemetry snapshot for orchestrator health checks.
   * Never throws; returns zeroed state when not connected.
   */
  getIntegrityState(): ClobWsIntegrityState {
    const buffered = this.ws && typeof (this.ws as WebSocket & { bufferedAmount?: number }).bufferedAmount === 'number'
      ? (this.ws as WebSocket & { bufferedAmount?: number }).bufferedAmount!
      : this.bufferedAmountBytes;
    const threshold = this.options.backpressureBytes ?? 256 * 1024;
    return {
      sequenceGaps: this.sequenceGaps,
      resyncs: this.resyncs,
      invalidBooks: this.invalidBooks,
      lastDataMessageAt: this.lastDataMessageAt,
      bufferedAmount: Math.max(0, buffered),
      backpressure: buffered >= threshold,
    };
  }

  /** Book mid price per asset (best bid + best ask) / 2 */
  private bookMids = new Map<string, number>();
  /** Cumulative book levels; book_update messages may contain deltas, not full books. */
  private bookLevels = new Map<string, { bids: Map<number, number>; asks: Map<number, number> }>();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Register a mid-price observer. Called on every price_change / last_trade
   * with the current best mid for that asset.
   */
  onMid(observer: MidObserver): () => void {
    this.midObservers.add(observer);
    return () => this.midObservers.delete(observer);
  }

  // 50 slots: the 09-07 audit showed 20 churned too fast once every aligned
  // market requests a mid (eviction wiped fresh mids mid-fire). Watch the
  // code-1006 disconnect rate after raising — slow-consumer disconnects were
  // the historical reason for the cap. If 1006s spike, fall back to 30.
  private static readonly MAX_SUBSCRIBED_ASSETS = 50;
  private static readonly SUBSCRIBE_BATCH_SIZE = 5;
  private static readonly SUBSCRIBE_BATCH_DELAY_MS = 100;

  /**
   * Subscribe to one or more asset IDs. Idempotent — safe to call repeatedly.
   * Triggers the initial WS connection if not yet started.
   * Caps total subscriptions at MAX_SUBSCRIBED_ASSETS; evicts oldest when exceeded.
   */
  subscribe(assetIds: string[]): void {
    const newIds = assetIds.filter((id) => !this.subscribedAssets.has(id));
    if (newIds.length === 0) return;

    // Evict oldest subscriptions if we'd exceed the cap
    const maxAssets = ClobMarketWsService.MAX_SUBSCRIBED_ASSETS;
    while (this.subscribedAssets.size + newIds.length > maxAssets) {
      const oldest = this.subscribedAssets.values().next().value;
      if (!oldest) break;
      this.subscribedAssets.delete(oldest);
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendUnsubscribe([oldest]);
      }
    }

    newIds.forEach((id) => this.subscribedAssets.add(id));

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(newIds);
    } else if (!this.ws && !this.connectPending) {
      // First asset added — kick off the connection now.
      this.connect();
    }
    // If ws is mid-connect, the onopen handler will subscribe to subscribedAssets.
  }

  /**
   * Unsubscribe from asset IDs.
   */
  unsubscribe(assetIds: string[]): void {
    assetIds.forEach((id) => this.subscribedAssets.delete(id));
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendUnsubscribe(assetIds);
    }
  }

  /** Start the WebSocket. Idempotent. */
  start(): void {
    if (this.destroyed) throw new Error('ClobMarketWsService destroyed');
    if (this.ws) return;
    this.intentionallyClosed = false;
    this.connect();
  }

  /** Stop and destroy the service. */
  stop(): void {
    this.destroyed = true;
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'service stop');
      this.ws = null;
    }
    this.bookMids.clear();
    this.subscribedAssets.clear();
    this.midObservers.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private connect(): void {
    if (this.destroyed) return;
    // Defer connect until we have at least one asset to subscribe to.
    // Sending an empty assets_ids list with custom_feature_enabled: true
    // makes the server push every market's book snapshot + price_change —
    // an immediate slow-consumer disconnect.
    if (this.subscribedAssets.size === 0) {
      this.connectPending = true;
      return;
    }
    this.connectPending = false;
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.reconnectDelayMs = 1_000;
      // Initial subscription message (type: market).
      // Only send if we have assets; an empty list with custom_feature_enabled
      // would make the server push every market's snapshot — slow consumer disconnect.
      // Batch in groups of SUBSCRIBE_BATCH_SIZE with SUBSCRIBE_BATCH_DELAY_MS between
      // groups to avoid flooding the server with a 50-asset subscribe that triggers
      // 50 simultaneous book snapshots.
      const assets = [...this.subscribedAssets];
      if (assets.length > 0) {
        const batchSize = ClobMarketWsService.SUBSCRIBE_BATCH_SIZE;
        for (let i = 0; i < assets.length; i += batchSize) {
          const batch = assets.slice(i, i + batchSize);
          if (i === 0) {
            // First batch: include type: market to establish channel
            const initial: ClobInitialMessage = {
              assets_ids: batch,
              type: 'market',
            };
            this.send(initial);
          } else {
            const followup: ClobSubscribeMessage = {
              assets_ids: batch,
              operation: 'subscribe',
            };
            this.send(followup);
          }
        }
      }

      // Heartbeat: server replies "PONG" to a plain-text "PING".
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
            // L12: dead-feed detection (qualiaenjoyer/polymarket-apis pattern).
            // TCP can stay open while the server stops streaming data (half-open
            // proxy, stuck upstream). PONG replies are our liveness signal: if
            // none seen for 3 consecutive ping intervals (30s), force-close so
            // the normal reconnect ladder takes over.
            if (this.pingPongSeenAt > 0 && Date.now() - this.pingPongSeenAt > 30_000) {
              console.warn('[ClobMarketWs] no PONG for 30s — force-closing dead feed');
              this.pingPongSeenAt = Date.now(); // reset so we only fire once per window
              try { this.ws.close(4000, 'stale'); } catch { /* already closing */ }
              return;
            }
            // L12b: silent-but-alive detection (prod-observed failure mode,
            // 2026-09-07 audit: WS answered PONGs for ~1h while delivering ZERO
            // data events — PONG liveness alone kept a data-dead connection
            // alive and the funnel starved: received=143236, recorded=1859,
            // then frozen for 60+ min with no error logged). If we hold
            // subscriptions and no data message has arrived for 5 minutes,
            // treat the feed as dead and force a reconnect (PONGs will resume
            // on the fresh connection, but the data channel is also new).
            if (
              this.subscribedAssets.size > 0 &&
              Date.now() - this.lastDataMessageAt > 5 * 60_000
            ) {
              console.warn(
                `[ClobMarketWs] no data events for 5min across ${this.subscribedAssets.size} subscribed assets — ` +
                'force-closing silent feed (PONGs alive, data channel dead)'
              );
              this.lastDataMessageAt = Date.now(); // only fire once per window
              try { this.ws.close(4000, 'silent'); } catch { /* already closing */ }
              return;
            }
            this.ws.send('PING');
          }
        }, 10_000);
    };

    this.ws.onmessage = (event: WebSocket.MessageEvent) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : (event.data as Buffer).toString();
        // Heartbeat: plain-text "PONG" response.
        if (raw === 'PONG') {
          this.pingPongSeenAt = Date.now();
          return;
        }
        // Any other message = real data (price_change/trade/book/etc).
        this.lastDataMessageAt = Date.now();
        const data = JSON.parse(raw);
        this.handleMessage(data as ClobMessage);
      } catch (err) {
        // Don't log raw event objects — sanitize message only
        const msg = err instanceof Error ? sanitizeErrorMessage(err.message) : String(err);
        console.error(`[ClobMarketWs] parse error: ${msg}`);
      }
    };

    this.ws.onerror = (event: WebSocket.ErrorEvent) => {
      // Log sanitized message only — never dump the raw event
      const msg = sanitizeErrorMessage(
        typeof event.message === 'string' ? event.message : JSON.stringify(event.message ?? 'ws error')
      );
      console.warn(`[ClobMarketWs] ws error: ${msg}`);
    };

    this.ws.onclose = (event: WebSocket.CloseEvent) => {
      const code = event.code ?? 0;
      const reason = sanitizeErrorMessage(event.reason ?? '');
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (!this.intentionallyClosed && !this.destroyed) {
        console.warn(`[ClobMarketWs] disconnected code=${code} reason=${reason || 'unknown'} — reconnecting in ${this.reconnectDelayMs}ms`);
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.intentionallyClosed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.destroyed && !this.intentionallyClosed) {
        this.ws = null;  // force new connection
        this.connect();
        // NOTE: onopen already re-sends the initial subscription for all
        // subscribedAssets — no resubscribe needed here (double-subscribe
        // would trigger slow-consumer disconnects).
      }
    }, this.reconnectDelayMs);
    // Full jitter backoff
    this.reconnectDelayMs = Math.min(
      this.maxReconnectDelayMs,
      this.reconnectDelayMs * 2 + Math.random() * this.reconnectDelayMs
    );
  }

  private sendSubscribe(assetIds: string[]): void {
    const msg: ClobSubscribeMessage = {
      assets_ids: assetIds,
      operation: 'subscribe',
    };
    this.send(msg);
  }

  private sendUnsubscribe(assetIds: string[]): void {
    const msg: ClobSubscribeMessage = {
      assets_ids: assetIds,
      operation: 'unsubscribe',
    };
    this.send(msg);
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(msg: ClobMessage): void {
    // Polymarket CLOB WS uses `event_type` for the message kind.
    const eventType = (msg.event_type ?? msg.type) as ClobMessageType | undefined;
    switch (eventType) {
      case 'book':
      case 'book_update': {
        const b = msg as unknown as { asset_id: string } & ClobBookUpdate;
        this.handleBookUpdate(b);
        break;
      }
      case 'price_change': {
        // price_change delivers an array of asset_id+price pairs
        const p = msg as unknown as {
          price_changes?: Array<{ asset_id: string; price: string }>;
          asset_id?: string;
          price?: string;
        };
        if (Array.isArray(p.price_changes)) {
          for (const change of p.price_changes) {
            this.handlePriceChange({
              asset_id: change.asset_id,
              price: change.price,
            });
          }
        } else if (p.asset_id && p.price !== undefined) {
          this.handlePriceChange({ asset_id: p.asset_id, price: p.price });
        }
        break;
      }
      case 'last_trade_price': {
        const t = msg as unknown as { asset_id?: string } & ClobLastTrade;
        if (t.asset_id) {
          this.handleLastTrade(t);
        }
        break;
      }
      case 'best_bid_ask': {
        const bba = msg as unknown as {
          asset_id?: string;
          best_bid?: string;
          best_ask?: string;
        };
        if (bba.asset_id && bba.best_bid && bba.best_ask) {
          const bid = parseFloat(bba.best_bid);
          const ask = parseFloat(bba.best_ask);
          if (!isNaN(bid) && !isNaN(ask)) {
            this.bookMids.set(bba.asset_id, (bid + ask) / 2);
            this.emitMid({
              assetId: bba.asset_id,
              price: (bid + ask) / 2,
              timestamp: Date.now(),
            });
          }
        }
        break;
      }
      case 'tick_size_change':
        // Currently unused by anti-sniper; no action needed
        break;
      case 'new_market':
        // Lifecycle event — not needed for mid feed
        break;
      case 'market_resolved':
        // Resolution handled by Gamma poller; this is a notification only
        break;
      case 'subscribed':
      case 'unsubscribed':
        // Acknowledged — no action needed
        break;
      case 'error': {
        const errMsg = sanitizeErrorMessage(String(msg.message ?? msg.error ?? 'clob ws error'));
        console.warn(`[ClobMarketWs] server error: ${errMsg}`);
        break;
      }
    }
  }

  handleBookUpdate(b: ClobBookUpdate): void {
    const { asset_id, bids, asks } = b;
    // ---- P0-6 sequence-gap detection (safe semantics) ----
    const rawSequence = b.sequence ?? b.seq;
    let sequence: number | null = null;
    if (typeof rawSequence === 'number' && Number.isSafeInteger(rawSequence) && rawSequence >= 0) {
      sequence = rawSequence;
    } else if (typeof rawSequence === 'string' && /^\d+$/.test(rawSequence)) {
      sequence = Number(rawSequence);
    }
    if (sequence !== null) {
      this.sequencedAssets.add(asset_id);
      const previous = this.sequenceByAsset.get(asset_id);
      let invalidated = false;
      if (previous !== undefined && sequence !== previous + 1) {
        this.sequenceGaps = Math.min(Number.MAX_SAFE_INTEGER, this.sequenceGaps + 1);
        this.invalidateBook(asset_id, 'sequence_gap', previous + 1, sequence);
        invalidated = true;
      }
      // Do NOT re-seed the baseline from a gapped message: the book was
      // invalidated and the next valid update must re-establish it.
      if (!invalidated) this.sequenceByAsset.set(asset_id, sequence);
    } else if (this.sequencedAssets.has(asset_id)) {
      // This asset previously carried sequences; a missing/malformed one is a
      // feed-integrity break -> invalidate conservatively.
      this.invalidateBook(asset_id, rawSequence === undefined ? 'missing_sequence' : 'malformed_sequence');
    }
    const levels = this.bookLevels.get(asset_id) ?? { bids: new Map<number, number>(), asks: new Map<number, number>() };
    this.bookLevels.set(asset_id, levels);
    const applyLevels = (
      incoming: Array<[string, string] | { price: string; size: string }> | undefined,
      target: Map<number, number>,
    ): void => {
      if (!Array.isArray(incoming)) return;
      for (const level of incoming) {
        const priceText = Array.isArray(level) ? level[0] : level?.price;
        const sizeText = Array.isArray(level) ? level[1] : level?.size;
        const price = Number(priceText); const size = Number(sizeText);
        if (!Number.isFinite(price) || price <= 0) continue;
        if (!Number.isFinite(size) || size <= 0) target.delete(price); else target.set(price, size);
      }
    };
    applyLevels(bids, levels.bids);
    applyLevels(asks, levels.asks);
    const bestBid = Math.max(...levels.bids.keys());
    const askPrices = [...levels.asks.keys()];
    const bestAsk = askPrices.length ? Math.min(...askPrices) : NaN;
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return;
    const mid = (bestBid + bestAsk) / 2;
    this.bookMids.set(asset_id, mid);
    this.emitMid({ assetId: asset_id, price: mid, timestamp: Date.now() });
  }

  private handlePriceChange(p: ClobPriceChange): void {
    const price = parseFloat(p.price);
    if (isNaN(price)) return;
    // Use last known book mid if available, otherwise use the price as-is
    const mid = this.bookMids.get(p.asset_id) ?? price;
    this.emitMid({ assetId: p.asset_id, price: mid, timestamp: Date.now() });
  }

  private handleLastTrade(t: ClobLastTrade): void {
    const price = parseFloat(t.price);
    if (isNaN(price)) return;
    // Use last known book mid if available
    const mid = this.bookMids.get(t.asset_id) ?? price;
    this.emitMid({ assetId: t.asset_id, price: mid, timestamp: Date.now() });
  }

  private emitMid(obs: ClobMidObservation): void {
    for (const observer of this.midObservers) {
      try {
        observer(obs);
      } catch (err) {
        // Don't let one observer crash the emitter
        const msg = err instanceof Error ? sanitizeErrorMessage(err.message) : String(err);
        console.error(`[ClobMarketWs] onMid observer error: ${msg}`);
      }
    }
  }
}
