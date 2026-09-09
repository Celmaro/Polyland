/**
 * intensity-scoring.ts — Tremor-style multi-timeframe movement intensity.
 *
 * Adopted from sculptdotfun/tremor convex/scoring.ts:106-205 (bands) with a
 * critical correction: we do NOT approximate volume as $0.5 × shares — the
 * caller passes real USDC notional. Score is an ATTENTION feature, never a
 * standalone buy signal.
 */
export interface PriceTick { price: number; ts: number }
export const WINDOWS_MIN = { '5m': 5, '1h': 60, '24h': 1440 } as const;
export type IntensityWindow = keyof typeof WINDOWS_MIN;

/**
 * Tremor volume multiplier: <$1k → 0, $1k-$10k → sqrt((v-1000)/9000) capped 1,
 * >=$10k → 1.
 */
export function volumeMultiplier(usdVolume: number): number {
  if (!Number.isFinite(usdVolume) || usdVolume <= 0) return 0;
  if (usdVolume < 1_000) return 0;
  return Math.min(1, Math.sqrt((usdVolume - 1_000) / 9_000));
}

/**
 * Tremor movement bands (absChange in percentage points):
 *   <1 → absChange; 1-5 → 1+(x-1)*0.875; 5-10 → 4.5+(x-5)*0.5;
 *   10-20 → 7+(x-10)*0.3; >=20 → 10.
 * Rounded to 1 decimal, clamped 0-10.
 */
export function scoreIntensity(absChangePp: number, usdVolume: number): number {
  const mult = volumeMultiplier(usdVolume);
  if (mult <= 0) return 0;
  const x = Math.abs(absChangePp);
  let base: number;
  if (x < 1) base = x;
  else if (x < 5) base = 1 + (x - 1) * 0.875;
  else if (x < 10) base = 4.5 + (x - 5) * 0.5;
  else if (x < 20) base = 7 + (x - 10) * 0.3;
  else base = 10;
  return Number(Math.min(10, Math.max(0, base * mult)).toFixed(1));
}

export interface TimeframeScores {
  signedMove5m: number | null;
  absChangePp5m: number | null;
  intensity5m: number | null;
  signedMove1h: number | null;
  absChangePp1h: number | null;
  intensity1h: number | null;
  signedMove24h: number | null;
  absChangePp24h: number | null;
  intensity24h: number | null;
}

const WINDOW_MS = { '5m': 5 * 60_000, '1h': 3_600_000, '24h': 86_400_000 } as const;

/** Windowed intensity across the 5m/1h/24h timeframes. Sparse → null (never guess). */
export function scoreTimeframes(ticks: PriceTick[], now: number, opts: { volumeUsd?: number } = {}): TimeframeScores {
  if (ticks.length < 2) return { signedMove5m: null, absChangePp5m: null, intensity5m: null, signedMove1h: null, absChangePp1h: null, intensity1h: null, signedMove24h: null, absChangePp24h: null, intensity24h: null };
  const out: TimeframeScores = { signedMove5m: null, absChangePp5m: null, intensity5m: null, signedMove1h: null, absChangePp1h: null, intensity1h: null, signedMove24h: null, absChangePp24h: null, intensity24h: null };
  // Volume unknown → full movement score (multiplier 1); the caller that
  // knows real notional passes it and gets the volume-scaled score.
  const volume = opts.volumeUsd ?? 10_000;
  const windowFor = (label: IntensityWindow): { signed: number | null; pp: number | null } => {
    const cutoff = now - WINDOW_MS[label];
    const inWindow = ticks.filter((t) => t.ts >= cutoff && t.ts <= now);
    if (inWindow.length < 2 || inWindow[0].price <= 0) return { signed: null, pp: null };
    const first = inWindow[0].price;
    const last = inWindow[inWindow.length - 1].price;
    const pp = Math.abs(last - first) * 100;
    return { signed: last - first, pp };
  };
  const set = (key: '5m' | '1h' | '24h') => {
    const w = windowFor(key);
    const signedK = (key === '5m' ? 'signedMove5m' : key === '1h' ? 'signedMove1h' : 'signedMove24h') as keyof TimeframeScores;
    const ppK = (key === '5m' ? 'absChangePp5m' : key === '1h' ? 'absChangePp1h' : 'absChangePp24h') as keyof TimeframeScores;
    const intK = (key === '5m' ? 'intensity5m' : key === '1h' ? 'intensity1h' : 'intensity24h') as keyof TimeframeScores;
    out[signedK] = w.signed;
    out[ppK] = w.pp;
    out[intK] = w.pp === null ? null : scoreIntensity(w.pp, volume);
  };
  set('5m'); set('1h'); set('24h');
  return out;
}