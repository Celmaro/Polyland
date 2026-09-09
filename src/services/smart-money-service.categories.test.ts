import { describe, it, expect } from 'vitest';
import { categorizeMarket, CATEGORY_LABELS, type MarketCategory } from './smart-money-service.js';

describe('granular sports categorization', () => {
  it('routes tennis slugs to the tennis basket (not broad sports)', () => {
    expect(categorizeMarket('atp-rio-open-2026')).toBe('tennis');
    expect(categorizeMarket('will-alcaraz-win-wimbledon')).toBe('tennis');
    expect(categorizeMarket('itf-w15-monastir')).toBe('tennis');
  });
  it('routes football/soccer to the football basket', () => {
    expect(categorizeMarket('will-liverpool-win-the-premier-league')).toBe('football');
    expect(categorizeMarket('nfl-super-bowl-winner')).toBe('football');
    expect(categorizeMarket('champions-league-winner')).toBe('football');
  });
  it('routes basketball to basketball, boxing/ufc, motorsports, baseball, cricket', () => {
    expect(categorizeMarket('will-celtics-win-the-nba')).toBe('basketball');
    expect(categorizeMarket('ufc-fight-night-winner')).toBe('boxing_ufc');
    expect(categorizeMarket('will-boxer-ko-opponent')).toBe('boxing_ufc');
    expect(categorizeMarket('f1-monaco-gp-winner')).toBe('motorsports');
    expect(categorizeMarket('mlb-world-series-winner')).toBe('baseball');
    expect(categorizeMarket('ipl-2026-winner')).toBe('cricket');
  });
  it('keeps generic sports in the broad sports fallback', () => {
    expect(categorizeMarket('olympics-2028')).toBe('sports');
    expect(categorizeMarket('golf-masters-winner')).toBe('sports');
  });
  it('leaves crypto/politics/other intact', () => {
    expect(categorizeMarket('will-btc-hit-100k')).toBe('crypto');
    expect(categorizeMarket('who-wins-2028-election')).toBe('politics');
    expect(categorizeMarket('unknown-weird-thing')).toBe('other');
  });
});

describe('category labels', () => {
  it('has a label for every new basket', () => {
    const cats: MarketCategory[] = ['football', 'basketball', 'tennis', 'motorsports', 'boxing_ufc', 'baseball', 'cricket'];
    for (const c of cats) expect(CATEGORY_LABELS[c]).toBeTruthy();
  });
});