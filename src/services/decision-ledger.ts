/** Append-only, point-in-time decision ledger for confidence-aware trading. */
import { appendFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LedgerRecord } from './pipeline-types.js';
export interface DecisionLedgerOptions {
  path?: string;
  maxBytes?: number;
}
export class DecisionLedger {
  private readonly path: string;
  private readonly maxBytes: number;
  private writeChain: Promise<void> = Promise.resolve();
  private records: LedgerRecord[] = [];
  private corruptLines = 0;
  constructor(options: string | DecisionLedgerOptions = {}) {
    this.path = typeof options === 'string' ? options : options.path ?? './data/decision-ledger.jsonl';
    this.maxBytes = typeof options === 'string' ? 50 * 1024 * 1024 : options.maxBytes ?? 50 * 1024 * 1024;
  }
  /** Queue a durable append; ledger failures never affect the trading path. */
  append(record: LedgerRecord): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true });
        try {
          const info = await stat(this.path);
          if (info.size > this.maxBytes) {
            await unlink(`${this.path}.1`).catch(() => undefined);
            await rename(this.path, `${this.path}.1`).catch(() => undefined);
          }
        } catch { /* file does not exist yet */ }
        await appendFile(this.path, JSON.stringify(record) + '\n', 'utf8');
        this.records.push(record);
      } catch { /* observability must never break trading */ }
    }).catch(() => undefined);
    return this.writeChain;
  }
  async replay(): Promise<LedgerRecord[]> {
    await this.writeChain;
    try {
      const text = await readFile(this.path, 'utf8');
      const replayed: LedgerRecord[] = [];
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as LedgerRecord;
          if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') replayed.push(parsed);
          else this.corruptLines++;
        } catch { this.corruptLines++; }
      }
      this.records = replayed;
      return [...replayed];
    } catch { return [...this.records]; }
  }
  stats(): { total: number; accepted: number; rejectedByReason: Record<string, number> } {
    const rejectedByReason: Record<string, number> = {};
    for (const record of this.records) {
      if (!record.accepted) {
        const reason = record.rejectionReason ?? 'unknown';
        rejectedByReason[reason] = (rejectedByReason[reason] ?? 0) + 1;
      }
    }
    return { total: this.records.length, accepted: this.records.filter(r => r.accepted).length, rejectedByReason };
  }
  getCorruptLineCount(): number { return this.corruptLines; }
  async close(): Promise<void> { await this.writeChain; }
  async start(): Promise<LedgerRecord[]> {
    await this.writeChain;
    return this.replay();
  }
}
export function funnelFromStats(stats: {
  feedReceived: number;
  ignoredNoBasket: number;
  ignoredNotMember: number;
  ignoredUnsupportedSide: number;
  ignoredInvalidMarket: number;
  votesRecorded: number;
  quorumSkippedThinEdge: number;
  quorumSkippedStaleMarket: number;
}): { received: number; ignored: number; recorded: number; filtered: number; filteredThin: number; filteredStale: number } {
  const received = Math.max(0, stats.feedReceived);
  const ignored = Math.min(received, Math.max(0, stats.ignoredNoBasket + stats.ignoredNotMember + stats.ignoredUnsupportedSide + stats.ignoredInvalidMarket));
  const filteredThin = Math.max(0, stats.quorumSkippedThinEdge);
  const filteredStale = Math.max(0, stats.quorumSkippedStaleMarket);
  return { received, ignored, recorded: Math.max(0, stats.votesRecorded), filtered: filteredThin + filteredStale, filteredThin, filteredStale };
}
