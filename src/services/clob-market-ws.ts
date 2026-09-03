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
import { withRetry } from '../core/errors.js';

// ============================================================================
// Types
// ============================================================================

export interface ClobMidObservation {
  assetId: string;
  price: number;
  timestamp: number;
}

export type MidObserver = (obs: ClobMidObservation) => void;

interface ClobSubscriptionMessage {
  action: 'subscribe' | 'unsubscribe';
  assets_ids: string[];
  type: 'market';
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
  | 'book_update'
  | 'price_change'
  | 'last_trade_price'
  | 'tick_size_change'
  | 'subscribed'
  | 'unsubscribed'
  | 'error';

interface ClobMessage {
  type: ClobMessageType;
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
  private intentionallyClosed = false;
  private destroyed = false;

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

  /**
   * Subscribe to one or more asset IDs. Idempotent — safe to call repeatedly.
   */
  subscribe(assetIds: string[]): void {
    const newIds = assetIds.filter((id) => !this.subscribedAssets.has(id));
    if (newIds.length === 0) return;
    newIds.forEach((id) => this.subscribedAssets.add(id));

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(newIds);
    }
    // If not yet connected, the subscription will be sent on open.
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
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.reconnectDelayMs = 1_000;
      // Re-subscribe all assets on reconnect
      if (this.subscribedAssets.size > 0) {
        this.sendSubscribe([...this.subscribedAssets]);
      }
    };

    this.ws.onmessage = (event: WebSocket.MessageEvent) => {
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
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
    this.send({ action: 'subscribe', assets_ids: assetIds, type: 'market' });
  }

  private sendUnsubscribe(assetIds: string[]): void {
    this.send({ action: 'unsubscribe', assets_ids: assetIds, type: 'market' });
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(msg: ClobMessage): void {
    switch (msg.type) {
      case 'book_update': {
        const b = msg as unknown as { type: 'book_update' } & ClobBookUpdate;
        this.handleBookUpdate(b);
        break;
      }
      case 'price_change': {
        const p = msg as unknown as { type: 'price_change' } & ClobPriceChange;
        this.handlePriceChange(p);
        break;
      }
      case 'last_trade_price': {
        const t = msg as unknown as { type: 'last_trade_price' } & ClobLastTrade;
        this.handleLastTrade(t);
        break;
      }
      case 'tick_size_change':
        // Currently unused by anti-sniper; no action needed
        break;
      case 'subscribed':
        // Acknowledged — no action needed
        break;
      case 'unsubscribed':
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
