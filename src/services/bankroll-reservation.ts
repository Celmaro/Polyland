/**
 * Synchronous reservation ledger preventing concurrent over-allocation.
 *
 * Limits can be a static Map or a dynamic provider function (e.g. bankroll
 * derived from RiskManager capital, which changes as P&L accrues). Reserve
 * BEFORE any async boundary; the returned release function must run in a
 * `finally` so no early return can leak a reservation and permanently block
 * a basket.
 */
export class BankrollReservationLedger<K extends string = string> {
  private readonly reserved = new Map<K, number>();
  private readonly limitFor: (key: K) => number;

  constructor(limits: Map<K, number> | ((key: K) => number)) {
    this.limitFor = typeof limits === 'function' ? limits : (key) => limits.get(key) ?? 0;
  }

  /** Capital still available: limit minus spent minus in-flight reservations. */
  available(key: K, spent = 0): number {
    return Math.max(0, this.limitFor(key) - spent - (this.reserved.get(key) ?? 0));
  }

  /**
   * Reserve `amount` if it fits within the remaining limit. Returns an
   * idempotent release function, or null when the amount exceeds availability
   * (a concurrent reservation consumed the slice).
   */
  reserve(key: K, amount: number, spent = 0): (() => void) | null {
    if (!Number.isFinite(amount) || amount <= 0 || amount > this.available(key, spent)) return null;
    this.reserved.set(key, (this.reserved.get(key) ?? 0) + amount);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.reserved.get(key) ?? 0) - amount;
      if (next <= 0) this.reserved.delete(key); else this.reserved.set(key, next);
    };
  }

  getReserved(key: K): number { return this.reserved.get(key) ?? 0; }
}