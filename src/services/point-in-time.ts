/**
 * Point-in-time helpers: pure functions that keep historical replay honest.
 *
 * These helpers exist because the replay pipeline must never let information
 * available only after a decision leak into the evaluation of that decision:
 * later leaderboard rank, later scores, later category assignments, or future
 * resolution data. See findings.md (Slices A/B) and docs on look-ahead bias.
 *
 * All timestamps are epoch milliseconds. A `resolutionTs` is the moment the
 * market resolves — nothing after it is knowable at decision time.
 */
/** Inclusive range check: true when `start <= t <= end`. */
export function isTimeInRange(t: number, start: number, end: number): boolean {
  return t >= start && t <= end;
}
export interface AtSegment {
  name: string;
  tsMs: number;
}
export interface AtSegmentResult {
  /** Largest gap between consecutive known timestamps, in ms (0 for <2 segments). */
  maxGapMs: number;
  /** Ordered timeline of known timestamps (name + tsMs). */
  segments: AtSegment[];
}
export type AtTimestampInput =
  | { name: string; tsMs: number | undefined; required?: boolean }
  | { name: string; tsMs?: number; required?: boolean };
/**
 * Build the chronological segment timeline for one candidate decision:
 * trade -> discovery -> decision -> order -> fill.
 *
 * `required` segments that are undefined make the timeline invalid; the caller
 * decides what that means (usually: cannot replay, treat as blocked).
 * Returns the largest gap between consecutive known timestamps, which is the
 * staleness/latency proxy for the whole decision.
 */
export function effectiveAtSegment(
  tradeTs: number,
  discoveryTs: number | undefined,
  decisionTs: number | undefined,
  orderTs: number | undefined,
  fillTs: number | undefined,
): AtSegmentResult {
  const raw: AtTimestampInput[] = [
    { name: 'trade', tsMs: tradeTs, required: true },
    { name: 'discovery', tsMs: discoveryTs },
    { name: 'decision', tsMs: decisionTs },
    { name: 'order', tsMs: orderTs },
    { name: 'fill', tsMs: fillTs },
  ];
  const segments: AtSegment[] = [];
  for (const seg of raw) {
    if (seg.tsMs === undefined) {
      if (seg.required) throw new Error(`required segment "${seg.name}" has no timestamp`);
      continue;
    }
    segments.push({ name: seg.name, tsMs: seg.tsMs });
  }
  segments.sort((a, b) => a.tsMs - b.tsMs);
  let maxGapMs = 0;
  for (let i = 1; i < segments.length; i++) {
    maxGapMs = Math.max(maxGapMs, segments[i].tsMs - segments[i - 1].tsMs);
  }
  return { maxGapMs, segments };
}
/**
 * True when `ts` is strictly before the market resolves.
 * When resolutionTs is unknown (market unresolved at write time) we cannot
 * disprove that the timestamp is point-in-time valid, so we allow it.
 */
export function isBeforeResolution(ts: number, resolutionTs: number | undefined): boolean {
  if (resolutionTs === undefined || resolutionTs === null) return true;
  return ts < resolutionTs;
}
/** Fields that are only knowable after the market resolves (or after the
 *  point-in-time snapshot the replay operates on). */
const FUTURE_FIELDS = new Set([
  'resolution',
  'resolvedAt',
  'settlementPnl',
  'followerExecutablePnl',
  'leaderboardRank',
  'finalScore',
  'rank',
]);
/**
 * Return a copy of `record` with every resolution-dependent or future-derived
 * field dropped. Use this before persisting/using data at decision time.
 */
export function stripFutureFields<T extends Record<string, unknown>>(record: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    // Category assignment can be revised as metadata improves; never carry it
    // into a decision-time projection. A stable domain field, when present,
    // is the point-in-time-safe replacement.
    if (key === 'category' || FUTURE_FIELDS.has(key)) continue;
    out[key] = value;
  }
  return out as Partial<T>;
}
export interface NoLookaheadResult {
  ok: boolean;
  violations: string[];
}
const OUTCOME_FIELDS = [
  'outcome',
  'settlementPnl',
  'followerExecutablePnl',
  'resolution',
  'finalScore',
  'rank',
  'leaderboardRank',
  'won',
  'result',
];
/**
 * Verify a record carries no value that could only be known after
 * `resolutionTs` (or after the decision, for outcome fields).
 * Returns a list of human-readable violations; empty means clean.
 */
export function assertNoLookahead(
  record: Record<string, unknown>,
  resolutionTs?: number,
): NoLookaheadResult {
  const violations: string[] = [];
  for (const key of OUTCOME_FIELDS) {
    if (!(key in record)) continue;
    const value = record[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'number' && value === 0) continue;
    violations.push(`record carries ${key}=${String(value)} which is only knowable after the decision`);
  }
  if (resolutionTs !== undefined && resolutionTs !== null) {
    for (const key of ['resolvedAt', 'settlementTs', 'endTimestamp']) {
      const value = record[key];
      if (typeof value === 'number' && !isBeforeResolution(value, resolutionTs)) {
        violations.push(`${key} is after resolution`);
      }
    }
  }
  return { ok: violations.length === 0, violations };
}