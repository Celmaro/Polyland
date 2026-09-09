/**
 * depth-replay-importer.ts — ingest vendor full-depth book snapshots
 * (probalytics.io / marketlens exports) into the replay-evaluator's
 * BookSnapshot shape, so historical depth can be replayed without holding
 * any vendor SDK in the runtime. This is the dataset Polyland's replay
 * engine was missing for thin-market tennis/ITF studies.
 */
import type { BookSnapshot } from './replay-evaluator.js';

export interface VendorBookLine {
  market_id: string;
  platform?: string;
  outcome?: { id?: string; name?: string; index?: number };
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  timestamp: string;
  state?: string;
  continuity?: string;
  [key: string]: unknown;
}

/**
 * Normalize one probalytics/marketlens JSON line to a BookSnapshot.
 * Null when the line is not a usable Polymarket book (foreign platform,
 * non-contiguous state, malformed JSON).
 */
export function parseVendorBookLine(line: string): BookSnapshot | null {
  let raw: VendorBookLine;
  try {
    raw = JSON.parse(line) as VendorBookLine;
  } catch {
    return null;
  }
  if (!raw || raw.platform !== 'POLYMARKET') return null;
  if (raw.continuity && raw.continuity !== 'CONTIGUOUS') return null;
  if (!Array.isArray(raw.asks) || !Array.isArray(raw.bids)) return null;
  const toLevels = (side: Array<{ price: number; size: number }>) =>
    side
      .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
      .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.size) && l.size > 0);
  const asks = toLevels(raw.asks);
  const bids = toLevels(raw.bids);
  if (asks.length === 0 || bids.length === 0) return null;
  const tsMs = Date.parse(raw.timestamp);
  return {
    asks,
    bids,
    minOrderSize: 0,
    tickSize: 0.01, // vendor exports quantize on the CLOB grid
    timestamp: Number.isFinite(tsMs) ? tsMs : Date.now(),
  };
}

/** Parse a multi-line vendor export; skipped = unusable lines. */
export function importVendorBookSnapshots(lines: string[]): { snapshots: BookSnapshot[]; skipped: number } {
  let skipped = 0;
  const snapshots: BookSnapshot[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const s = parseVendorBookLine(line);
    if (s) snapshots.push(s); else skipped++;
  }
  return { snapshots, skipped };
}