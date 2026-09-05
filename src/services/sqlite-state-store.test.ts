import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteStateStore } from './sqlite-state-store.js';

let sqliteOk = false;
try {
  await import('node:sqlite');
  sqliteOk = true;
} catch {
  sqliteOk = false;
}

describe.runIf(sqliteOk)('SqliteStateStore', () => {
  it('round-trips namespaces and isolates corrupt payloads', async () => {
    const file = path.join(os.tmpdir(), `polyland-sqlite-${Date.now()}.db`);
    const a = new SqliteStateStore(file);
    await a.save({ walletUniverse: { wallets: ['0xabc'] }, quorum: { votes: 3 } });
    const b = new SqliteStateStore(file);
    const loaded = await b.load();
    expect(loaded?.walletUniverse).toEqual({ wallets: ['0xabc'] });
    expect(loaded?.quorum).toEqual({ votes: 3 });
    b.close();
  });

  it('updates a single namespace without touching others', async () => {
    const file = path.join(os.tmpdir(), `polyland-sqlite2-${Date.now()}.db`);
    const store = new SqliteStateStore(file);
    await store.save({ risk: { halted: true } });
    await store.save({ screening: { savedAt: 1 } });
    const loaded = await store.load();
    expect(loaded?.risk).toEqual({ halted: true });
    expect(loaded?.screening).toEqual({ savedAt: 1 });
    store.close();
  });
});
