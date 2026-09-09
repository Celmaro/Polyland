export type BookSide = 'bids' | 'asks';
export type BookState = 'VALID' | 'STALE' | 'RESYNCING' | 'INVALID';
export interface ReducerLevel { price: number; size: number }

/** Standalone, validated local order-book reducer. */
export class OrderBookReducer {
  private readonly books: Record<BookSide, Map<number, number>> = { bids: new Map(), asks: new Map() };
  private _state: BookState = 'INVALID';
  private _lastSeq: number | null = null;
  private _invalidInputs = 0;
  private _lastInvalidationReason: string | null = null;
  get state(): BookState { return this._state; }
  get lastSeq(): number | null { return this._lastSeq; }
  get invalidInputs(): number { return this._invalidInputs; }
  get lastInvalidationReason(): string | null { return this._lastInvalidationReason; }

  applySnapshot(side: BookSide, levels: ReducerLevel[], sequence?: number): boolean {
    this.assertSide(side);
    const next = new Map<number, number>();
    for (const l of levels) {
      if (!this.validLevel(l)) { this._invalidInputs++; continue; }
      if (l.size > 0) next.set(l.price, l.size);
    }
    this.books[side] = next;
    if (sequence !== undefined) {
      if (!Number.isSafeInteger(sequence) || sequence < 0 || (this._lastSeq !== null && sequence < this._lastSeq)) return false;
      this._lastSeq = sequence;
    }
    this._state = 'VALID';
    this._lastInvalidationReason = null;
    return true;
  }

  applyDelta(side: BookSide, price: number, size: number, sequence?: number): boolean {
    this.assertSide(side);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size)) { this._invalidInputs++; return false; }
    if (sequence !== undefined) {
      if (!Number.isSafeInteger(sequence) || sequence < 0 || (this._lastSeq !== null && sequence <= this._lastSeq)) return false;
      this._lastSeq = sequence;
    }
    if (size <= 0) this.books[side].delete(price); else this.books[side].set(price, size);
    if (this._state === 'INVALID' || this._state === 'RESYNCING') this._state = 'VALID';
    return true;
  }

  markStale(): void { if (this._state === 'VALID') this._state = 'STALE'; }
  beginResync(): void { this._state = 'RESYNCING'; this._lastSeq = null; }
  invalidate(reason: string): void { this._state = 'INVALID'; this._lastInvalidationReason = reason; this._lastSeq = null; this.books.bids.clear(); this.books.asks.clear(); }
  levels(side: BookSide): ReadonlyMap<number, number> { this.assertSide(side); return this.books[side]; }
  bestBid(): number | null { const a = [...this.books.bids.keys()]; return a.length ? Math.max(...a) : null; }
  bestAsk(): number | null { const a = [...this.books.asks.keys()]; return a.length ? Math.min(...a) : null; }
  mid(): number | null { const b = this.bestBid(), a = this.bestAsk(); return b !== null && a !== null ? (a + b) / 2 : null; }
  depthUsd(levels = Infinity): number {
    const sum = (m: Map<number, number>) => [...m.entries()].slice(0, levels).reduce((x, [p, s]) => x + p * s, 0);
    return sum(this.books.bids) + sum(this.books.asks);
  }
  imbalance(levels = 1): number | null {
    const bid = [...this.books.bids.entries()].sort((a,b)=>b[0]-a[0]).slice(0, levels).reduce((x,[p,s])=>x+p*s,0);
    const ask = [...this.books.asks.entries()].sort((a,b)=>a[0]-b[0]).slice(0, levels).reduce((x,[p,s])=>x+p*s,0);
    return bid + ask > 0 ? (bid - ask) / (bid + ask) : null;
  }
  private validLevel(l: ReducerLevel): boolean { return Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.size) && l.size >= 0; }
  private assertSide(side: string): asserts side is BookSide { if (side !== 'bids' && side !== 'asks') throw new Error(`unknown book side: ${side}`); }
}