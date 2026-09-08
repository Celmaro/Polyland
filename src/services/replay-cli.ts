/**
 * replay-cli.ts — run replaySettlements against a JSONL signal-audit file.
 *
 * Usage:
 *   npx tsx src/services/replay-cli.ts data/signal-audit.jsonl
 *   npx tsx src/services/replay-cli.ts data/signal-audit.jsonl --profile=aggressive
 *
 * No exchange connectivity. Pure offline backtest. Output is JSON,
 * pipeable into jq for "which categories would the new exit logic
 * have improved?" queries.
 *
 * Results are cached by content fingerprint (config + source stat) under
 * data/replay-cache/ (override with REPLAY_CACHE_DIR), so re-running the
 * same profile against an unchanged data file skips the recompute.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { replaySettlements, REPLAY_DIAGNOSTIC_MODE, type ReplayConfig } from './replay.js';
import { replayFingerprint, ReplayFileCache } from './replay-cache.js';
import type { FiredSignal } from './signal-audit-store.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: replay-cli <jsonl-file> [--profile=audit|aggressive|conservative]');
    process.exit(1);
  }
  const profileArg = args.find((a) => a.startsWith('--profile='));
  const profile = (profileArg?.split('=')[1] as 'audit' | 'aggressive' | 'conservative') ?? 'audit';

  const fullPath = path.resolve(file);
  if (!fs.existsSync(fullPath)) {
    console.error(`not found: ${fullPath}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(fullPath, 'utf-8').split('\n').filter(Boolean);
  const signals: FiredSignal[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && obj.id && obj.conditionId) {
        signals.push(obj as FiredSignal);
      }
    } catch {
      // skip malformed line
    }
  }

  const config: ReplayConfig = { exitConfig: profile };
  // Content-addressed cache: same config + same data file → same digest →
  // skip the recompute. Any change to profile/parameters or the JSONL
  // (mtime/size) invalidates the entry and re-runs.
  const cacheDir = process.env.REPLAY_CACHE_DIR ?? path.join('data', 'replay-cache');
  const cache = new ReplayFileCache(cacheDir);
  const stat = fs.statSync(fullPath);
  const fingerprint = replayFingerprint(config, {
    path: fullPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  });

  const cached = await cache.load(fingerprint);
  const source = cached ?? replaySettlements(signals, config);
  if (!cached) await cache.save(fingerprint, source);

  console.log(JSON.stringify({
    cached: cached !== null,
    fingerprint,
    input: { file: fullPath, total: signals.length, settled: source.entries.length, profile },
    summary: {
      totalRecorded: source.totalRecorded,
      totalSimulated: source.totalSimulated,
      totalDelta: source.totalDelta,
      slippageFlags: source.slippageFlags,
    },
    byCategory: source.byCategory,
    topSlippageEntries: source.entries
      .filter((e) => e.slippageFlag)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 10),
  }, null, 2));
}

main().catch((err) => {
  console.error('replay-cli failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
