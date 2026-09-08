/**
 * tests for src/services/replay-cache.ts — content-fingerprint replay caching.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { replayFingerprint, ReplayFileCache, type ReplaySourceFingerprint } from './replay-cache.js';
import type { ReplayResult } from './replay.js';

const SRC: ReplaySourceFingerprint = { path: 'data/signal-audit.jsonl', mtimeMs: 1_700_000_000_000, size: 12_345 };

function sampleResult(): ReplayResult {
  return {
    entries: [
      { id: 's1', category: 'crypto', side: 'BUY', pricePaid: 0.5, resolved: 1, recordedPnl: 10, simulatedPnl: 12, delta: 2, holdSeconds: 300, exitReason: 'TAKE_PROFIT', slippageFlag: false },
    ],
    byCategory: { crypto: { n: 1, totalPnl: 10, avgDelta: 2 } },
    totalRecorded: 10,
    totalSimulated: 12,
    totalDelta: 2,
    slippageFlags: 0,
  };
}

describe('replayFingerprint', () => {
  it('is stable for identical config + source (cache reuse)', () => {
    const a = replayFingerprint({ exitConfig: 'audit' }, SRC);
    const b = replayFingerprint({ exitConfig: 'audit' }, SRC);
    expect(a).toBe(b);
  });
  it('changes when the exit profile changes', () => {
    const a = replayFingerprint({ exitConfig: 'audit' }, SRC);
    const b = replayFingerprint({ exitConfig: 'aggressive' }, SRC);
    expect(a).not.toBe(b);
  });
  it('changes when an explicit parameter changes', () => {
    const a = replayFingerprint({ exitConfig: 'audit', stopLossPct: 0.10 }, SRC);
    const b = replayFingerprint({ exitConfig: 'audit', stopLossPct: 0.05 }, SRC);
    expect(a).not.toBe(b);
  });
  it('changes when the source data changes (mtime/size)', () => {
    const a = replayFingerprint({ exitConfig: 'audit' }, SRC);
    const b = replayFingerprint({ exitConfig: 'audit' }, { ...SRC, size: 12_346 });
    expect(a).not.toBe(b);
  });
  it('produces a stable hex digest of fixed length', () => {
    const fp = replayFingerprint({ exitConfig: 'audit' }, SRC);
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('ReplayFileCache', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-cache-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('round-trips a saved result through load', async () => {
    const cache = new ReplayFileCache(dir);
    const fp = replayFingerprint({ exitConfig: 'audit' }, SRC);
    await cache.save(fp, sampleResult());
    const loaded = await cache.load(fp);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries).toHaveLength(1);
    expect(loaded!.totalDelta).toBe(2);
  });

  it('returns null when the key is not cached', async () => {
    const cache = new ReplayFileCache(dir);
    expect(await cache.load('missing-key')).toBeNull();
  });

  it('tolerates a corrupt cache file and returns null (recompute path)', async () => {
    const cache = new ReplayFileCache(dir);
    const fp = replayFingerprint({ exitConfig: 'audit' }, SRC);
    fs.writeFileSync(path.join(dir, `${fp}.json`), '{ not json !!!', 'utf8');
    expect(await cache.load(fp)).toBeNull();
  });

  it('stores under the fingerprint filename', async () => {
    const cache = new ReplayFileCache(dir);
    const fp = replayFingerprint({ exitConfig: 'audit' }, SRC);
    await cache.save(fp, sampleResult());
    expect(fs.existsSync(path.join(dir, `${fp}.json`))).toBe(true);
  });
});