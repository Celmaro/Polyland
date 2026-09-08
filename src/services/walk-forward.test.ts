/**
 * tests for src/services/walk-forward.ts — deterministic train/validation
 * splitting and config-fingerprint guards for threshold tuning.
 */
import { describe, it, expect } from 'vitest';
import { fingerprintConfig, splitWalkForward, validateWalkForward } from './walk-forward.js';

interface Rec { id: string; settledAt?: number }

const recs: Rec[] = [
  { id: 'c', settledAt: 300 },
  { id: 'a', settledAt: 100 },
  { id: 'd', settledAt: 400 },
  { id: 'b', settledAt: 200 },
];

describe('splitWalkForward', () => {
  it('splits deterministically in time order: first fraction trains, rest validates', () => {
    const a = splitWalkForward(recs, 0.5);
    const b = splitWalkForward(recs, 0.5);
    expect(a).toEqual(b); // deterministic
    expect(a.train.map((r) => r.id)).toEqual(['a', 'b']); // earliest two
    expect(a.validation.map((r) => r.id)).toEqual(['c', 'd']); // latest two
  });
  it('handles records missing settledAt deterministically (treated as earliest)', () => {
    const withMissing: Rec[] = [{ id: 'no-ts' }, ...recs]; // 5 records total
    const split = splitWalkForward(withMissing, 0.5); // floor(5*0.5) = 2 train
    expect(split.train.map((r) => r.id)).toContain('no-ts');
    expect(split.train).toHaveLength(2);
    expect(split.validation).toHaveLength(3);
  });
  it('returns empty validation when trainFraction is 1 and empty train at 0 (bounds ok)', () => {
    expect(splitWalkForward(recs, 1).validation).toHaveLength(0);
    expect(splitWalkForward(recs, 0).train).toHaveLength(0);
  });
  it('throws on out-of-range trainFraction', () => {
    expect(() => splitWalkForward(recs, 1.5)).toThrow();
    expect(() => splitWalkForward(recs, -0.1)).toThrow();
  });
});

describe('fingerprintConfig', () => {
  it('is stable for identical configs and key-order independent', () => {
    expect(fingerprintConfig({ a: 1, b: 'x' })).toBe(fingerprintConfig({ b: 'x', a: 1 }));
  });
  it('changes when any value changes', () => {
    expect(fingerprintConfig({ adverse: 0.35 })).not.toBe(fingerprintConfig({ adverse: 0.30 }));
  });
  it('handles nested objects and arrays deterministically', () => {
    const cfg = { quorum: { min: 3, tiers: ['PRIMARY', 'SATELLITE'] }, edge: 0.02 };
    expect(fingerprintConfig(cfg)).toBe(fingerprintConfig({ edge: 0.02, quorum: { tiers: ['PRIMARY', 'SATELLITE'], min: 3 } }));
  });
});

describe('validateWalkForward', () => {
  it('passes when train and validation use the same tuned config', () => {
    const fp = fingerprintConfig({ adverse: 0.35 });
    expect(validateWalkForward(fp, fp)).toEqual({ ok: true });
  });
  it('fails with a reason when the config fingerprint differs', () => {
    const result = validateWalkForward(
      fingerprintConfig({ adverse: 0.35 }),
      fingerprintConfig({ adverse: 0.30 }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('mismatch');
  });
});