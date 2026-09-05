import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DecisionLedger, funnelFromStats } from './decision-ledger.js';
import type { LedgerRecord } from './pipeline-types.js';
const mkRecord = (overrides: Partial<LedgerRecord> = {}): LedgerRecord => ({
  id: `rec-${Math.random().toString(36).slice(2)}`,
  wallet: '0xabc',
  conditionId: 'cond-1',
  marketSlug: 'test-market',
  outcome: 'Yes',
  side: 'BUY',
  price: 0.55,
  size: 10,
  tradeTimestamp: 1700000000000,
  discoveredAt: 1700000000000,
  decidedAt: 1700000001000,
  ageMs: 1000,
  domain: 'politics',
  tier: 'PRIMARY',
  accepted: true,
  stage: 'vote_recorded',
  ...overrides,
});
describe('DecisionLedger', () => {
  let dir: string;
  let ledgerPath: string;
  let ledger: DecisionLedger;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-ledger-'));
    ledgerPath = path.join(dir, 'decision-ledger.jsonl');
    ledger = new DecisionLedger(ledgerPath);
  });
  afterEach(async () => {
    await ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('append + replay roundtrip preserves accepted and rejected records', async () => {
    const accepted = mkRecord({ stage: 'vote_recorded', accepted: true });
    const rejected = mkRecord({ stage: 'pre_vote', accepted: false, rejectionReason: 'thin' });
    await ledger.append(accepted);
    await ledger.append(rejected);
    const replayed = await ledger.replay();
    expect(replayed).toHaveLength(2);
    expect(replayed[0].id).toBe(accepted.id);
    expect(replayed[0].accepted).toBe(true);
    expect(replayed[1].id).toBe(rejected.id);
    expect(replayed[1].rejectionReason).toBe('thin');
    expect(fs.existsSync(ledgerPath)).toBe(true);
  });
  it('replay is tolerant of corrupt lines and counts them', async () => {
    await ledger.append(mkRecord({ id: 'good-1' }));
    fs.appendFileSync(ledgerPath, '{not-json}\n{"id": 42}\n', 'utf8');
    await ledger.append(mkRecord({ id: 'good-2' }));
    const replayed = await ledger.replay();
    expect(replayed).toHaveLength(2);
    expect(ledger.getCorruptLineCount()).toBe(2);
  });
  it('stats() tallies accepted and rejected-by-reason', async () => {
    await ledger.append(mkRecord({ accepted: true }));
    await ledger.append(mkRecord({ accepted: false, rejectionReason: 'thin' }));
    await ledger.append(mkRecord({ accepted: false, rejectionReason: 'stale' }));
    await ledger.append(mkRecord({ accepted: false, rejectionReason: 'thin' }));
    const stats = await ledger.replay().then(() => ledger.stats());
    expect(stats.total).toBe(4);
    expect(stats.accepted).toBe(1);
    expect(stats.rejectedByReason).toEqual({ thin: 2, stale: 1 });
  });
  it('append never throws even when the path is unwritable', async () => {
    const bad = new DecisionLedger(path.join(dir, 'no-such-dir', 'deep', 'ledger.jsonl'));
    await expect(bad.append(mkRecord())).resolves.toBeUndefined();
    await bad.close();
  });
  it('rotates the file when it exceeds maxBytes, dropping older rotations', async () => {
    const small = new DecisionLedger({ path: ledgerPath, maxBytes: 512 });
    for (let i = 0; i < 20; i++) await small.append(mkRecord({ id: `rot-${i}` }));
    // One more append forces the rotation check: current file (over cap) is
    // renamed to .1 and the new record starts a fresh file.
    await small.append(mkRecord({ id: 'rot-after' }));
    await small.close();
    expect(fs.existsSync(ledgerPath)).toBe(true);
    expect(fs.statSync(ledgerPath).size).toBeLessThan(512);
    expect(fs.existsSync(ledgerPath + '.1')).toBe(true);
    const replay = await small.replay();
    expect(replay.length).toBeGreaterThan(0);
  });
});
describe('monotonic funnel accounting helper', () => {
  it('ignored never exceeds received in a well-formed funnel', () => {
    const funnel = funnelFromStats({
      feedReceived: 45844,
      ignoredNoBasket: 15000,
      ignoredNotMember: 15000,
      ignoredUnsupportedSide: 7300,
      ignoredInvalidMarket: 5033,
      votesRecorded: 1481,
      quorumSkippedThinEdge: 208,
      quorumSkippedStaleMarket: 1822,
    });
    expect(funnel.received).toBe(45844);
    expect(funnel.recorded).toBe(1481);
    expect(funnel.filtered).toBe(2030);
    expect(funnel.ignored).toBeLessThanOrEqual(funnel.received);
    // In a well-formed feed, each raw event occupies exactly one stage.
    expect(funnel.received).toBe(funnel.ignored + funnel.recorded + funnel.filtered);
  });
  it('clamps a broken stats object so ignored <= received holds', () => {
    const funnel = funnelFromStats({
      feedReceived: 100,
      ignoredNoBasket: 600,
      ignoredNotMember: 0,
      ignoredUnsupportedSide: 0,
      ignoredInvalidMarket: 0,
      votesRecorded: 50,
      quorumSkippedThinEdge: 5,
      quorumSkippedStaleMarket: 0,
    });
    expect(funnel.ignored).toBe(100);
    expect(funnel.ignored).toBeLessThanOrEqual(funnel.received);
    expect(funnel.filtered).toBe(5);
  });
  it('rejects negative counters', () => {
    const funnel = funnelFromStats({
      feedReceived: -5,
      ignoredNoBasket: 0,
      ignoredNotMember: 0,
      ignoredUnsupportedSide: 0,
      ignoredInvalidMarket: 0,
      votesRecorded: -1,
      quorumSkippedThinEdge: 0,
      quorumSkippedStaleMarket: 0,
    });
    expect(funnel.received).toBe(0);
    expect(funnel.recorded).toBe(0);
  });
});