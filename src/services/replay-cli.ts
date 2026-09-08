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
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { replaySettlements, type ReplayConfig } from './replay.js';
import type { FiredSignal } from './signal-audit-store.js';

function main(): void {
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
  const result = replaySettlements(signals, config);
  console.log(JSON.stringify({
    input: { file: fullPath, total: signals.length, settled: result.entries.length, profile },
    summary: {
      totalRecorded: result.totalRecorded,
      totalSimulated: result.totalSimulated,
      totalDelta: result.totalDelta,
      slippageFlags: result.slippageFlags,
    },
    byCategory: result.byCategory,
    topSlippageEntries: result.entries
      .filter((e) => e.slippageFlag)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 10),
  }, null, 2));
}

main();
