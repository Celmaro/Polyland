import { describe, it, expect } from 'vitest';
import { classifyMarketArchetype } from './market-classify.js';

describe('classifyMarketArchetype', () => {
  it('classifies crypto up/down markets by up-or-down / updown tokens', () => {
    expect(classifyMarketArchetype('btc-up-or-down-september-8-2026-9pm-et')).toBe('updown');
    expect(classifyMarketArchetype('eth-updown-1788919500')).toBe('updown');
    expect(classifyMarketArchetype('bitcoin-up-or-down-september-8-2026')).toBe('updown');
  });
  it('classifies tennis via the existing tour classifier', () => {
    expect(classifyMarketArchetype('atp-rio-open-2026')).toBe('tennis');
    expect(classifyMarketArchetype('itf-w15-monastir')).toBe('tennis');
  });
  it('classifies elections', () => {
    expect(classifyMarketArchetype('who-wins-the-2028-presidential-election')).toBe('election');
    expect(classifyMarketArchetype('dutch-parliamentary-election-2026')).toBe('election');
  });
  it('classifies head-to-head sports matches', () => {
    expect(classifyMarketArchetype('carlos-alcaraz-vs-novak-djokovic')).toBe('sports_match');
    expect(classifyMarketArchetype('lakers-vs-celtics')).toBe('sports_match');
  });
  it('classifies time-bound markets by trailing epoch', () => {
    expect(classifyMarketArchetype('btc-100k-by-1788919500')).toBe('time_bound');
  });
  it('updown wins over the epoch rule (deliberate precedence)', () => {
    expect(classifyMarketArchetype('xrp-updown-1788919500')).toBe('updown');
  });
  it('returns other for culture/unknown slugs', () => {
    expect(classifyMarketArchetype('will-tame-impala-be-the-2-us-song-this-week-20260911')).toBe('other');
    expect(classifyMarketArchetype('')).toBe('other');
  });
});