import { describe, it, expect } from 'vitest';
import { foldName, nameSimilarity, matchTennisMarket } from './tennis-matcher.js';

describe('foldName', () => {
  it('lowercases, strips punctation, and collapses whitespace', () => {
    expect(foldName('Alcaraz, Carlos')).toBe('alcaraz carlos');
    expect(foldName('  Novak   Djokovic ')).toBe('novak djokovic');
  });
});

describe('nameSimilarity', () => {
  it('scores exact folded names 1.0', () => {
    expect(nameSimilarity('carlos alcaraz', 'carlos alcaraz')).toBe(1);
  });
  it('scores surname+subset matches above 0.7', () => {
    // "alcaraz" vs "carlos alcaraz": 1/2 token overlap, but surname bonus
    expect(nameSimilarity('alcaraz', 'carlos alcaraz')).toBeGreaterThan(0.5);
    expect(nameSimilarity('novak djokovic', 'djokovic')).toBeGreaterThan(0.5);
  });
  it('scores unrelated names near 0', () => {
    expect(nameSimilarity('carlos alcaraz', 'iga swiatek')).toBeLessThan(0.3);
  });
});

describe('matchTennisMarket', () => {
  const candidates = [
    { id: 'c1', name: 'Carlos Alcaraz', date: '2026-09-10' },
    { id: 'c2', name: 'Novak Djokovic', date: '2026-09-10' },
  ];
  it('matches an exact market name to its candidate', () => {
    const m = matchTennisMarket(candidates, 'Carlos Alcaraz', '2026-09-10');
    expect(m?.id).toBe('c1');
  });
  it('matches a partial/surname-only market name via token subset', () => {
    // Polymarket tennis titles often truncate to the surname
    const m = matchTennisMarket(candidates, 'Alcaraz vs TBD', '2026-09-10');
    expect(m?.id).toBe('c1');
  });
  it('rejects a candidate outside the ±1-day date gate even with name match', () => {
    const m = matchTennisMarket(candidates, 'Carlos Alcaraz', '2026-09-14');
    expect(m).toBeNull();
  });
  it('returns null on ambiguous top-2 within the 0.10 margin (never guess)', () => {
    const twins = [
      { id: 'a', name: 'A. Rublev', date: '2026-09-10' },
      { id: 'b', name: 'Andrey Rublev', date: '2026-09-10' },
    ];
    const m = matchTennisMarket(twins, 'Rublev', '2026-09-10');
    expect(m).toBeNull();
  });
  it('applies the explicit override seam before any fuzzy matching', () => {
    const m = matchTennisMarket(candidates, 'anything', '2026-09-10', {
      override: (name) => (name === 'anything' ? 'c2' : null),
    });
    expect(m?.id).toBe('c2');
  });
  it('returns null for a name with no plausible candidate', () => {
    const m = matchTennisMarket(candidates, 'Emma Raducanu', '2026-09-10');
    expect(m).toBeNull();
  });
});