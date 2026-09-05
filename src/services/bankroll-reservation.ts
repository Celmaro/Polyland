/** Synchronous reservation ledger preventing concurrent over-allocation. */
export class BankrollReservationLedger<K extends string = string> {
  private readonly reserved = new Map<K, number>();

  constructor(private readonly limits: Map<K, number>) {}

  available(key: K, spent = 0): number {
    return Math.max(0, (this.limits.get(key) ?? 0) - spent - (this.reserved.get(key) ?? 0));
  }

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
