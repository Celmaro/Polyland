import { describe, it, expect } from 'vitest';
import { scoreIntensity, volumeMultiplier, scoreTimeframes } from './intensity-scoring.js';

describe('volumeMultiplier (tremor scoring.ts:106-120)', () => {
  it('zeroes below $1k volume', () => {
    expect(volumeMultiplier(500)).toBe(0);
    expect(volumeMultiplier(999)).toBe(0);
  });
  it('scales 1k-10k with sqrt ramp capped at 1', () => {
    const m = volumeMultiplier(1000);
    expect(m).toBeGreaterThanOrEqual(0);
    expect(m).toBeLessThanOrEqual(1);
    expect(volumeMultiplier(10_000)).toBe(1);
    expect(volumeMultiplier(9_999)).toBeLessThan(1);
    expect(volumeMultiplier(50_000)).toBe(1);
  });
});

describe('scoreIntensity (tremor scoring.ts:143-205 bands)', () => {
  it('<1pp: score == absChange (full-volume multiplier)', () => {
    expect(scoreIntensity(0.4, 10_000)).toBeCloseTo(0.4, 6);
  });
  it('1-5pp: rounds to 1 decimal (1.875 → 1.9)', () => {
    expect(scoreIntensity(2, 10_000)).toBeCloseTo(1.9, 6);
  });
  it('5-10pp: 4.5 + (x-5)*0.5', () => {
    expect(scoreIntensity(6, 10000)).toBeCloseTo(5.0, 6);
  });
  it('10-20pp: 7 + (x-10)*0.3', () => {
    expect(scoreIntensity(15, 10000)).toBeCloseTo(8.5, 6);
  });
  it('>=20pp: 10', () => {
    expect(scoreIntensity(25, 10000)).toBe(10);
  });
  it('clamps to 0-10 and rounds to 1 decimal', () => {
    const s = scoreIntensity(2, 10000);
    expect(Number(s.toFixed(1))).toBe(s); // already rounded
    expect(scoreIntensity(30, 900)).toBe(0); // volume below floor zeroes even with huge move
  });
  it('zero volume yields 0 regardless of move', () => {
    expect(scoreIntensity(5, 0)).toBe(0);
  });
});

describe('scoreTimeframes (tremor scoring.ts:356-395)', () => {
  const t0 = 1_700_000_000_000;
  const ticks = [
    { price: 0.50, ts: t0 + 3_360_000 },
    { price: 0.51, ts: t0 + 3_420_000 },
    { price: 0.55, ts: t0 + 3_660_000 },   // +5pp in 5m window
    { price: 0.58, ts: t0 + 3_660_000 }, // +8pp in 1h
  ];
  it('computes 5m/1h intensity from windowed price change', () => {
    const s = scoreTimeframes(ticks, t0 + 3_660_000, { volumeUsd: 10_000 });
    // 5m window [t0+3360s, now]: first=0.50 (at cutoff) last=0.58 → +8pp
    expect(s.signedMove5m).toBeCloseTo(0.08, 6);
    expect(s.absChangePp5m).toBeCloseTo(8, 2);
    expect(s.intensity5m).toBeCloseTo(6.0, 2); // 4.5 + (8-5)*0.5
    expect(s.signedMove1h).toBeCloseTo(0.08, 6); // 0.50 → 0.58 across the hour
    expect(s.intensity1h).toBeCloseTo(6.0, 2);
    expect(s.intensity24h).toBeGreaterThanOrEqual(0);
  });
  it('sparse windows yield null intensity (not a guessed 0)', () => {
    const s = scoreTimeframes([{ price: 0.5, ts: t0 }], t0 + 60_000, { volumeUsd: 10_000 });
    expect(s.intensity5m).toBeNull();
    expect(s.intensity1h).toBeNull();
  });
});