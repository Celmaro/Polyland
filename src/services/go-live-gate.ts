/**
 * Go-live gate for Polyland: locked forward paper validation.
 *
 * Turns settled paper signals (from SignalAuditStore / DecisionLedger) into a
 * GoLiveReport that an operator can read before ever switching DRY_RUN=false.
 * The gate is deliberately conservative: it never enables live trading by
 * itself; it only reports whether the pre-registered criteria are met.
 *
 * Statistical core:
 *  - net edge per settled signal = realizedEdge (already fee-adjusted by
 *    SignalAuditStore) minus a conservative follower-execution haircut;
 *  - clustered standard error by conditionId (event-family clustering),
 *    one-sided 95% LCB via z=1.645;
 *  - independence measured as distinct resolved conditionIds (markets), not
 *    raw signal count;
 *  - concentration = max domain share of deployed capital.
 */
/** One-sided confidence lower bound: mean - z * se (z=1.645 for 95%). */
function lcbEdge(mean: number, se: number, z = 1.645): number {
  if (!Number.isFinite(mean) || !Number.isFinite(se)) return Number.NaN;
  return mean - z * se;
}
export interface SettledSignalOutcome {
  id: string;
  conditionId: string;
  domain: string;
  firedAt: number;
  settledAt?: number;
  realizedEdge?: number; // fee-adjusted net edge of the settled signal
  deployedUsd: number;   // capital at risk for this signal
  resolved?: number;     // 0 | 1
}
export interface GoLiveCriteria {
  /** Minimum independent resolved markets (unique conditionIds). */
  minSettledSignals: number;
  /** Minimum distinct domains with settled signals. */
  minDomains: number;
  /** One-sided 95% LCB of mean net edge must exceed this (decimal, e.g. 0.0). */
  lcbEdgeMin: number;
  /** Maximum peak-to-trough drawdown on settled paper PnL (0-1). */
  maxDrawdownPct: number;
  /** Maximum share of deployed capital in one domain (0-1). */
  maxConcentrationPct: number;
  /** Minimum settlement-completion share (settled / fired). */
  minCompletionRate: number;
  /** Minimum span of the forward window (ms). */
  minWindowMs: number;
  /** Conservative follower-execution haircut applied to realized edge (bps). */
  executionHaircutBps: number;
}
export const DEFAULT_GO_LIVE_CRITERIA: GoLiveCriteria = {
  minSettledSignals: 30,
  minDomains: 2,
  lcbEdgeMin: 0,
  maxDrawdownPct: 0.25,
  maxConcentrationPct: 0.40,
  minCompletionRate: 0.80,
  minWindowMs: 7 * 24 * 60 * 60 * 1000,
  executionHaircutBps: 50, // 0.5% conservative haircut for slippage/fill risk
};
export interface GoLiveMetrics {
  nSettled: number;
  nIndependentMarkets: number;
  domains: string[];
  grossEdgePct: number;
  netEdgePct: number;
  seEdgePct: number;
  lcbEdgePct: number;
  maxDrawdownPct: number;
  concentrationPct: number;
  completionRate: number;
  windowMs: number;
  deployedUsd: number;
}
export interface CriterionStatus {
  met: boolean;
  current: number;
  required: number;
}
export interface GoLiveReport {
  ready: boolean;
  verdict: 'NOT_READY' | 'CONDITIONAL' | 'READY';
  criteria: Record<string, CriterionStatus>;
  metrics: GoLiveMetrics;
  unmet: string[];
}
/**
 * Cluster-robust standard error by conditionId (event-family).
 * Falls back to the iid standard error of the mean when every cluster is a
 * singleton (the cluster-robust estimator degenerates to zero variance then).
 */
function clusteredSE(edges: number[], clusters: string[]): number {
  if (edges.length < 2) return Number.NaN;
  // Sum residuals per cluster, then SE across clusters (one-step jackknife form).
  const byCluster = new Map<string, number>();
  for (let i = 0; i < edges.length; i++) {
    const c = clusters[i] ?? 'none';
    byCluster.set(c, (byCluster.get(c) ?? 0) + edges[i]);
  }
  const g = byCluster.size;
  const clusterSums = [...byCluster.values()];
  const meanSum = clusterSums.reduce((a, b) => a + b, 0) / g;
  const variance = clusterSums.reduce((a, b) => a + (b - meanSum) ** 2, 0) / g;
  const clusterSe = Math.sqrt(variance / Math.max(1, g - 1));
  // iid SE of the mean as a floor when clustering adds no information.
  const mean = edges.reduce((a, b) => a + b, 0) / edges.length;
  const iidVar = edges.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, edges.length - 1);
  const iidSe = Math.sqrt(iidVar / edges.length);
  return g === edges.length ? iidSe : Math.max(clusterSe, iidSe);
}
/** Peak-to-trough drawdown on a cumulative PnL series. */
export function maxDrawdown(realized: number[]): number {
  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  for (const r of realized) {
    cum += r;
    peak = Math.max(peak, cum);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - cum) / peak);
  }
  return maxDd;
}
export function computeGoLiveReport(
  outcomes: SettledSignalOutcome[],
  criteria: GoLiveCriteria = DEFAULT_GO_LIVE_CRITERIA,
): GoLiveReport {
  const settled = outcomes
    .filter((o) => typeof o.realizedEdge === 'number' && typeof o.settledAt === 'number')
    .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
  const nSettled = settled.length;
  const independentMarkets = new Set(settled.map((o) => o.conditionId));
  const domains = [...new Set(settled.map((o) => o.domain))];
  const deployedUsd = settled.reduce((s, o) => s + o.deployedUsd, 0);
  const haircut = criteria.executionHaircutBps / 10_000;
  const edges = settled.map((o) => (o.realizedEdge ?? 0) - haircut);
  const meanEdge = edges.length ? edges.reduce((a, b) => a + b, 0) / edges.length : 0;
  const se = edges.length ? clusteredSE(edges, settled.map((o) => o.conditionId)) : Number.NaN;
  const lcb = edges.length ? lcbEdge(meanEdge, se, 1.645) : Number.NaN;
  // Drawdown on cumulative realized PnL in deployed-capital units.
  const dd = maxDrawdown(settled.map((o) => o.realizedEdge ?? 0));
  // Domain concentration of deployed capital.
  const perDomain = new Map<string, number>();
  for (const o of settled) perDomain.set(o.domain, (perDomain.get(o.domain) ?? 0) + o.deployedUsd);
  const concentration = deployedUsd > 0
    ? Math.max(...perDomain.values()) / deployedUsd
    : 0;
  const windowMs = settled.length > 1
    ? (settled[settled.length - 1].settledAt ?? 0) - (settled[0].settledAt ?? 0)
    : 0;
  const completionRate = outcomes.length > 0 ? nSettled / outcomes.length : 0;
  const metrics: GoLiveMetrics = {
    nSettled,
    nIndependentMarkets: independentMarkets.size,
    domains,
    grossEdgePct: meanEdge * 100,
    netEdgePct: (meanEdge - haircut) * 100,
    seEdgePct: Number.isNaN(se) ? 0 : se * 100,
    lcbEdgePct: Number.isNaN(lcb) ? -Infinity : lcb * 100,
    maxDrawdownPct: dd * 100,
    concentrationPct: concentration * 100,
    completionRate,
    windowMs,
    deployedUsd,
  };
  const criteriaStatus: Record<string, CriterionStatus> = {
    minSettledSignals: { met: independentMarkets.size >= criteria.minSettledSignals, current: independentMarkets.size, required: criteria.minSettledSignals },
    minDomains: { met: domains.length >= criteria.minDomains, current: domains.length, required: criteria.minDomains },
    lcbEdge: { met: !Number.isNaN(lcb) && lcb > criteria.lcbEdgeMin, current: Number.isNaN(lcb) ? -Infinity : lcb, required: criteria.lcbEdgeMin },
    maxDrawdown: { met: dd <= criteria.maxDrawdownPct, current: dd, required: criteria.maxDrawdownPct },
    maxConcentration: { met: concentration <= criteria.maxConcentrationPct, current: concentration, required: criteria.maxConcentrationPct },
    completionRate: { met: completionRate >= criteria.minCompletionRate, current: completionRate, required: criteria.minCompletionRate },
    window: { met: windowMs >= criteria.minWindowMs, current: windowMs, required: criteria.minWindowMs },
  };
  const unmet = Object.entries(criteriaStatus).filter(([, s]) => !s.met).map(([k]) => k);
  let verdict: GoLiveReport['verdict'] = 'NOT_READY';
  if (unmet.length === 0) verdict = 'READY';
  else if (unmet.length <= 2 && !unmet.includes('lcbEdge')) verdict = 'CONDITIONAL';
  return { ready: unmet.length === 0, verdict, criteria: criteriaStatus, metrics, unmet };
}
/** Human-readable one-line status for the [gate] log line. */
export function formatGoLiveReport(r: GoLiveReport): string {
  const m = r.metrics;
  return `n=${m.nSettled}/${m.nIndependentMarkets}mkts domains=${m.domains.join(',') || '-'} ` +
    `netEdge=${m.netEdgePct.toFixed(2)}% lcb=${Number.isFinite(m.lcbEdgePct) ? m.lcbEdgePct.toFixed(2) : '-inf'}% ` +
    `dd=${m.maxDrawdownPct.toFixed(1)}% conc=${m.concentrationPct.toFixed(0)}% compl=${(m.completionRate * 100).toFixed(0)}% ` +
    `verdict=${r.verdict}${r.unmet.length ? ` unmet=[${r.unmet.join(',')}]` : ''}`;
}
