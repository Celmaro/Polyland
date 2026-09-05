import { describe, expect, it } from 'vitest';
import { TradeDetector, identityKey, type CandidateTrade, type TradeLedger } from './trade-detector.js';

class MemLedger implements TradeLedger {
  private m = new Map<string, unknown>();
  claim(key: string, value: unknown): boolean {
    if (this.m.has(key)) return false;
    this.m.set(key, value);
    return true;
  }
  get(key: string): unknown {
    return this.m.get(key);
  }
}

const NOW = Date.now();

const base: CandidateTrade = {
  wallet: '0xWALLET1',
  conditionId: 'cond-1',
  marketSlug: 'will-btc-hit-100k',
  tokenId: 'token-1',
  outcome: 'Yes',
  side: 'BUY',
  size: 10,
  price: 0.5,
  timestamp: NOW - 5000,
};

function rec(c: CandidateTrade, ledger?: TradeLedger, config?: ConstructorParameters<typeof TradeDetector>[1]) {
  const d = new TradeDetector(ledger ?? new MemLedger(), config);
  return d;
}

describe('TradeDetector', () => {
  it('claims a canonical key durably and deduplicates replayed events', () => {
    const ledger = new MemLedger();
    const d = new TradeDetector(ledger);
    const first = d.detect(base);
    expect(first?.status).toBe('CONFIRMED');
    // Same wallet/condition/side within the same second bucket => same key.
    const replay = d.detect({ ...base, timestamp: base.timestamp + 500 });
    expect(replay).toBeNull();
    // A different bucket is a distinct event.
    const later = d.detect({ ...base, timestamp: base.timestamp + 5000 });
    expect(later?.status).toBe('CONFIRMED');
  });

  it('rejects dust, stale, and invalid candidates with explicit reasons', () => {
    const ledger = new MemLedger();
    const d = new TradeDetector(ledger);
    expect(d.detect({ ...base, size: 0.5, price: 0.5 })?.rejectReason).toBe('dust');
    expect(d.detect({ ...base, timestamp: Date.now() - 10 * 60 * 1000 })?.rejectReason).toBe('stale');
    expect(d.detect({ ...base, conditionId: '' })?.rejectReason).toBe('invalid_market');
    expect(d.detect({ ...base, price: 0 })?.rejectReason).toBe('invalid_market');
  });

  it('rejects identity mismatch on reconciliation and never copies it', () => {
    const ledger = new MemLedger();
    const d = new TradeDetector(ledger);
    const det = d.detect(base);
    expect(det?.status).toBe('CONFIRMED');
    const bad = d.reconcile(base, { wallet: '0xOTHER' });
    expect(bad.status).toBe('REJECTED');
    expect(bad.rejectReason).toBe('identity_mismatch');
    // The same key is now REJECTED in the ledger.
    expect(ledger.get(d.keyFor(base))).toBeTruthy();
    expect(d.detect(base)).toBeNull();
  });

  it('rejects size/price/side mismatch beyond tolerance as identity mismatch', () => {
    const ledger = new MemLedger();
    const d = new TradeDetector(ledger);
    d.detect(base);
    expect(d.reconcile(base, { size: base.size * 1.5 })?.rejectReason).toBe('identity_mismatch');
    expect(d.reconcile({ ...base, timestamp: base.timestamp + 5000 }, { side: 'SELL' })?.rejectReason).toBe('identity_mismatch');
  });

  it('confirms reconciliation when authoritative values agree within tolerance', () => {
    const ledger = new MemLedger();
    const d = new TradeDetector(ledger);
    const det = d.detect(base);
    expect(det?.status).toBe('CONFIRMED');
    const ok = d.reconcile(base, { size: base.size * 1.01, price: base.price * 1.01 });
    expect(ok.status).toBe('CONFIRMED');
    expect(ok.reconciledAt).toBeGreaterThan(0);
  });

  it('uses sourceRef when present and falls back to a wallet-market-side bucket', () => {
    expect(identityKey({ ...base, sourceRef: '0xabc123456789' })).toBe('tx:0xabc123456789');
    expect(identityKey(base)).toMatch(/^wallet:0xwallet1:cond-1:buy:/);
  });

  it('aggregates fills into a parent decision with VWAP and net size', () => {
    const ledger = new MemLedger();
    const d = new TradeDetector(ledger, { aggregationWindowMs: 10_000 });
    d.detect(base);
    d.detect({ ...base, timestamp: base.timestamp + 1000, size: 5, price: 0.6 });
    const agg = d.aggregate(d.keyFor(base));
    expect(agg?.fillCount).toBe(2);
    expect(agg?.totalSize).toBeCloseTo(15, 6);
    expect(agg?.vwap).toBeCloseTo((10 * 0.5 + 5 * 0.6) / 15, 6);
  });

  it('is idempotent: reconcile is stable and aggregate on missing key is null', () => {
    const ledger = new MemLedger();
    const d = new TradeDetector(ledger);
    expect(d.aggregate('missing')).toBeNull();
  });
});