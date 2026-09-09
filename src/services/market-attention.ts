/**
 * market-attention.ts — hot/warm/cold attention tiering (tremor adapt).
 *
 * Adopted from sculptdotfun/tremor: markets.ts:60-72 (tier by 24h volume)
 * + prioritization.ts:37-78 (points: volume/volatility/spread/recency) +
 * crons.ts:6-24 (per-tier intervals). Corrected: we do NOT trust the
 * approximate volume — callers pass real notional; and the cold tier is a
 * first-class LOW-FREQUENCY sweep (tremor never wired a cold cron).
 */
export type AttentionTier = 'hot' | 'warm' | 'cold';

export interface AttentionInput {
  volume24h: number;
  tradeCount24h: number;
  spreadBps: number | null;
  depthUsd: number;
  /** 1h return volatility (std of simple returns). */
  vol1h: number | null;
  lastUpdateAgeMs: number;
}

export interface PriorityResult {
  tier: AttentionTier;
  points: number;
  details: { volume: number; volatility: number; spread: number; recency: number };
}

/** Tremor initial tier by 24h volume. */
export function classifyTier(volume24hUsd: number): AttentionTier {
  if (volume24hUsd > 50_000) return 'hot';
  if (volume24hUsd > 5_000) return 'warm';
  return 'cold';
}

/**
 * Dynamic priority points (tremor prioritization.ts:37-78):
 *   volume 5-40, 1h volatility 5-30, spread 5-20, recency up to 10.
 * hot >= 70, warm >= 40, else cold.
 */
export function promotePriority(input: AttentionInput): PriorityResult {
  const v = Math.max(0, input.volume24h);
  let volume = 0;
  if (v >= 100_000) volume = 40; else if (v >= 50_000) volume = 30; else if (v >= 10_000) volume = 20; else if (v >= 5_000) volume = 10; else if (v >= 1_000) volume = 5;
  const vol = input.vol1h === null ? 0 : Math.min(30, Math.round(input.vol1h * 300));
  const spread = input.spreadBps === null ? 10 : input.spreadBps <= 100 ? 20 : input.spreadBps <= 500 ? 10 : 5;
  const stalePenalty = Math.min(10, Math.floor(input.lastUpdateAgeMs / 60_000));
  const recency = 10 - stalePenalty;
  const points = volume + vol + spread + recency;
  return { tier: points >= 70 ? 'hot' : points >= 40 ? 'warm' : 'cold', points, details: { volume, volatility: vol, spread, recency } };
}

export function intervalForTier(tier: AttentionTier): number {
  switch (tier) {
    case 'hot': return 15_000;
    case 'warm': return 60_000;
    case 'cold': return 300_000;
  }
}