/**
 * VoteStateStore
 *
 * File-backed persistence for the BasketQuorumService in-memory vote map
 * and last-fired timestamps. Saves to JSON on every state change, loads
 * from JSON on startup.
 *
 * Why JSON, not SQLite? skharchikov uses Postgres for durability, but for
 * a single-basket bot the data is small (votes by conditionId → outcome
 * → wallet, plus a flat lastFired map) and JSON gives us:
 *   - atomic writes via tmp+rename
 *   - zero deps
 *   - human-readable for debugging
 *   - cheap to migrate if we ever want sqlite
 *
 * ==== Wiring ====
 *   const store = new VoteStateStore('./var/basket-state.json');
 *   await store.load();   // populates this.votes, this.lastFired
 *   // ... use the data ...
 *   await store.save();   // persists after every change
 */

import { existsSync, mkdirSync, renameSync, promises as fsp } from 'node:fs';
import { dirname } from 'node:path';

// ============================================================================
// Shape (kept in sync with BasketQuorumService internals)
// ============================================================================

interface PersistedVote {
  wallet: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  timestamp: number;
  tier: 'PRIMARY' | 'SATELLITE';
}

interface PersistedState {
  version: number;
  savedAt: number;
  // conditionId -> outcome -> wallet -> Vote
  votes: Record<string, Record<string, Record<string, PersistedVote>>>;
  // conditionId:outcome -> last fired ms
  lastFired: Record<string, number>;
}

const STATE_VERSION = 1;

// ============================================================================
// Store
// ============================================================================

export class VoteStateStore {
  private filePath: string;
  private _votes: Map<string, Map<string, Map<string, PersistedVote>>> = new Map();
  private _lastFired: Map<string, number> = new Map();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Load from disk. Missing file = empty state. */
  async load(): Promise<void> {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed.version !== STATE_VERSION) {
        console.warn(
          `[VoteStateStore] version mismatch (file=${parsed.version}, current=${STATE_VERSION}), discarding`
        );
        return;
      }
      // Hydrate votes
      this._votes.clear();
      for (const [cid, byOutcome] of Object.entries(parsed.votes ?? {})) {
        const outcomeMap = new Map<string, Map<string, PersistedVote>>();
        for (const [outcome, byWallet] of Object.entries(byOutcome)) {
          const walletMap = new Map<string, PersistedVote>();
          for (const [wallet, vote] of Object.entries(byWallet)) {
            walletMap.set(wallet, vote);
          }
          outcomeMap.set(outcome, walletMap);
        }
        this._votes.set(cid, outcomeMap);
      }
      // Hydrate lastFired
      this._lastFired.clear();
      for (const [key, ts] of Object.entries(parsed.lastFired ?? {})) {
        this._lastFired.set(key, ts);
      }
    } catch (err) {
      console.warn(
        `[VoteStateStore] load failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Save to disk atomically (write tmp, rename). */
  async save(): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const state: PersistedState = {
      version: STATE_VERSION,
      savedAt: Date.now(),
      votes: Object.fromEntries(
        [...this._votes.entries()].map(([cid, byOutcome]) => [
          cid,
          Object.fromEntries(
            [...byOutcome.entries()].map(([outcome, byWallet]) => [
              outcome,
              Object.fromEntries([...byWallet.entries()]),
            ]),
          ),
        ]),
      ),
      lastFired: Object.fromEntries(this._lastFired.entries()),
    };
    const tmp = this.filePath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(state), 'utf8');
    renameSync(tmp, this.filePath);
  }

  /**
   * Walk every persisted vote and remove entries older than maxAgeMs.
   * Use this on load to drop the votes that already aged out, so the
   * bot doesn't carry stale consensus state across restarts.
   */
  pruneStale(maxAgeMs: number): number {
    const now = Date.now();
    let pruned = 0;
    for (const [, byOutcome] of this._votes) {
      for (const [, byWallet] of byOutcome) {
        for (const [wallet, vote] of byWallet) {
          if (now - vote.timestamp > maxAgeMs) {
            byWallet.delete(wallet);
            pruned++;
          }
        }
      }
    }
    return pruned;
  }

  get votes() {
    return this._votes;
  }

  get lastFired() {
    return this._lastFired;
  }
}
