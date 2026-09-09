import { describe, it, expect, afterEach } from 'vitest';
import { MarketSnapshotStore, type MarketTick } from './market-snapshot-store.js';

const tick = (over: Partial<MarketTick> = {}): MarketTick => ({
  tokenId: 't1',
  tsBucket: 1_720_000_000_000,
  probability: 0.5,
  liquidity: 100,
  volume24hr: 50,
  spreadBps: 100,
  depthUsd: 200,
  chop: 0.01,
  fetchedAt: 1_720_000_000_001,
  ...over,
});

describe('MarketSnapshotStore', () => {
  let store: MarketSnapshotStore;
  afterEach(() => store?.close());

  it('upserts a tick and reads it back in a time window', async () => {
    store = new MarketSnapshotStore(':memory:');
    await store.open();
    await store.upsertTick(tick());
    await store.upsertTick(tick({ tokenId: 't2', tsBucket: 1_720_000_100_000, probability: 0.6 }));
    const rows = await store.readTicks('t1', 1_719_999_000_000, 1_721_000_000_000);
    expect(rows).toHaveLength(1);
    expect(rows[0].probability).toBeCloseTo(0.5, 9);
    expect(rows[0].tokenId).toBe('t1');
  });

  it('conflict-upserts within the same 15-min bucket (lens fetchMarkets.js:249-265)', async () => {
    store = new MarketSnapshotStore(':memory:');
    await store.open();
    await store.upsertTick(tick({ probability: 0.4 }));
    await store.upsertTick(tick({ probability: 0.55 }));
    const rows = await store.readTicks('t1', 0, Number.MAX_SAFE_INTEGER);
    expect(rows).toHaveLength(1); // PK (token_id, ts_bucket) collapses the duplicate
    expect(rows[0].probability).toBeCloseTo(0.55, 9);
  });

  it('commits a transaction atomically (state + cursor never disagree)', async () => {
    store = new MarketSnapshotStore(':memory:');
    await store.open();
    await store.withTransaction(async () => {
      await store.upsertTick(tick());
      await store.upsertTick(tick({ tokenId: 't2', tsBucket: 1_720_000_200_000 }));
    });
    const rows = await store.readTicks('t1', 0, Number.MAX_SAFE_INTEGER);
    expect(rows).toHaveLength(1);
  });

  it('rolls back the whole batch when any write throws', async () => {
    store = new MarketSnapshotStore(':memory:');
    await store.open();
    await expect(
      store.withTransaction(async () => {
        await store.upsertTick(tick());
        throw new Error('mid-batch failure');
      }),
    ).rejects.toThrow('mid-batch failure');
    const rows = await store.readTicks('t1', 0, Number.MAX_SAFE_INTEGER);
    expect(rows).toHaveLength(0); // nothing persisted
  });
});