/**
 * SQLite-backed namespaced runtime state for Polyland.
 *
 * Same StateStore interface as JsonStateStore, but each namespace is a row in
 * a kv table, so one namespace's write can never corrupt another's and atomic
 * commits are provided by SQLite itself. The node:sqlite module is imported
 * dynamically so the bot still boots on Node versions without it.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PolylandState, StateStore } from './state-store.js';

export type { StateStore } from './state-store.js';

const NAMESPACES: ReadonlyArray<keyof Omit<PolylandState, 'version' | 'updatedAt'>> = [
  'walletUniverse',
  'quorum',
  'risk',
  'positions',
  'screening',
  'audit',
];

export class SqliteStateStore implements StateStore {
  private db: import('node:sqlite').DatabaseSync | null = null;
  private current: PolylandState = { version: 1, updatedAt: Date.now() };

  constructor(private readonly filePath: string) {}

  /** Open the database (idempotent). Throws if node:sqlite is unavailable. */
  private ensureOpen(): import('node:sqlite').DatabaseSync {
    if (this.db) return this.db;
    // node:sqlite is ESM-only; use createRequire so this file stays ESM-compatible.
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    mkdirSync(dirname(this.filePath), { recursive: true });
    const db = new DatabaseSync(this.filePath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS state_kv (
        namespace TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db = db;
    return db;
  }

  async load(): Promise<PolylandState | null> {
    try {
      const db = this.ensureOpen();
      const rows = db.prepare('SELECT namespace, payload FROM state_kv').all();
      const merged: PolylandState = { version: 1, updatedAt: Date.now() };
      for (const row of rows) {
        const ns = String(row.namespace);
        if ((NAMESPACES as readonly string[]).includes(ns)) {
          const value = JSON.parse(String(row.payload));
          (merged as unknown as Record<string, unknown>)[ns] = value;
        }
      }
      this.current = merged;
      return merged;
    } catch {
      return null;
    }
  }

  async save(patch: Partial<Omit<PolylandState, 'version' | 'updatedAt'>>): Promise<void> {
    try {
      const db = this.ensureOpen();
      const stmt = db.prepare(`
        INSERT INTO state_kv (namespace, payload, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(namespace) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      `);
      const now = Date.now();
      this.current = { ...this.current, ...patch, updatedAt: now };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        stmt.run(key, JSON.stringify(value), now);
      }
    } catch (err) {
      // Persistence failure must not crash the trading loop; state stays
      // in memory and the next save retries.
      console.error('[SqliteStateStore] save failed:', err instanceof Error ? err.message : err);
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

/**
 * Factory: prefer SQLite when node:sqlite exists, else fall back to the
 * atomic JSON store. Never throws — the bot must boot regardless.
 */
export async function createStateStore(
  sqlitePath: string,
  jsonPath: string,
): Promise<{ store: StateStore; backend: 'sqlite' | 'json' }> {
  try {
    // Probe the runtime module before touching any file.
    await import('node:sqlite');
    return { store: new SqliteStateStore(sqlitePath), backend: 'sqlite' };
  } catch {
    const { JsonStateStore } = await import('./state-store.js');
    const store = new JsonStateStore(jsonPath);
    await store.load();
    return { store, backend: 'json' };
  }
}