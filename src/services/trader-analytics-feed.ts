/**
 * trader-analytics-feed.ts — second-source wallet screening evidence
 * (polymarketanalytics / predictfolio snapshot input).
 *
 * The runtime screening (smart-money-service) scores wallets from on-chain
 * trade history. This module blends a snapshot from a trader-analytics
 * vendor (24h/7d/14d PnL, win rate, gains/losses) as a calibration signal —
 * only when the sample is large enough to trust. Never a hard gate.
 */

export interface TraderAnalyticsSnapshot {
  wallet: string;
  totalPnl?: number;
  pnl24h?: number;
  pnl7d?: number;
  pnl14d?: number;
  winRate?: number;
  gains14d?: number;
  losses14d?: number;
  trades14d?: number;
}

export interface TraderEvidence {
  pnlScore: number;
  winRateScore: number;
  consistencyScore: number;
  composite: number;
}

/**
 * Normalize raw PnL to [0,1]: positive up to a $100k diminishing cap,
 * negative floor at 0.
 */
function pnlScore(pnl: number | undefined): number {
  if (pnl === undefined) return 0;
  return Math.min(1, Math.max(0, pnl / 100_000));
}

/** Score on-chain evidence; zero when there is no sample at all. */
export function scoreTraderEvidence(s: TraderAnalyticsSnapshot): TraderEvidence {
  const trades = s.trades14d ?? 0;
  const wins = s.gains14d ?? 0;
  const losses = s.losses14d ?? 0;
  const pnl = pnlScore(s.totalPnl ?? (s.pnl14d ?? 0));
  const winRateScore = ((s.winRate ?? 0) > 0) ? Math.min(1, (s.winRate ?? 0) * 2 - 0.5) : 0;
  const consistencyScore = trades > 0 ? Math.min(1, Math.log1p(trades) / Math.log1p(500)) : 0;
  if (trades === 0 && (s.totalPnl ?? 0) === 0) return { pnlScore: 0, winRateScore: 0, consistencyScore: 0, composite: 0 };
  const composite = Math.max(0, Math.min(1, pnl * 0.5 + winRateScore * 0.3 + consistencyScore * 0.2));
  return { pnlScore: pnl, winRateScore, consistencyScore, composite };
}

export interface MergeOptions {
  /** Minimum secondary sample size to trust the blend (default 20). */
  minSampleSize?: number;
  /** How much the secondary evidence moves the primary score (default 0.1). */
  weight?: number;
}

export interface MergedScore {
  blended: number;
  adjusted: boolean;
  primaryScore: number;
  secondaryComposite: number;
}

/** Blend primary (0-100) with secondary evidence; skip small samples. */
export function mergeEvidence(
  primary: { score: number; source: string },
  secondary: { evidence: TraderEvidence; source: string; sampleSize: number },
  options: MergeOptions = {},
): MergedScore {
  const minSample = options.minSampleSize ?? 20;
  const weight = options.weight ?? 0.1;
  if (secondary.sampleSize < minSample) {
    return { blended: primary.score, adjusted: false, primaryScore: primary.score, secondaryComposite: secondary.evidence.composite };
  }
  const blended = Math.max(0, Math.min(100, primary.score * (1 - weight) + secondary.evidence.composite * 100 * weight));
  return { blended, adjusted: true, primaryScore: primary.score, secondaryComposite: secondary.evidence.composite };
}