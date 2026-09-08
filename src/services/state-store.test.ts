import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonStateStore , mergeOrderLifecycle } from './state-store.js';

describe('JsonStateStore', () => {
  it('round-trips namespaced state across instances', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyland-state-'));
    const file = path.join(dir, 'state.json');
    try {
      const first = new JsonStateStore(file);
      await first.save({ screening: { cacheKey: 'abc', count: 3 }, risk: { halted: false } });
      const second = new JsonStateStore(file);
      const loaded = await second.load();
      expect(loaded?.version).toBe(1);
      expect(loaded?.screening).toEqual({ cacheKey: 'abc', count: 3 });
      expect(loaded?.risk).toEqual({ halted: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent writes and preserves both namespaces', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyland-state-'));
    const file = path.join(dir, 'state.json');
    try {
      const store = new JsonStateStore(file);
      await Promise.all([
        store.save({ screening: { ready: true } }),
        store.save({ quorum: { ready: true } }),
      ]);
      const loaded = await new JsonStateStore(file).load();
      expect(loaded?.screening).toEqual({ ready: true });
      expect(loaded?.quorum).toEqual({ ready: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for missing or invalid state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyland-state-'));
    const file = path.join(dir, 'state.json');
    try {
      const store = new JsonStateStore(file);
      expect(await store.load()).toBeNull();
      fs.writeFileSync(file, JSON.stringify({ version: 999 }), 'utf8');
      expect(await store.load()).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('OrderLifecycleRecord merge (P0-4 durable idempotency)', () => {
  it('keeps the newer record for the same order id', () => {
    const merged = mergeOrderLifecycle([
      { id: 'o1', positionId: 'p1', status: 'PENDING', updatedAt: 100 },
    ], { id: 'o1', positionId: 'p1', status: 'FILLED', updatedAt: 200 });
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('FILLED');
  });
  it('ignores an older or equal-timestamp update (idempotent replay)', () => {
    const merged = mergeOrderLifecycle([
      { id: 'o1', positionId: 'p1', status: 'FILLED', updatedAt: 200 },
    ], { id: 'o1', positionId: 'p1', status: 'PENDING', updatedAt: 100 });
    expect(merged[0].status).toBe('FILLED');
    const sameTs = mergeOrderLifecycle([merged[0]], { id: 'o1', positionId: 'p1', status: 'CANCELLED', updatedAt: 200 });
    expect(sameTs[0].status).toBe('CANCELLED'); // >= keeps incoming on tie
  });
  it('appends distinct orders', () => {
    const merged = mergeOrderLifecycle([], { id: 'o1', positionId: 'p1', status: 'UNKNOWN', updatedAt: 100 });
    const merged2 = mergeOrderLifecycle(merged, { id: 'o2', positionId: 'p2', status: 'FILLED', updatedAt: 100 });
    expect(merged2.map(o => o.id).sort()).toEqual(['o1', 'o2']);
  });
});
