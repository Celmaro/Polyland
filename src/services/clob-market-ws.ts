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
  bids: [string, string][];  // [price, size]
  asks: [string, string][];
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
  private connectPending = false;

  /** Book mid price per asset (best bid + best ask) / 2 */
  private bookMids = new Map<string, number>();

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

  private static readonly MAX_SUBSCRIBED_ASSETS = 20;
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

  private handleBookUpdate(b: ClobBookUpdate): void {
    const { asset_id, bids, asks } = b;
    if (!bids?.length || !asks?.length) return;
    const bestBid = parseFloat(bids[0][0]);
    const bestAsk = parseFloat(asks[0][0]);
    if (isNaN(bestBid) || isNaN(bestAsk)) return;
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
