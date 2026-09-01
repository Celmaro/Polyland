/**
 * ActivityCache
 *
 * File-backed cache for `walletService.getWalletActivity(addr, N)` results.
 * Polymarket's data API returns the same wallet's recent activity repeatedly
 * when running the screening refresh every few hours — there's no reason
 * to re-fetch what we already have. This cache writes JSON keyed by
 * address, with a per-record TTL (default 7 days).
 *
 * Tradeoff vs SQLite: same as VoteStateStore — JSON is enough for a few
 * hundred wallets and trivially debuggable. Migrate later if needed.
 *
 * ==== Wiring ====
 *   const cache = new ActivityCache('./var/activity-cache.json', {
 *     ttlMs: 7 * 24 * 3600_000,
 *   });
 *   await cache.load();
 *
 *   // In the screening inference path:
 *   let activity = cache.get(address);
 *   if (!activity) {
 *     activity = await walletService.getWalletActivity(address, 50);
 *     cache.set(address, activity);
 *     await cache.save();  // debounced
 *   }
 */

import { existsSync, mkdirSync, renameSync, promises as fsp } from 'node:fs';
import { dirname } from 'node:path';

// ============================================================================
// Shape
// ============================================================================

interface CacheEntry<T> {
  cachedAt: number;
  expiresAt: number;
  data: T;
}

interface PersistedCache {
  version: number;
  savedAt: number;
  entries: Record<string, CacheEntry<unknown>>;
}

const CACHE_VERSION = 1;

// ============================================================================
// Cache
// ============================================================================

export interface ActivityCacheConfig {
  /** Per-entry TTL in ms (default 7 days) */
  ttlMs: number;
}

export const DEFAULT_ACTIVITY_CACHE_CONFIG: ActivityCacheConfig = {
  ttlMs: 7 * 24 * 3600_000,
};

export class ActivityCache {
  private filePath: string;
  private config: ActivityCacheConfig;
  private entries: Map<string, CacheEntry<unknown>> = new Map();
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath: string, config: Partial<ActivityCacheConfig> = {}) {
    this.filePath = filePath;
    this.config = { ...DEFAULT_ACTIVITY_CACHE_CONFIG, ...config };
  }

  async load(): Promise<void> {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedCache;
      if (parsed.version !== CACHE_VERSION) {
        console.warn(
          `[ActivityCache] version mismatch (file=${parsed.version}, current=${CACHE_VERSION}), discarding`
        );
        return;
      }
      this.entries.clear();
      for (const [k, v] of Object.entries(parsed.entries ?? {})) {
        this.entries.set(k, v as CacheEntry<unknown>);
      }
    } catch (err) {
      console.warn(
        `[ActivityCache] load failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Read a cached entry. Returns null if missing or expired. */
  get<T>(address: string): T | null {
    const e = this.entries.get(address.toLowerCase());
    if (!e) return null;
    if (e.expiresAt < Date.now()) {
      this.entries.delete(address.toLowerCase());
      return null;
    }
    return e.data as T;
  }

  /** Store an entry. */
  set<T>(address: string, data: T): void {
    const now = Date.now();
    this.entries.set(address.toLowerCase(), {
      cachedAt: now,
      expiresAt: now + this.config.ttlMs,
      data,
    });
    this._scheduleSave();
  }

  /** Schedule a debounced save (5s). */
  private _scheduleSave(): void {
    if (this._saveTimer !== null) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this.save().catch((err) => {
        console.warn(
          `[ActivityCache] save failed:`,
          err instanceof Error ? err.message : err,
        );
      });
      this._saveTimer = null;
    }, 5000);
  }

  /** Flush pending writes to disk (atomic). */
  async save(): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload: PersistedCache = {
      version: CACHE_VERSION,
      savedAt: Date.now(),
      entries: Object.fromEntries(this.entries.entries()),
    };
    const tmp = this.filePath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(payload), 'utf8');
    renameSync(tmp, this.filePath);
  }

  /** Stats: how many entries, how many expired. */
  stats(): { total: number; expired: number } {
    const now = Date.now();
    let expired = 0;
    for (const [, e] of this.entries) {
      if (e.expiresAt < now) expired++;
    }
    return { total: this.entries.size, expired };
  }
}