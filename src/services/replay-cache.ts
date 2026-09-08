/** Durable, content-addressed cache for offline replay results. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ReplayConfig, ReplayResult } from './replay.js';

export interface ReplaySourceFingerprint {
  path: string;
  mtimeMs: number;
  size: number;
}

/** Hash every input that can change a replay result. */
export function replayFingerprint(config: ReplayConfig, source: ReplaySourceFingerprint): string {
  const payload = JSON.stringify({
    config: {
      exitConfig: config.exitConfig,
      stopLossPct: config.stopLossPct,
      takeProfitPct: config.takeProfitPct,
      maxHoldSeconds: config.maxHoldSeconds,
      slippageFlagThreshold: config.slippageFlagThreshold,
    },
    source: { path: basename(source.path), mtimeMs: source.mtimeMs, size: source.size },
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

export class ReplayFileCache {
  constructor(private readonly directory: string) {}

  private filePath(fingerprint: string): string {
    if (!/^[0-9a-f]{32}$/.test(fingerprint)) throw new Error('invalid replay cache fingerprint');
    return join(this.directory, `${fingerprint}.json`);
  }

  async load(fingerprint: string): Promise<ReplayResult | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath(fingerprint), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { entries?: unknown }).entries)) return null;
      return parsed as ReplayResult;
    } catch {
      return null;
    }
  }

  async save(fingerprint: string, result: ReplayResult): Promise<void> {
    const file = this.filePath(fingerprint);
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(result), 'utf8');
    await rename(temporary, file);
  }
}
