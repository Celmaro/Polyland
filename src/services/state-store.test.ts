import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonStateStore } from './state-store.js';

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
