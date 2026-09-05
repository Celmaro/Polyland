import { describe, expect, it } from 'vitest';
import { BankrollReservationLedger } from './bankroll-reservation.js';

describe('BankrollReservationLedger', () => {
  it('prevents concurrent reservations exceeding a basket limit', () => {
    const ledger = new BankrollReservationLedger(new Map([['crypto', 100]]));
    const first = ledger.reserve('crypto', 60);
    expect(first).not.toBeNull();
    expect(ledger.reserve('crypto', 41)).toBeNull();
    first!();
    expect(ledger.reserve('crypto', 40)).not.toBeNull();
  });

  it('accounts for already spent capital and release is idempotent', () => {
    const ledger = new BankrollReservationLedger(new Map([['x', 100]]));
    const release = ledger.reserve('x', 20, 70)!;
    expect(ledger.available('x', 70)).toBe(10);
    release(); release();
    expect(ledger.getReserved('x')).toBe(0);
  });
});
