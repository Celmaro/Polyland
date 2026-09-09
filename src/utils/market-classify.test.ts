import { describe, it, expect } from 'vitest';
import { classifyTennisTour, isTennisMarket, isNonPlainResolutionText } from './market-classify.js';

describe('classifyTennisTour', () => {
  it('classifies ATP/WTA/ITF/Challenger slugs', () => {
    expect(classifyTennisTour('atp-rio-open-2026')).toBe('atp');
    expect(classifyTennisTour('wta-indian-wells')).toBe('wta');
    expect(classifyTennisTour('itf-w15-monastir')).toBe('itf');
    expect(classifyTennisTour('challenger-st-remy')).toBe('challenger');
    expect(classifyTennisTour('ch-tenerife-2')).toBe('challenger');
  });
  it('handles the live tennis url pattern (tour-year-slug)', () => {
    expect(classifyTennisTour('atp-2026-carlos-alcaraz-vs-x')).toBe('atp');
  });
  it('returns other for non-tennis slugs', () => {
    expect(classifyTennisTour('will-btc-hit-100k')).toBe('other');
    expect(classifyTennisTour('crypto-updown-5m')).toBe('other');
    expect(classifyTennisTour('')).toBe('other');
  });
});

describe('isTennisMarket', () => {
  it('true for any classified tennis tour', () => {
    expect(isTennisMarket('itf-w15-x')).toBe(true);
    expect(isTennisMarket('wta-y')).toBe(true);
  });
  it('false for non-tennis', () => {
    expect(isTennisMarket('presidential-election')).toBe(false);
  });
});

describe('isNonPlainResolutionText', () => {
  it('flags walkover/retired/withdrew/abandoned texts', () => {
    for (const t of ['walkover', 'Walkover', 'retired', 'withdrew', 'abandoned', 'default']) {
      expect(isNonPlainResolutionText(`match ${t} result`)).toBe(true);
    }
  });
  it('does not flag plain outcomes', () => {
    expect(isNonPlainResolutionText('winner atp match')).toBe(false);
    expect(isNonPlainResolutionText('')).toBe(false);
  });
});