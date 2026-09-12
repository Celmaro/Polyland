export const PRICE_BUCKETS = ['lt_020', '020_050', '050_080', '080_095', 'gte_095'] as const;
export type PriceBucket = (typeof PRICE_BUCKETS)[number];
export type PriceHistogram = Record<PriceBucket, number>;

export function emptyPriceHistogram(): PriceHistogram {
  return { lt_020: 0, '020_050': 0, '050_080': 0, '080_095': 0, gte_095: 0 };
}

export function priceBucket(price: number): PriceBucket {
  if (!Number.isFinite(price) || price < 0.2) return 'lt_020';
  if (price < 0.5) return '020_050';
  if (price < 0.8) return '050_080';
  if (price < 0.95) return '080_095';
  return 'gte_095';
}

export function addPrice(histogram: PriceHistogram, price: number): void {
  histogram[priceBucket(price)] += 1;
}

export function formatPriceHistogram(histogram: PriceHistogram): string {
  return PRICE_BUCKETS.map((bucket) => `${bucket}:${histogram[bucket]}`).join('/');
}
