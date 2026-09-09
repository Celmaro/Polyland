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

describe('resolvePayout generalized to all markets (description-rule scanning)', () => {
  it('politics: candidate withdrawal + stated 50-50 rule → half payout', () => {
    const r = resolvePayout({
      closed: true, prices: [0.48, 0.52], outcomes: ['Yes', 'No'],
      slug: 'who-wins-the-2028-presidential-election',
      textHints: ['If a candidate withdraws before the election, this market resolves 50-50'],
    });
    expect(r.kind).toBe('half_walkover');
    if (r.kind === 'half_walkover') expect(r.payoutByOutcome!.Yes).toBe(0.5);
  });

  it('politics: candidate withdrawal WITHOUT a stated rule → unresolved (never guess)', () => {
    const r = resolvePayout({
      closed: true, prices: [0.55, 0.45], outcomes: ['Yes', 'No'],
      slug: 'who-wins-the-2028-presidential-election',
      textHints: ['candidate withdrew from the race'],
    });
    expect(r.kind).toBe('unresolved');
    expect(r.payout).toBeNull();
  });

  it('sports: abandoned match with stated void rule → void (payout 0)', () => {
    const r = resolvePayout({
      closed: true, prices: [0.5, 0.5], outcomes: ['Team A', 'Team B'],
      slug: 'lakers-vs-celtics',
      textHints: ['Match cancelled — market resolves to no, positions void'],
    });
    expect(r.kind).toBe('void');
    if (r.kind === 'void') expect(r.payout).toBe(0);
  });

  it('crypto: oracle no-price + stated split rule → half via extraRules', () => {
    const r = resolvePayout({
      closed: true, prices: [0.49, 0.51], outcomes: ['Yes', 'No'],
      slug: 'btc-up-or-down-september-8-2026-9pm-et',
      textHints: ['If no reference price is published, the pot is split'],
      extraRules: [{ pattern: /pot is split/i, payout: 0.5, label: 'split pot' }],
    });
    expect(r.kind).toBe('half_walkover');
    if (r.kind === 'half_walkover') expect(r.payoutByOutcome!.No).toBe(0.5);
  });

  it('non-tennis non-plain text with no rule and non-pure prices → unresolved', () => {
    const r = resolvePayout({
      closed: true, prices: [0.6, 0.4], outcomes: ['Yes', 'No'],
      slug: 'will-tame-impala-be-the-2-us-song-this-week-20260911',
      textHints: ['default'],
    });
    expect(r.kind).toBe('unresolved');
  });
});