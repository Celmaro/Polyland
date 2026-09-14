/**
 * RestingOrderBook — the fired=0 fix.
 *
 * Problem (verified in prod logs 09-12): every fire re-queries the book and
 * finds bestAsk=0.990 — the leader's trade consumed the executable asks, so a
 * market-order simulation can never fill. `fired=0` is correct for a market
 * order, but wrong strategy: the leader's own fill at ~0.60 proves asks DO
 * return into the band.
 *
 * Fix: when the fire's market-order sim cannot fill, REST a limit order at the
 * consensus ceiling. A periodic refill pass fills it when the book's best ask
 * returns to or below the ceiling — real fills at the leader's price band,
 * same direction. Dry-run simulates exactly like the shared fill engine.
 */
export interface RestingOrder {
  id: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  ceiling: number;
  size: number;
  placedAt: number;
  ttlMs: number;
  signalId?: string;
  /** Shares already filled (partial fills). Present on open/closed entries. */
  filledShares?: number;
  /** Lifecycle status. Present on restored/queried entries. */
  status?: 'open' | 'filled' | 'expired';
  /** Audit metadata captured at placement (marketSlug/basket/category/wallets/winRate). */
  metadata?: {
    marketSlug: string;
    basketName: string;
    category: string;
    wallets: string[];
    winRate: number;
    signalId: string;
  };
}

export interface BookLevel { price: number; size: number; }

export interface RefillBook {
  tokenId: string;
  asks: BookLevel[];
  bids: BookLevel[];
}

export interface RestingFill {
  orderId: string;
  tokenId: string;
  price: number;
  shares: number;
  at: number;
}

type OrderStatus = 'open' | 'filled' | 'expired';
type OrderEntry = RestingOrder & { status: OrderStatus; filledShares: number };

export class RestingOrderBook {
  private orders = new Map<string, OrderEntry>();

  place(order: RestingOrder): boolean {
    const id = order.id;
    if (this.orders.has(id)) return false; // idempotent: duplicate placement no-op
    this.orders.set(id, { ...order, status: 'open', filledShares: 0 });
    return true;
  }

  openOrders(): RestingOrder[] {
    return [...this.orders.values()]
      .filter((o) => o.status === 'open')
      .map((o) => ({ ...o }));
  }

  closedOrders(): RestingOrder[] {
    return [...this.orders.values()]
      .filter((o) => o.status === 'filled')
      .map((o) => ({ ...o }));
  }

  expiredCount(): number {
    return [...this.orders.values()].filter((o) => o.status === 'expired').length;
  }

  /**
   * Close an order as FILLED at a given matched share count (or the full size
   * when unspecified). Used by LIVE reconciliation to absorb a venue-confirmed
   * fill/partial fill that the simulated refill pass may not have observed.
   * No-op if the order is already terminal or unknown.
   */
  close(id: string, matchedShares?: number): boolean {
    const entry = this.orders.get(id);
    if (!entry || entry.status !== 'open') return false;
    const matched = matchedShares ?? entry.size;
    entry.filledShares = Math.max(entry.filledShares, Math.min(matched, entry.size));
    entry.status = entry.filledShares >= entry.size ? 'filled' : 'open';
    return true;
  }

  /** Cancel/expire an order so it is no longer open (LIVE reconcile cleanup). */
  cancel(id: string): boolean {
    const entry = this.orders.get(id);
    if (!entry || entry.status !== 'open') return false;
    entry.status = 'expired';
    return true;
  }

  /** Durable restore across restarts. */
  restore(snapshot: RestingOrder[]): void {
    this.orders.clear();
    for (const o of snapshot) {
      const entry = o as OrderEntry;
      if (o.status === 'open' || o.status === 'filled' || o.status === 'expired') {
        this.orders.set(o.id, { ...entry });
      } else {
        this.orders.set(o.id, { ...o, status: 'open', filledShares: 0 });
      }
    }
  }

  snapshot(): RestingOrder[] {
    return [...this.orders.values()].map((o) => ({ ...o }));
  }

  /**
   * Refill pass: for each open order, consume executable ask/bid levels at or
   * inside the ceiling. Returns fills; orders fully filled close, partially
   * filled orders keep the remainder resting, past-TTL orders expire.
   */
  refill(book: RefillBook, now: number): RestingFill[] {
    const fills: RestingFill[] = [];
    for (const entry of this.orders.values()) {
      if (entry.status !== 'open' || entry.tokenId !== book.tokenId) continue;
      if (now - entry.placedAt > entry.ttlMs) {
        entry.status = 'expired';
        continue;
      }
      const usable = entry.side === 'BUY' ? book.asks : book.bids;
      let remaining = entry.size - entry.filledShares;
      let filledAt: number | null = null;
      for (const level of usable) {
        if (remaining <= 0) break;
        // Only fill at or inside the ceiling (BUY: ask <= ceiling; SELL: bid >= ceiling).
        const inside = entry.side === 'BUY' ? level.price <= entry.ceiling : level.price >= entry.ceiling;
        if (!inside) continue;
        const take = Math.min(remaining, level.size);
        if (take <= 0) continue;
        entry.filledShares += take;
        remaining -= take;
        filledAt = level.price;
        fills.push({ orderId: entry.id, tokenId: entry.tokenId, price: level.price, shares: take, at: now });
      }
      if (remaining <= 0 && entry.filledShares >= entry.size) {
        entry.status = 'filled';
      } else if (filledAt !== null) {
        // partial fill — keep resting
      }
    }
    return fills;
  }
}