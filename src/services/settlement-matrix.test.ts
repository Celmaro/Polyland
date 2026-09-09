import { describe, it, expect } from 'vitest';
import { resolvePayout } from './settlement-matrix.js';

const plain = { closed: true, prices: [1, 0], outcomes: ['Yes', 'No'], slug: 'atp-2026-final' };
const halfSlug = 'atp-2026-final-walkover';
const itfSlug = 'itf-w15-x';

describe('resolvePayout', () => {
  it('plain closed market with pure prices → winner 1, loser 0', () => {
    const r = resolvePayout(plain);
    expect(r.kind).toBe('plain');
    expect(r.payoutByOutcome).toEqual({ Yes: 1, No: 0 });
  });

  it('non-plain tennis text + closed → half payout 0.5 for ALL outcomes', () => {
    const r = resolvePayout({
      closed: true,
      prices: [0.5, 0.5],
      outcomes: ['Yes', 'No'],
      slug: halfSlug,
      textHints: ['Carlos Alcaraz walkover'],
    });
    expect(r.kind).toBe('half_walkover');
    if (r.kind === 'half_walkover') expect(r.payoutByOutcome).toEqual({ Yes: 0.5, No: 0.5 });
  });

  it('tennis market closed with ambiguous prices and hint in slug → half', () => {
    const r = resolvePayout({ closed: true, prices: [0.52, 0.48], outcomes: ['A', 'B'], slug: itfSlug, textHints: ['retired'] });
    expect(r.kind).toBe('half_walkover');
    if (r.kind === 'half_walkover') expect(r.payoutByOutcome!.A).toBe(0.5);
  });

  it('non-tennis closed with non-pure prices → unresolved (never invent)', () => {
    const r = resolvePayout({ closed: true, prices: [0.51, 0.49], outcomes: ['Yes', 'No'], slug: 'presidential-election' });
    expect(r.kind).toBe('unresolved');
    expect(r.payout).toBeNull();
  });

  it('open market → unresolved', () => {
    const r = resolvePayout({ closed: false, prices: [0.6, 0.4], outcomes: ['Yes', 'No'], slug: plain.slug });
    expect(r.kind).toBe('unresolved');
  });

  it('closed tennis with non-plain text but NO closed confirmation in prices → unresolved (conservative)', () => {
    // Text hints exist but the market isn't confirmed closed → do not settle.
    const r = resolvePayout({ closed: false, prices: [0.5, 0.5], outcomes: ['Yes', 'No'], slug: halfSlug, textHints: ['walkover'] });
    expect(r.kind).toBe('unresolved');
  });
});