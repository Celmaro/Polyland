/**
 * Execution-quality helpers (D1–D5): entry-quality score, graded sizing,
 * R-normalized sizing, post-entry microstructure invalidation, trailing
 * TP/SL, and effective stop-loss. Pure/stateless except trailing state.
 */

/** D1 — weighted 0-100 entry-quality score. */
export function computeEntryQualityScore(params: {
  signalEdgeBps: number;
  spreadBps: number | null;
  minTopDepth: number | null;
  ageSeconds: number;
  weights: { edge: number; spread: number; depth: number; freshness: number };
  edgeFloorBps?: number;
  edgeFullBps?: number;
  maxSpreadBps?: number;
  minTopOfBookShares?: number;
  maxAgeSeconds?: number;
}): { score: number; edgeScore: number; spreadScore: number; depthScore: number; freshnessScore: number; spreadBps: number | null; ageSeconds: number } {
  const { signalEdgeBps, spreadBps, minTopDepth, ageSeconds, weights } = params;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const edgeFloor = params.edgeFloorBps ?? 100;
  const edgeFull = params.edgeFullBps ?? 250;
  const maxSpread = params.maxSpreadBps ?? 600;
  const minDepth = params.minTopOfBookShares ?? 100;
  const maxAge = params.maxAgeSeconds ?? 1800;

  const edgeScore = clamp01((signalEdgeBps - edgeFloor) / Math.max(1, edgeFull - edgeFloor));
  const spreadScore = spreadBps === null || spreadBps <= 0 ? 0.5 : clamp01(1 - spreadBps / Math.max(1, maxSpread));
  const depthScore = minTopDepth === null || minTopDepth <= 0 ? 0.5 : clamp01(minTopDepth / Math.min(minDepth, Math.max(0.0001, minDepth)));
  const freshnessScore = clamp01(1 - ageSeconds / Math.max(1, maxAge));
  const sum = weights.edge + weights.spread + weights.depth + weights.freshness || 1;
  const score01 =
    (edgeScore * weights.edge +
      spreadScore * weights.spread +
      depthScore * weights.depth +
      freshnessScore * weights.freshness) /
    sum;
  return {
    score: score01 * 100,
    edgeScore,
    spreadScore,
    depthScore,
    freshnessScore,
    spreadBps,
    ageSeconds,
  };
}

/** D1 — graded sizing: full at full-edge band, half otherwise. */
export function resolveEdgeSizeMultiplier(signalEdgeBps: number, params: { fullBps: number; floorBps: number }): { multiplier: number; tier: 'full' | 'half' } {
  return signalEdgeBps >= params.fullBps
    ? { multiplier: 1, tier: 'full' }
    : { multiplier: 0.5, tier: 'half' };
}

/** D2 — R-normalized sizing: cap so loss-to-stop ≈ fixed risk budget. */
export function applyRiskAdjustedAmount(params: {
  baseUsdc: number;
  entryPrice: number;
  stopLossPrice: number;
  targetRiskUsdc: number;
}): { amountUsdc: number; adjusted: boolean; riskPct: number | null } {
  const { baseUsdc, entryPrice, stopLossPrice, targetRiskUsdc } = params;
  if (!(baseUsdc > 0) || !(entryPrice > 0) || !(targetRiskUsdc > 0)) {
    return { amountUsdc: baseUsdc, adjusted: false, riskPct: null };
  }
  const riskPct = entryPrice > 0 ? (entryPrice - stopLossPrice) / entryPrice : null;
  if (riskPct === null || !(riskPct > 0)) return { amountUsdc: baseUsdc, adjusted: false, riskPct };
  const capByRisk = targetRiskUsdc / riskPct;
  const adjusted = Math.max(0.01, Math.min(baseUsdc, capByRisk));
  return adjusted >= baseUsdc
    ? { amountUsdc: baseUsdc, adjusted: false, riskPct }
    : { amountUsdc: adjusted, adjusted: true, riskPct };
}

/** D3 — invalidate a post-entry position when spread/depth degrade for N ticks. */
export function shouldPostEntryInvalidate(params: {
  spreadBps: number;
  minTopDepth: number | null;
  maxSpreadBps: number;
  minTopOfBookShares: number;
  confirmationTicks: number;
  tick: number;
}): boolean {
  const { spreadBps, minTopDepth, maxSpreadBps, minTopOfBookShares, confirmationTicks, tick } = params;
  const badSpread = spreadBps > maxSpreadBps;
  const badDepth = minTopDepth !== null && minTopDepth < minTopOfBookShares;
  // Confirmed degradation (tick count reached) AND the condition holds now.
  if (!badSpread && !badDepth) return false;
  return tick >= confirmationTicks;
}

/** D4 — trailing take-profit / stop-loss state. */
export interface TrailingExit {
  armed: boolean;
  stage: number;
  trailingStopPrice: number | null;
}
export function trailingExitState(params: {
  entry: number;
  current: number;
  peak: number;
  minHoldMs: number;
  holdMs: number;
  armProfitPct: number;
  stage1GivebackPct: number;
  stage2TriggerPct: number;
  stage2GivebackPct: number;
}): TrailingExit {
  const { entry, current, peak, minHoldMs, holdMs, armProfitPct, stage1GivebackPct, stage2TriggerPct, stage2GivebackPct } = params;
  if (holdMs < minHoldMs || current <= entry) return { armed: false, stage: 0, trailingStopPrice: null };
  const profitPct = (current - entry) / entry;
  let stage = 0;
  if (profitPct >= armProfitPct) stage = 1;
  if (profitPct >= stage2TriggerPct) stage = 2;
  if (stage === 0) return { armed: false, stage: 0, trailingStopPrice: null };
  const giveback = stage >= 2 ? stage2GivebackPct : stage1GivebackPct;
  // trailing stop = peak - giveback of the profit run
  const trailingStopPrice = peak * (1 - giveback);
  return { armed: true, stage, trailingStopPrice };
}

/** D5 — effective stop-loss: relative with absolute floor + high-price scaling. */
export function effectiveStopLoss(params: {
  entryPrice: number;
  stopPct: number;
  absoluteFloor?: number;
  highPriceThreshold?: number;
  highPricePct?: number;
}): number {
  const { entryPrice, stopPct } = params;
  const isHigh = params.highPriceThreshold !== undefined && params.highPriceThreshold > 0 && entryPrice >= params.highPriceThreshold;
  const stopPctEffective = isHigh && params.highPricePct !== undefined ? params.highPricePct : stopPct;
  const relative = entryPrice * (1 - stopPctEffective);
  if (params.absoluteFloor === undefined || params.absoluteFloor <= 0) return clamp(relative);
  if (params.absoluteFloor >= entryPrice) return clamp(relative);
  return clamp(Math.max(relative, params.absoluteFloor));

  function clamp(p: number): number {
    const t = 0.01;
    return Math.max(t, Math.min(1 - t, p));
  }
}