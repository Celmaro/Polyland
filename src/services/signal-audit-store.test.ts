import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SignalAuditStore,
  signalAuditStore,
  setBonferroniGroups,
  type FiredSignal,
} from './signal-audit-store.js';
import { takerFeePerShare, DEFAULT_FEE_RATE_BPS } from '../utils/fee-math.js';

const mkFire = (store: SignalAuditStore, overrides: Partial<Parameters<SignalAuditStore['recordFire']>[0]> = {}) =>
  store.recordFire({
    conditionId: 'cond-1',
    marketSlug: 'test-market',
    outcome: 'Yes',
    side: 'BUY',
    pricePaid: 0.55,
    size: 10,
    winRate: 0.6,
    basket: 'Crypto Quorum',
    wallets: ['0xa', '0xb'],
    ...overrides,
  });

describe('SignalAuditStore realized-edge math', () => {
  let store: SignalAuditStore;

  beforeEach(() => {
    store = new SignalAuditStore();
  });

  it('books a winning BUY above 50c as POSITIVE edge (regression: was double-subtracting cost basis)', () => {
    const id = mkFire(store, { pricePaid: 0.55, size: 10 });
    store.recordSettlement('cond-1', 1); // won
    const s = store.getSignal(id)!;
    const expected = (1 - 0.55 - takerFeePerShare(0.55, DEFAULT_FEE_RATE_BPS)) * 10;
    expect(s.realizedEdge).toBeCloseTo(expected, 10);
    expect(s.realizedEdge!).toBeGreaterThan(0);
  });

  it('books a losing BUY as -(pricePaid + fee) * size', () => {
    const id = mkFire(store, { pricePaid: 0.55, size: 10 });
    store.recordSettlement('cond-1', 0); // lost
    const s = store.getSignal(id)!;
    const expected = (0 - 0.55 - takerFeePerShare(0.55, DEFAULT_FEE_RATE_BPS)) * 10;
    expect(s.realizedEdge).toBeCloseTo(expected, 10);
    expect(s.realizedEdge!).toBeLessThan(0);
  });

  it('books a winning SELL (NO bought below 50c) as positive edge', () => {
    const id = mkFire(store, { side: 'SELL', pricePaid: 0.45, size: 10 });
    store.recordSettlement('cond-1', 0); // NO wins
    const s = store.getSignal(id)!;
    const expected = (1 - 0.45 - takerFeePerShare(0.45, DEFAULT_FEE_RATE_BPS)) * 10;
    expect(s.realizedEdge).toBeCloseTo(expected, 10);
    expect(s.realizedEdge!).toBeGreaterThan(0);
  });

  it('books a losing SELL as negative edge', () => {
    const id = mkFire(store, { side: 'SELL', pricePaid: 0.45, size: 10 });
    store.recordSettlement('cond-1', 1); // YES wins, NO worthless
    const s = store.getSignal(id)!;
    const expected = (0 - 0.45 - takerFeePerShare(0.45, DEFAULT_FEE_RATE_BPS)) * 10;
    expect(s.realizedEdge).toBeCloseTo(expected, 10);
    expect(s.realizedEdge!).toBeLessThan(0);
  });

  it('records the caller-provided feePerShare when given (execution/audit fee consistency)', () => {
    const id = mkFire(store, { pricePaid: 0.6, feePerShare: 0.0048 });
    const s = store.getSignal(id)!;
    expect(s.feePerShare).toBe(0.0048);
    expect(s.expectedEdge).toBeCloseTo(0.6 - 0.6 - 0.0048, 10); // winRate 0.6 - price 0.6 - fee
  });

  it('is idempotent on double settlement (no double-count)', () => {
    const id = mkFire(store);
    store.recordSettlement('cond-1', 1);
    const first = store.getSignal(id)!.realizedEdge;
    store.recordSettlement('cond-1', 0); // would flip the result if not guarded
    expect(store.getSignal(id)!.realizedEdge).toBe(first);
    expect(store.getSignal(id)!.resolved).toBe(1);
  });

  it('generates unique fire ids for same-ms fires on the same condition+outcome', () => {
    const a = mkFire(store);
    const b = mkFire(store);
    expect(a).not.toBe(b);
    expect(store.getSignalsByCondition('cond-1')).toHaveLength(2);
  });

  it('dedupes unsettled condition ids', () => {
    mkFire(store);
    mkFire(store); // same condition
    mkFire(store, { conditionId: 'cond-2' });
    const ids = store.getUnsettledConditionIds();
    expect(ids.sort()).toEqual(['cond-1', 'cond-2']);
  });

  it('uses fee-math dynamic fee by default (not the legacy flat 0.003)', () => {
    const id = mkFire(store, { pricePaid: 0.5 });
    const s = store.getSignal(id)!;
    expect(s.feePerShare).toBeCloseTo(takerFeePerShare(0.5, DEFAULT_FEE_RATE_BPS), 12);
    expect(s.feePerShare).not.toBe(0.003);
  });

  it('prunes signals older than the window (memory bound)', () => {
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    store.recordFire({
      conditionId: 'old-cond', marketSlug: 'm', outcome: 'Yes', side: 'BUY',
      pricePaid: 0.5, size: 1, winRate: 0.5, basket: 'b', wallets: [],
      // inject old firedAt via monkey-patch on the returned signal
    });
    // Backdate the stored signal's firedAt (recordFire stamps Date.now()).
    const sig = store.getSignalsByCondition('old-cond')[0];
    (sig as FiredSignal).firedAt = old;
    store.getStats(); // triggers prune
    expect(store.getSignalsByCondition('old-cond')).toHaveLength(0);
  });
});

describe('SignalAuditStore significance gate', () => {
  let store: SignalAuditStore;

  beforeEach(() => {
    store = new SignalAuditStore();
  });

  it('does not report significance below the minimum sample size', () => {
    setBonferroniGroups(3);
    for (let i = 0; i < 5; i++) {
      const id = mkFire(store, { conditionId: `c${i}`, pricePaid: 0.4 });
      store.recordSettlement(`c${i}`, 1); // all winners, huge edge
    }
    const stats = store.getStats();
    expect(stats.signalsSettled).toBe(5);
    expect(stats.isSignificant).toBe(false); // n < 8 gate
  });

  it('uses the bonferroni-corrected alpha (stricter with more groups)', () => {
    setBonferroniGroups(8);
    const stats = store.getStats();
    expect(stats.bonferroniAlpha).toBeCloseTo(0.05 / 8, 12);
  });

  it('does not mutate BONFERRONI_GROUPS across calls (was: alpha drifted with sample size)', () => {
    setBonferroniGroups(3);
    for (let i = 0; i < 12; i++) {
      const id = mkFire(store, { conditionId: `c${i}`, pricePaid: 0.5 });
      store.recordSettlement(`c${i}`, i % 2 === 0 ? 1 : 0);
    }
    const a1 = store.getStats().bonferroniAlpha;
    const a2 = store.getStats().bonferroniAlpha;
    expect(a1).toBe(a2);
    expect(a1).toBeCloseTo(Math.round((0.05 / 3) * 10000) / 10000, 12); // rounded to 4dp by getStats
  });
});

describe('SignalAuditStore JSONL replay (restart survival)', () => {
  let store: SignalAuditStore;
  let tmpDir: string;

  beforeEach(() => {
    store = new SignalAuditStore();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
    SignalAuditStore.enableJsonl(path.join(tmpDir, 'trail.jsonl'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    SignalAuditStore.enableJsonl('');
  });

  it('reconstructs fires + settlements from the trail with fixed math', () => {
    const id = mkFire(store, { pricePaid: 0.55, size: 10 });
    store.recordSettlement('cond-1', 1);

    const fresh = new SignalAuditStore();
    fresh.replayJsonl(path.join(tmpDir, 'trail.jsonl'));

    const s = fresh.getSignal(id);
    expect(s).toBeDefined();
    expect(s!.settledAt).toBeDefined();
    const expected = (1 - 0.55 - takerFeePerShare(0.55, DEFAULT_FEE_RATE_BPS)) * 10;
    expect(s!.realizedEdge).toBeCloseTo(expected, 10);
    expect(fresh.getUnsettledConditionIds()).toEqual([]);
  });

  it('replays exit_settled records', () => {
    const id = mkFire(store, { pricePaid: 0.4, size: 10 });
    store.markExited('cond-1', 0.7, 'EDGE_TP');

    const fresh = new SignalAuditStore();
    fresh.replayJsonl(path.join(tmpDir, 'trail.jsonl'));

    const s = fresh.getSignal(id);
    expect(s!.exitReason).toBe('EDGE_TP');
    expect(s!.realizedEdge).toBeCloseTo((0.7 - 0.4 - takerFeePerShare(0.4, DEFAULT_FEE_RATE_BPS)) * 10, 10);
    expect(s!.settledAt).toBeDefined();
  });

  it('ignores malformed lines without crashing', () => {
    fs.appendFileSync(path.join(tmpDir, 'trail.jsonl'), '{not-json\n{"event":"fire","id":"x"}\n');
    const fresh = new SignalAuditStore();
    expect(() => fresh.replayJsonl(path.join(tmpDir, 'trail.jsonl'))).not.toThrow();
  });
});

describe('SignalAuditStore singleton sanity', () => {
  it('exports a usable singleton', () => {
    expect(signalAuditStore).toBeInstanceOf(SignalAuditStore);
  });
});
