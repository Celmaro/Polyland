/**
 * market-snapshot-store.ts — bucketed market feature snapshots in SQLite.
 *
 * Adopted pattern (acyclops/polymarket-lens fetchMarkets.js:20-25,249-265 +
 * ingestSnapshots.js:25-34) + (nahrek/polyledger storage.py:271-283):
 *   - 15-minute UTC buckets with PRIMARY KEY (token_id, ts_bucket);
 *   - conflict-upsert replaces the latest fetch (never two rows per bucket);
 *   - withTransaction() wraps state+cursor writes in one BEGIN/COMMIT so
 *     "observation persisted" and "checkpoint advanced" can never disagree.
 *
 * This gives DRY_RUN/replay a deterministic historical feature feed
 * (probability, liquidity, volume24h, spread, depth, chop per bucket).
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface MarketTick {
  tokenId: string;
  /** Bucket start, unix ms (floor(now / 15min) * 15min). */
  tsBucket: number;
  probability: number;
  liquidity: number;
  volume24hr: number;
  spreadBps: number | null;
  depthUsd: number;
  chop: number;
  fetchedAt: number;
}

type DB = import('node:sqlite').DatabaseSync;

const BUCKET_MS = 15 * 60 * 1000;

/** Floor a timestamp to its UTC 15-minute bucket start. */
export function bucket15m(ts: number): number {
  return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
}

export class MarketSnapshotStore {
  private db: DB | null = null;

  constructor(private readonly filePath: string) {}

  private ensureOpen(): DB {
    if (this.db) return this.db;
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    if (this.filePath !== ':memory:') mkdirSync(dirname(this.filePath), { recursive: true });
    const db = new DatabaseSync(this.filePath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS market_ticks (
        token_id    TEXT NOT NULL,
        ts_bucket   INTEGER NOT NULL,
        probability REAL NOT NULL,
        liquidity   REAL NOT NULL DEFAULT 0,
        volume24hr  REAL NOT NULL DEFAULT 0,
        spread_bps  REAL,
        depth_usd   REAL NOT NULL DEFAULT 0,
        chop        REAL NOT NULL DEFAULT 0,
        fetched_at  INTEGER NOT NULL,
        PRIMARY KEY (token_id, ts_bucket)
      );
      CREATE INDEX IF NOT EXISTS idx_ticks_token_ts ON market_ticks (token_id, ts_bucket);
    `);
    this.db = db;
    return db;
  }

  async open(): Promise<void> {
    this.ensureOpen();
  }

  /** Upsert one bucket observation (conflict → update measurements). */
  async upsertTick(t: MarketTick): Promise<void> {
    const db = this.ensureOpen();
    db.prepare(`
      INSERT INTO market_ticks
        (token_id, ts_bucket, probability, liquidity, volume24hr, spread_bps, depth_usd, chop, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_id, ts_bucket) DO UPDATE SET
        probability = excluded.probability,
        liquidity   = excluded.liquidity,
        volume24hr  = excluded.volume24hr,
        spread_bps  = excluded.spread_bps,
        depth_usd   = excluded.depth_usd,
        chop        = excluded.chop,
        fetched_at  = excluded.fetched_at
    `).run(t.tokenId, t.tsBucket, t.probability, t.liquidity ?? 0, t.volume24hr ?? 0,
      t.spreadBps ?? null, t.depthUsd ?? 0, t.chop ?? 0, t.fetchedAt);
  }

  /** Read ticks for a token within a time window, ascending by bucket. */
  async readTicks(tokenId: string, fromMs: number, toMs: number): Promise<MarketTick[]> {
    const db = this.ensureOpen();
    const rows = db.prepare(
      `SELECT token_id AS tokenId, ts_bucket AS tsBucket, probability, liquidity,
              volume24hr, spread_bps AS spreadBps, depth_usd AS depthUsd, chop, fetched_at AS fetchedAt
       FROM market_ticks
       WHERE token_id = ? AND ts_bucket >= ? AND ts_bucket <= ?
       ORDER BY ts_bucket ASC`,
    ).all(tokenId, fromMs, toMs) as unknown as MarketTick[];
    return rows.map((r) => ({ ...r, spreadBps: r.spreadBps === null ? null : Number(r.spreadBps) }));
  }

  /**
   * Run fn inside one SQLite transaction; commit on success, roll back on
   * throw. Writes made before the throw are discarded — the checkpointed
   * batch-invariant guarantee.
   */
  async withTransaction<T>(fn: () => Promise<T> | T): Promise<T> {
    const db = this.ensureOpen();
    db.exec('BEGIN');
    try {
      const result = await fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}