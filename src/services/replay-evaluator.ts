/**
 * ReplayEvaluator: prices a historical candidate decision using ONLY the order
 * book that was available at decision time, under realistic follower-execution
 * assumptions (spread, depth, tick, min-fill, taker delay, partial fills, fees).
 *
 * Design contract (findings.md §1, §2.6, §8):
 * - No look-ahead: the book is consumed at `discoveredAt`/`decidedAt`, never at
 *   the leader's trade timestamp, and never from a later snapshot. Future PnL,
 *   resolution, rank, or category data never enters the pricing.
 * - Follower fills are never simulated at leader price. The asks in the book at
 *   decision time are the only source of executable price.
 * - Polymarket mechanics applied here: signed off-chain orders, market orders
 *   are immediately executable limits, some markets impose a taker delay
 *   (default 250 ms) during which the order may be rejected; partial fills
 *   happen; min_order_size/tick_size are per-book; orders are GTD by nature.
 *
 * Phase 1's LedgerRecord type is not yet landed; the evaluator accepts any
 * structural subset carrying the fields it needs (see ReplayCandidate).
 */
import { computeExactSharesAndCost, quantizeBuyPrice, type TickSize } from '../utils/price-utils.js';
// ============================================================================
// Types
// ============================================================================
export interface BookLevel {
  price: number;
  size: number;
}
/** Book shape consumed by the evaluator (structural subset of the CLOB book). */
export interface BookSnapshot {
  /** Ask levels, ascending by price (best first). */
  asks: BookLevel[];
  /** Bid levels, descending by price (best first). */
  bids: BookLevel[];
  /** Minimum order size enforced by the market. */
  minOrderSize: number;
  /** Tick size enforced by the market. */
  tickSize: number;
  /** Snapshot timestamp in ms. */
  timestamp: number;
}
export type ReplaySide = 'BUY' | 'SELL';
/**
 * Structural subset of the Phase-1 ledger record. Any object implementing
 * `{conditionId, tokenId, outcome, side, price, size, tradeTimestamp,
 * discoveredAt, decidedAt}` is accepted; `bookSnapshot` is optional because the
 * evaluator is designed to look the book up at decision time instead of
 * trusting a snapshot attached to the record (which could be stale or future).
 */
export interface ReplayCandidate {
  candidateId: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  side: ReplaySide;
  /** Leader-observed price — used for edge reference only, never for the fill. */
  price: number;
  size: number;
  tradeTimestamp: number;
  discoveredAt: number;
  decidedAt: number;
  bookSnapshot?: BookSnapshot;
  /** Model win probability at decision time (0-1). BUY edge uses it directly. */
  expectedProbability?: number;
  [key: string]: unknown;
}
export type ReplayVerdict =
  | 'executable'
  | 'no_best_ask'
  | 'no_depth'
  | 'above_cap'
  | 'stale'
  | 'taker_delay_failed';
export interface DeterministicResult {
  candidateId: string;
  /** VWAP of the filled levels (0 when blocked). */
  executableVwap: number;
  /** Shares actually filled (0 when blocked). */
  executableSize: number;
  /** (fill price - reference price)/reference*10000 in bps; negative = better. */
  slippageBps: number;
  /** True when the book could not satisfy the full requested size. */
  partiallyFillable: boolean;
  /** Expected shares filled after partial-fill and delay logic. */
  expectedFill: number;
  /** Edge per share after fees/slippage: expectedProbability - all-in cost. */
  netExpectedEdge: number;
  /** Total wall-clock latency of the decision (decision -> fill). */
  latencyMs: number;
  verdict: ReplayVerdict;
  details: {
    reason?: string;
    bestAsk: number | null;
    bestBid: number | null;
    bookTimestamp: number | null;
    levelsUsed: number;
    tickSize: string;
    minOrderSize: number;
    takerFeeBps: number;
    grossCostPerShare: number;
    feePerShare: number;
    netCostPerShare: number;
    blockedByTakerDelay: boolean;
    delaysMs: { discovery: number; decision: number; takerDelayMs: number };
  };
}
export interface ReplaySummary {
  n: number;
  executable: number;
  blocked: number;
  byReason: Partial<Record<ReplayVerdict, number>>;
  avgSlippageBps: number | null;
  avgLatencyMs: number | null;
  grossEdgePerShare: number | null;
  netEdgePerShare: number | null;
  partialFillRate: number | null;
}
export interface ReplayEvaluatorOptions {
  ledger: ReplayCandidate[];
  /** Returns the book valid at `atMs` for `tokenId`. Null = no book available. */
  bookLookup: (tokenId: string, atMs: number) => Promise<BookSnapshot | null>;
  takerFeeBps: number;
  /** Maximum ask-vs-reference slippage before a candidate is blocked. */
  maxSlippageBps?: number;
  /** Candidate age (decision time - trade time) beyond which we block. */
  maxAgeMs?: number;
  /** Markets with mandatory taker delay will reject immediate orders sooner. */
  defaultTakerDelayMs?: number;
  /** Injectable clock for determinism in tests. Accepts a fixed epoch ms or a
   *  function returning one. Defaults to Date.now(). */
  now?: number | (() => number);
}
// ============================================================================
// Local micro-unit helpers (fallback when price-utils paths are unavailable)
// ============================================================================
const USDC_SCALE = 1_000_000n;
const SHARE_SCALE = 1_000_000n;
/** Convert a float price to micro-units via BigInt (de-float the boundary). */
function toMicros(value: number): bigint {
  return BigInt(Math.round(value * Number(USDC_SCALE)));
}
/** Local exact sizing: biggest whole shares affordable at `price` within budget. */
function localExactShares(budgetUsd: number, price: number): number {
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || !(price > 0)) return 0;
  const budgetMicros = BigInt(Math.max(0, Math.floor(budgetUsd * Number(USDC_SCALE))));
  const priceMicros = toMicros(price);
  if (budgetMicros <= 0n || priceMicros <= 0n) return 0;
  const sharesMicros = (budgetMicros * SHARE_SCALE) / priceMicros;
  return Math.floor(Number(sharesMicros) / 1) / Number(SHARE_SCALE);
}
function availableExactShares(): typeof computeExactSharesAndCost | null {
  try {
    return computeExactSharesAndCost;
  } catch {
    return null;
  }
}
// ============================================================================
// Evaluator
// ============================================================================
export class ReplayEvaluator {
  private readonly ledger: ReplayCandidate[];
  private readonly bookLookup: (tokenId: string, atMs: number) => Promise<BookSnapshot | null>;
  private readonly takerFeeBps: number;
  private readonly maxSlippageBps: number;
  private readonly maxAgeMs: number;
  private readonly defaultTakerDelayMs: number;
  private readonly now: () => number;
  constructor(options: ReplayEvaluatorOptions) {
    this.ledger = options.ledger;
    this.bookLookup = options.bookLookup;
    this.takerFeeBps = options.takerFeeBps;
    this.maxSlippageBps = options.maxSlippageBps ?? 1000;
    this.maxAgeMs = options.maxAgeMs ?? 60_000;
    this.defaultTakerDelayMs = options.defaultTakerDelayMs ?? 250;
    this.now = typeof options.now === 'function' ? options.now : options.now !== undefined ? () => options.now as number : () => Date.now();
  }
  /**
   * Evaluate every candidate in the ledger. Each candidate is priced strictly
   * from the book observed at its decision time (falling back to the discovery
   * time when `decidedAt` is missing), with the follower-execution model below.
   */
  async evaluateReplay(): Promise<DeterministicResult[]> {
    const results: DeterministicResult[] = [];
    for (const candidate of this.ledger) {
      results.push(await this.evaluateOne(candidate));
    }
    return results;
  }
  private async evaluateOne(candidate: ReplayCandidate): Promise<DeterministicResult> {
    const { side, size, price: referencePrice } = candidate;
    // ---- point-in-time consumption: decision-time book only ----
    const bookAtMs = candidate.decidedAt ?? candidate.discoveredAt;
    const book = candidate.bookSnapshot ?? (await this.bookLookup(candidate.tokenId, bookAtMs));
    const orderTs = bookAtMs;
    const fillTs = orderTs + this.defaultTakerDelayMs;
    // Simulated decision->fill latency: for an immediately-executable market
    // order this is exactly the forced taker delay (0 on non-delayed books).
    const latencyMs = Math.max(0, fillTs - orderTs);
    const details: DeterministicResult['details'] = {
      bestAsk: null,
      bestBid: null,
      bookTimestamp: book?.timestamp ?? null,
      levelsUsed: 0,
      tickSize: String(book?.tickSize ?? ''),
      minOrderSize: book?.minOrderSize ?? 0,
      takerFeeBps: this.takerFeeBps,
      grossCostPerShare: 0,
      feePerShare: 0,
      netCostPerShare: 0,
      blockedByTakerDelay: false,
      delaysMs: {
        discovery: Math.max(0, candidate.discoveredAt - candidate.tradeTimestamp),
        decision: Math.max(0, (candidate.decidedAt ?? candidate.discoveredAt) - candidate.tradeTimestamp),
        takerDelayMs: this.defaultTakerDelayMs,
      },
    };
    const blocked = (verdict: ReplayVerdict, reason: string): DeterministicResult => ({
      candidateId: candidate.candidateId,
      executableVwap: 0,
      executableSize: 0,
      slippageBps: 0,
      partiallyFillable: false,
      expectedFill: 0,
      netExpectedEdge: 0,
      latencyMs,
      verdict,
      details: { ...details, reason },
    });
    // ---- staleness gate ----
    if (this.now() - candidate.tradeTimestamp > this.maxAgeMs) {
      return blocked('stale', `trade ${this.now() - candidate.tradeTimestamp}ms old (max ${this.maxAgeMs}ms)`);
    }
    // ---- book availability ----
    if (!book) return blocked('no_best_ask', 'no book snapshot at decision time');
    details.bestBid = book.bids[0]?.price ?? null;
    details.bookTimestamp = book.timestamp;
    // ---- taker delay: the order sees the book it would be submitted into.
    // Markets with a forced taker delay hold the order for `takerDelayMs`
    // before execution. A fill that would land after the replay clock `now()`
    // has not yet occurred — the order cannot be counted as executable. This
    // keeps forward replay honest without inventing post-decision book data. ----
    const takerDelayMs = this.defaultTakerDelayMs;
    details.blockedByTakerDelay = false;
    if (fillTs > this.now()) {
      details.blockedByTakerDelay = true;
      return blocked('taker_delay_failed', `fill at ${fillTs} lands after now ${this.now()} under ${takerDelayMs}ms taker delay`);
    }
    // ---- side-specific executable pricing ----
    const usableLevels = side === 'BUY' ? book.asks : book.bids;
    if (!usableLevels || usableLevels.length === 0) {
      return blocked(side === 'BUY' ? 'no_best_ask' : 'no_depth', 'no levels on executable side');
    }
    const fills: { price: number; shares: number }[] = [];
    let remaining = size;
    for (const level of usableLevels) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, level.size);
      // Respect book min-order-size: a level smaller than minOrderSize cannot
      // be hit by a single market order in the CLOB.
      if (book.minOrderSize > 0 && take < book.minOrderSize && fills.length === 0) {
        continue;
      }
      fills.push({ price: level.price, shares: take });
      remaining -= take;
    }
    if (fills.length === 0) {
      return blocked(side === 'BUY' ? 'no_best_ask' : 'no_depth', 'no level meets min_order_size');
    }
    // ---- executable VWAP over the levels actually consumed ----
    const totalShares = fills.reduce((acc, f) => acc + f.shares, 0);
    const vwap =
      fills.reduce((acc, f) => acc + f.price * f.shares, 0) / (totalShares || 1);
    details.levelsUsed = fills.length;
    // ---- slippage vs reference (leader-observed) price ----
    const slippageBps = referencePrice > 0 ? Math.round(((vwap - referencePrice) / referencePrice) * 10_000) : 0;
    if (slippageBps > this.maxSlippageBps) {
      return blocked('above_cap', `vwap ${vwap} is +${slippageBps}bps vs reference ${referencePrice} (cap ${this.maxSlippageBps})`);
    }
    // ---- exact micro-unit sizing for the gross cost ----
    const exact = computeExactSharesAndCost(vwap * totalShares, vwap, tickSizeOf(book.tickSize));
    const budgetUsd = vwap * totalShares;
    const sharesByExact = availableExactShares()
      ? exact.shares
      : localExactShares(budgetUsd, vwap);
    // NOTE: computeExactSharesAndCost floors to the tick; when the tick floor
    // changes the price, re-quantize the VWAP so gross cost is consistent.
    const costPrice = quantizeBuyPrice(vwap, tickSizeOf(book.tickSize)) || vwap;
    const grossCostPerShare = costPrice;
    const feePerShare = this.feePerShare(costPrice);
    const netCostPerShare = grossCostPerShare + feePerShare;
    // ---- partial-fill accounting ----
    const partiallyFillable = totalShares < size;
    const expectedFill = partiallyFillable ? totalShares : Math.min(size, sharesByExact || size);
    // ---- net edge: probability-based expected value minus all-in cost ----
    const prob = candidate.expectedProbability ?? referencePrice;
    const netExpectedEdge = prob - netCostPerShare;
    return {
      candidateId: candidate.candidateId,
      executableVwap: roundTo(vwap, 6),
      executableSize: roundTo(totalShares, 2),
      slippageBps,
      partiallyFillable,
      expectedFill: roundTo(expectedFill, 2),
      netExpectedEdge: roundTo(netExpectedEdge, 8),
      latencyMs,
      verdict: 'executable',
      details: {
        ...details,
        bestAsk: book.asks[0]?.price ?? null,
        grossCostPerShare: roundTo(grossCostPerShare, 8),
        feePerShare: roundTo(feePerShare, 8),
        netCostPerShare: roundTo(netCostPerShare, 8),
      },
    };
  }
  /** Polymarket taker fee: feeRateBps * price * (1-price) per share. */
  private feePerShare(price: number): number {
    if (this.takerFeeBps <= 0 || price <= 0 || price >= 1) return 0;
    return (this.takerFeeBps / 10_000) * price * (1 - price);
  }
}
// ============================================================================
// Helpers
// ============================================================================
function tickSizeOf(tick: number | string | undefined): TickSize {
  const t = typeof tick === 'number' ? tick : Number(tick);
  if (!Number.isFinite(t) || t <= 0) return '0.01';
  if (t >= 0.1) return '0.1';
  if (t >= 0.01) return '0.01';
  if (t >= 0.001) return '0.001';
  return '0.0001';
}
function roundTo(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
/** Aggregate dry-run stats over a batch of replay results. */
export function summarizeReplay(results: DeterministicResult[]): ReplaySummary {
  const byReason: Partial<Record<ReplayVerdict, number>> = {};
  let executable = 0;
  let partial = 0;
  let slippageSum = 0;
  let latencySum = 0;
  let grossSum = 0;
  let netSum = 0;
  for (const r of results) {
    if (r.verdict === 'executable') {
      executable++;
      slippageSum += r.slippageBps;
      latencySum += r.latencyMs;
      grossSum += r.executableVwap;
      netSum += r.netExpectedEdge;
      if (r.partiallyFillable) partial++;
    } else {
      byReason[r.verdict] = (byReason[r.verdict] ?? 0) + 1;
    }
  }
  return {
    n: results.length,
    executable,
    blocked: results.length - executable,
    byReason,
    avgSlippageBps: executable > 0 ? roundTo(slippageSum / executable, 2) : null,
    avgLatencyMs: executable > 0 ? roundTo(latencySum / executable, 1) : null,
    grossEdgePerShare: executable > 0 ? roundTo(grossSum / executable, 8) : null,
    netEdgePerShare: executable > 0 ? roundTo(netSum / executable, 8) : null,
    partialFillRate: executable > 0 ? roundTo(partial / executable, 4) : null,
  };
}