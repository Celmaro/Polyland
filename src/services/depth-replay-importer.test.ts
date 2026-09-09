import { describe, it, expect } from 'vitest';
import { parseVendorBookLine, importVendorBookSnapshots } from './depth-replay-importer.js';

const SAMPLE = JSON.stringify({
  market_id: '5cf13c3d-1125-5e87-b884-f6efb8225d01',
  market_platform_id: '0x8daabfd5d224e3859d81fe98800bc395e0baa747edec4e599a316246f4a51bf4',
  platform: 'POLYMARKET',
  outcome: { id: 'o1', name: 'Yes', index: 0 },
  bids: [{ price: 0.51, size: 10 }, { price: 0.50, size: 124 }],
  asks: [{ price: 0.53, size: 71 }, { price: 0.54, size: 199 }],
  timestamp: '2026-08-28 14:05:00.001000000',
  indexed_at: '2026-08-28 14:05:00.381112362',
  state: 'INTERMEDIATE',
  continuity: 'CONTIGUOUS',
});

describe('parseVendorBookLine (probalytics schema)', () => {
  it('normalizes a line to a replay-evaluator BookSnapshot', () => {
    const b = parseVendorBookLine(SAMPLE);
    expect(b).not.toBeNull();
    expect(b!.asks[0]).toEqual({ price: 0.53, size: 71 });
    expect(b!.bids[0]).toEqual({ price: 0.51, size: 10 });
    expect(b!.minOrderSize).toBe(0);
    expect(b!.tickSize).toBe(0.01);
    expect(typeof b!.timestamp).toBe('number');
  });
  it('skips non-POLYMARKET lines and non-contiguous state', () => {
    expect(parseVendorBookLine(JSON.stringify({ ...JSON.parse(SAMPLE), platform: 'KALSHI' }))).toBeNull();
    expect(parseVendorBookLine(JSON.stringify({ ...JSON.parse(SAMPLE), continuity: 'GAPPED' }))).toBeNull();
  });
  it('returns null for malformed JSON', () => {
    expect(parseVendorBookLine('{bad')).toBeNull();
  });
});

describe('importVendorBookSnapshots', () => {
  it('parses a multi-line export preserving order', () => {
    const lines = [SAMPLE, SAMPLE, '{bad', JSON.stringify({ ...JSON.parse(SAMPLE), platform: 'KALSHI' })];
    const { snapshots, skipped } = importVendorBookSnapshots(lines);
    expect(snapshots).toHaveLength(2);
    expect(skipped).toBe(2);
  });
});