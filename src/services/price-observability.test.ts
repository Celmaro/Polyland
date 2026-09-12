import { describe, it, expect } from 'vitest';
import { priceBucket, emptyPriceHistogram, addPrice, formatPriceHistogram, PRICE_BUCKETS } from './price-observability.js';

describe('priceBucket boundaries', () => {
  it('maps below 0.20 to lt_020', () => {
    expect(priceBucket(0)).toBe('lt_020');
    expect(priceBucket(0.19)).toBe('lt_020');
  });
  it('maps 0.20..0.4999 to 020_050', () => {
    expect(priceBucket(0.2)).toBe('020_050');
    expect(priceBucket(0.499)).toBe('020_050');
  });
  it('maps 0.50..0.7999 to 050_080', () => {
    expect(priceBucket(0.5)).toBe('050_080');
    expect(priceBucket(0.799)).toBe('050_080');
  });
  it('maps 0.80..0.9499 to 080_095', () => {
    expect(priceBucket(0.8)).toBe('080_095');
    expect(priceBucket(0.949)).toBe('080_095');
  });
  it('maps >= 0.95 to gte_095', () => {
    expect(priceBucket(0.95)).toBe('gte_095');
    expect(priceBucket(0.99)).toBe('gte_095');
    expect(priceBucket(1.01)).toBe('gte_095');
  });
  it('maps NaN/infinity to lt_020 (fail-closed)', () => {
    expect(priceBucket(NaN)).toBe('lt_020');
    expect(priceBucket(Infinity)).toBe('lt_020');
  });
});

describe('histogram aggregation + formatting', () => {
  it('adds prices into correct buckets', () => {
    const h = emptyPriceHistogram();
    addPrice(h, 0.1);
    addPrice(h, 0.3);
    addPrice(h, 0.3);
    addPrice(h, 0.6);
    addPrice(h, 0.9);
    addPrice(h, 0.99);
    addPrice(h, 0.99);
    expect(h).toEqual({ lt_020: 1, '020_050': 2, '050_080': 1, '080_095': 1, gte_095: 2 });
  });
  it('formats deterministically in bucket order', () => {
    const h = emptyPriceHistogram();
    h.gte_095 = 3;
    h.lt_020 = 1;
    expect(formatPriceHistogram(h)).toBe('lt_020:1/020_050:0/050_080:0/080_095:0/gte_095:3');
    expect(PRICE_BUCKETS).toHaveLength(5);
  });
});
