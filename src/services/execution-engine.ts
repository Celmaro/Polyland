/** Typed boundary for the post-consensus execution stage. */
import type { TradingService, OrderResult } from './trading-service.js';
import type { RiskManager } from './risk-manager.js';
import type { SmartMoneyTrade } from './smart-money-service.js';
import type { BasketConfig } from './basket-quorum-service.js';
import type { ConsensusSignal, ExecutionDecision, PipelineDecision, RejectReason } from './pipeline-types.js';
import { BankrollReservationLedger } from './bankroll-reservation.js';
import { computeExactSharesAndCost, quantizeBuyPrice, tickSizeToEnum } from '../utils/price-utils.js';
import { executeAgainstBook, type FillBook } from './fill-engine.js';
import { computeEntryQualityScore, applyRiskAdjustedAmount, effectiveStopLoss } from './execution-quality.js';
import { takerFeePerShare, feePerShare, DEFAULT_FEE_RATE_BPS } from '../utils/fee-math.js';
import { classifySubmission } from './submission-pipeline.js';
import type { MarketQualityTracker } from './market-quality.js';

export interface ExecutionEngineConfig {
  dryRun: boolean; orderType: 'FOK' | 'FAK'; maxSlippage: number;
  minTradeSize: number; maxSizePerTrade: number; sizeScale: number;
  /** Absolute upper bound on entry price (0-1). Rejects buying near-certain
   * tickets (e.g. >0.85) where risk/reward is structurally bad. */
  maxEntryPrice?: number;
  /** Max age (ms) of the consensus quote before it is stale-cancelled. Default 30s. */
  maxQuoteAgeMs?: number;
  /** Price dry-run fills from live book depth (shared fill-engine). Default true in dry-run. */
  depthAwareFills?: boolean;
  /** D1 entry-quality gate (opt-in; 0 = disabled). Rejects below the floor. */
  entryQualityMinScore?: number;
  /** D2 R-normalized sizing (opt-in): cap so loss-to-stop ≈ target risk. */
  riskSizing?: { enabled: boolean; targetRiskUsdc: number; stopLossPct: number; absoluteFloor?: number };
}
export interface ExecutionEngineDeps {
  tickSizeFor: (conditionId: string) => number;
  feeRateFor: (conditionId: string) => number;
  bankrollFor: (category: string) => number;
  basketSpendGet: (category: string) => number;
  basketSpendAdd: (category: string, amount: number) => void;
  phaseEdge: (signal: ConsensusSignal) => { minEdge: number; minProb: number };
  liquidityCheck: (tokenId: string, shares: number, price: number) => Promise<boolean>;
  onPositionOpened: (...args: unknown[]) => void;
  onDedupFire: (key: string, now: number) => void;
  onAntiSniperFire: (tokenId: string) => void;
  /** P1 observability: a stale consensus quote was cancelled (fail-closed). */
  onStaleQuoteSkip?: () => void;
  /** P1-5: live book lookup so dry-run fills use the SAME depth model as replay. */
  bookLookup?: (tokenId: string) => Promise<FillBook | null>;
  /** P1 market-quality: chop size modifier + depth gate (lens #1/#3). */
  quality?: MarketQualityTracker;
  /** Anti-honeypot audit: real 24h volume + liquidity for the market, when
   *  known. Null when unavailable (market metadata fetch failed). */
  marketVolume24h?: (conditionId: string) => Promise<{ volume24hr: number; liquidity: number } | null>;
  auditStore: { recordFire: (params: Record<string, unknown>) => unknown };
}

export type ExecuteResult =
  | { ok: true; orderId?: string }
  | { ok: false; reason: RejectReason | 'order' | 'depth_unknown' | 'no_depth' | 'quality' | 'entry_ceiling'; detail?: string };

/** Skip/failure taxonomy — the audit's failed=N conflation fix. */
export interface ExecutionSkips {
  staleQuote: number;
  bankroll: number;
  depthUnknown: number;
  noDepth: number;
  quality: number;
  entryCeiling: number;
}

export class ExecutionEngine {
  private readonly ledger: BankrollReservationLedger<string>;
  /** Genuine order failures ONLY (venue reject / throw). Skips are not failures. */
  public failed = 0;
  /** Fail-closed skips by reason — visible in the funnel, not conflated with failed. */
  public readonly skipped: ExecutionSkips = { staleQuote: 0, bankroll: 0, depthUnknown: 0, noDepth: 0, quality: 0, entryCeiling: 0 };
  /** Idempotency audit: signalIds already executed this process — a duplicate
   *  execute() for the same signal is rejected BEFORE any reservation/order,
   *  so a double-dispatch (retry, re-entrancy) can never double-fill. */
  private readonly executedSignalIds = new Set<string>();
  /** Per-category rate-limit state for bankroll-saturation warnings. */
  private _lastBankrollLogAt = new Map<string, number>();
  constructor(
    private readonly tradingService: TradingService,
    private readonly riskManager: RiskManager | null,
    private readonly deps: ExecutionEngineDeps,
    private readonly config: ExecutionEngineConfig,
  ) { this.ledger = new BankrollReservationLedger((category) => deps.bankrollFor(category)); }

  async evaluate(signal: ConsensusSignal, trade: SmartMoneyTrade, basket: BasketConfig): Promise<PipelineDecision<ExecutionDecision>> {
    if (this.riskManager && (!this.riskManager.canTrade() || this.riskManager.isBasketKilled(basket.name))) return { accepted: false, reason: 'risk' };
    const maxQuoteAge = this.config.maxQuoteAgeMs ?? 30_000;
    if (signal.observedAt !== undefined && Date.now() - signal.observedAt > maxQuoteAge) {
      this.deps.onStaleQuoteSkip?.();
      return { accepted: false, reason: 'stale_quote', detail: `quote_age_ms=${Date.now() - signal.observedAt}` };
    }
    const category = basket.category;
    const spent = this.deps.basketSpendGet(category);
    let amount = Math.min(signal.totalSize * this.config.sizeScale * signal.consensusPrice, this.config.maxSizePerTrade);
    if (this.riskManager) amount = this.riskManager.sizeOrder(amount);
    amount = Math.min(amount, Math.max(0, this.deps.bankrollFor(category) - spent));
    // P1 lens #3: chop-based size reduction — a churning thin market trades
    // smaller, never full size. Applied BEFORE quantization so the reduced
    // notional flows through the exact-shares math.
    if (this.deps.quality && amount > 0) {
      const assetId = trade.tokenId ?? signal.conditionId;
      const mul = this.deps.quality.sizeMultiplier(assetId);
      if (mul < 1) amount = amount * mul;
    }
    const tick = tickSizeToEnum(this.deps.tickSizeFor(signal.conditionId));
        // Audit 09-11 fix: cap the slippage-adjusted price BELOW 1.0. With
        // maxSlippage 0.10, any consensus > 0.909 produced price >= 1.0, and
        // computeExactSharesAndCost returns {shares:0, costUsd:0} for qPrice>=1
        // → every heavy favorite (NFL 2027 @0.988, politics @0.999) was rejected
        // as min_size. There is no ask at >= 1.0; the executable price for a
        // favorite is clamped at 0.99.
        const slippagePrice = signal.consensusPrice * (1 + this.config.maxSlippage);
        const price = quantizeBuyPrice(Math.min(slippagePrice, 0.99), tick);
    let exact = computeExactSharesAndCost(amount, price, tick);
        // Sizing floor-clamp: sizing is proportional to the leader's share count,
        // so a thin leader can scale the copy below the minimum order notional.
        // Rather than reject a real consensus outright, clamp UP to minTradeSize
        // when the computed notional is above the $1 dust bound and the edge
        // (checked below) is real. Caps at maxSizePerTrade. This converts the
        // historical min_size rejections (audit: 1047) into executed paper trades.
        // Audit 09-11: the `exact.costUsd >= 1` guard made this clamp dead code
        // after minTradeSize dropped to 1 (costUsd < 1 && costUsd >= 1 is never
        // true) — so sub-$1 favorites (NFL 2027 @0.988 → $0.99 notional) were
        // rejected as min_size instead of clamped up. Clamp when the copy
        // notional is above the 0.50 dust bound but below minTradeSize, as
        // long as we stay under maxSizePerTrade. True dust (< $0.50) still
        // rejects below.
        if (exact.costUsd < this.config.minTradeSize && exact.costUsd >= 0.5 && amount < this.config.maxSizePerTrade) {
          const clamped = Math.min(this.config.minTradeSize, this.config.maxSizePerTrade);
          exact = computeExactSharesAndCost(clamped, price, tick);
          if (exact.costUsd > this.config.maxSizePerTrade) exact = computeExactSharesAndCost(this.config.maxSizePerTrade, price, tick);
        }
    if (exact.costUsd < 1) return { accepted: false, reason: 'min_size' };
    const fee = takerFeePerShare(signal.consensusPrice, this.deps.feeRateFor(signal.conditionId) || DEFAULT_FEE_RATE_BPS);
    const edge = signal.winRate - signal.consensusPrice - fee;
    // Absolute price ceiling: buying near-certain tickets (>= ~0.85) risks a
    // lot to win a little and cannot be validated by a copy signal. Reject
    // regardless of the basket's winRate (audit: entries at 0.90-0.95 in
    // esports/soccer were the core loss driver).
    const maxEntry = this.config.maxEntryPrice ?? 0.85;
    if (signal.consensusPrice > maxEntry) return { accepted: false, reason: 'edge', detail: `price_ceiling ${signal.consensusPrice.toFixed(3)} > ${maxEntry}` };
    const phase = this.deps.phaseEdge(signal);
    if (edge <= phase.minEdge || signal.winRate < phase.minProb) return { accepted: false, reason: 'edge' };
    // D1: composite entry-quality gate. Only runs when features are available —
        // previously passed `spreadBps: null, minTopDepth: null` and the gate
        // produced degenerate scores (entryQ=40/100 max). Audit 09-10: 212 QUALITY
        // hits with entryQ stuck at the floor meant the gate was never actually
        // gating anything. Now: when quality tracker has features for this token,
        // use real spreadBps + depth; when it doesn't, skip the gate entirely
        // (advisory log only).
        const eqMin = this.config.entryQualityMinScore ?? 0;
        if (eqMin > 0) {
          const tokenId = trade?.tokenId ?? signal.conditionId;
          const book = this.deps.bookLookup ? await this.deps.bookLookup(tokenId).catch(() => null) : null;
          const qf = this.deps.quality?.features(tokenId, book ?? undefined) ?? null;
          if (qf && (qf.spreadBps !== null || qf.depthUsd > 0)) {
            const ageSeconds = signal.observedAt !== undefined ? (Date.now() - signal.observedAt) / 1000 : 0;
            const eq = computeEntryQualityScore({
              signalEdgeBps: edge * 10_000,
              spreadBps: qf.spreadBps,
              minTopDepth: qf.depthUsd,
              ageSeconds,
              weights: { edge: 0.4, spread: 0.3, depth: 0.2, freshness: 0.1 },
            });
            if (eq.score < eqMin) {
              this.skipped.quality++;
              return { accepted: false, reason: 'quality', detail: `entry_quality ${eq.score.toFixed(1)} < ${eqMin}` };
            }
          }
          // Features unavailable → skip gate (advisory) — better than gating on degenerate defaults.
        }
    // D2: R-normalized sizing (opt-in) — cap so loss-to-stop ≈ fixed risk budget.
    if (this.config.riskSizing?.enabled) {
      const stopLoss = effectiveStopLoss({
        entryPrice: signal.consensusPrice,
        stopPct: this.config.riskSizing.stopLossPct,
        absoluteFloor: this.config.riskSizing.absoluteFloor,
      });
      const r = applyRiskAdjustedAmount({
        baseUsdc: exact.costUsd,
        entryPrice: signal.consensusPrice,
        stopLossPrice: stopLoss,
        targetRiskUsdc: this.config.riskSizing.targetRiskUsdc,
      });
      if (r.adjusted && r.amountUsdc > 0) {
        exact = computeExactSharesAndCost(r.amountUsdc, price, tick);
      }
    }
    if (!this.config.dryRun && trade.tokenId && !(await this.deps.liquidityCheck(trade.tokenId, exact.shares, price))) return { accepted: false, reason: 'liquidity' };
    return { accepted: true, value: { signal, amountUsd: exact.costUsd, price, dryRun: this.config.dryRun } };
  }

  async execute(decision: Extract<PipelineDecision<ExecutionDecision>, { accepted: true }>, trade?: SmartMoneyTrade, basket?: BasketConfig): Promise<ExecuteResult> {
    const { signal, amountUsd, price } = decision.value;
    const category = basket?.category ?? signal.category;
    // Idempotency audit: never execute the same signal twice in-process, even
    // if the caller double-dispatches (retry/re-entrancy). The signalId is
    // unique per fire; this guard makes a duplicate fill impossible here.
    if (signal.signalId && this.executedSignalIds.has(signal.signalId)) {
      this.skipped.staleQuote++; // counted as a fail-closed skip, not a failure
      console.warn(`[ExecutionEngine] SKIP duplicate-signal: ${signal.marketSlug} ${signal.signalId} — already executed`);
      return { ok: false, reason: 'stale_quote', detail: 'duplicate_signal_execution' };
    }
    // Defense-in-depth: the planner may replace the engine's initial price
    // with executable VWAP. Re-apply the SAME shared ceiling at the final
    // mutation boundary so executed/audited prices can never exceed it.
    const maxEntry = this.config.maxEntryPrice ?? 0.85;
    if (price > maxEntry) {
      this.skipped.entryCeiling++;
      console.warn(`[ExecutionEngine] SKIP entry-ceiling: ${signal.marketSlug} final_price=${price.toFixed(3)} > max=${maxEntry.toFixed(3)}`);
      return { ok: false, reason: 'entry_ceiling', detail: `final_price=${price} max=${maxEntry}` };
    }
    // Stale-quote cancellation: never reserve/route on an expired quote
    // even if evaluate() predates this call (defense in depth).
    const maxQuoteAge = this.config.maxQuoteAgeMs ?? 30_000;
    if (signal.observedAt !== undefined && Date.now() - signal.observedAt > maxQuoteAge) {
      this.skipped.staleQuote++;
      this.deps.onStaleQuoteSkip?.();
      console.warn(`[ExecutionEngine] SKIP stale quote: ${signal.marketSlug} age_ms=${Date.now() - signal.observedAt}`);
      return { ok: false, reason: 'stale_quote', detail: `age_ms=${Date.now() - signal.observedAt}` };
    }
    // Anti-honeypot audit: optional 24h-volume floor (MIN_MARKET_VOLUME24H_USD).
    // Applies to ALL orders (live + dry-run) BEFORE any reservation — markets
    // below the floor (a wash-traded honeypot or dead book) are skipped.
    // 0 = disabled; missing metadata is advisory, never blocking.
    const volFloor = Number(process.env.MIN_MARKET_VOLUME24H_USD ?? 0);
    if (volFloor > 0 && this.deps.marketVolume24h) {
      try {
        const meta = await this.deps.marketVolume24h(signal.conditionId);
        if (meta !== null) {
          if (meta.volume24hr < volFloor) {
            this.skipped.quality++;
            console.warn(`[ExecutionEngine] SKIP volume24h: ${signal.marketSlug} $${meta.volume24hr.toFixed(0)} < floor $${volFloor}`);
            return { ok: false, reason: 'quality', detail: `volume24h $${meta.volume24hr} < $${volFloor}` };
          }
        } else {
          console.warn(`[ExecutionEngine] volume24h advisory: ${signal.marketSlug} metadata unavailable — continuing`);
        }
      } catch (err) {
        console.warn(`[ExecutionEngine] volume24h fetch failed (continuing): ${err instanceof Error ? err.message : err}`);
      }
    }
    const release = this.ledger.reserve(category, amountUsd, this.deps.basketSpendGet(category));
    if (!release) {
      // Bankroll saturation: make the invisible failure visible. The audit
      // (09-07) showed failed=52 vs executed=24 (68% rejection) with zero
      // operator-visible reason. Rate-limited to one line per 60s per category.
      this.skipped.bankroll++;
      const now = Date.now();
      const last = this._lastBankrollLogAt.get(category) ?? 0;
      if (now - last >= 60_000) {
        this._lastBankrollLogAt.set(category, now);
        const limit = this.deps.bankrollFor(category);
        const spent = this.deps.basketSpendGet(category);
        console.warn(
          `[ExecutionEngine] SKIP bankroll: ${category} slice full — ` +
          `spent=$${spent.toFixed(2)} of $${limit.toFixed(2)} ` +
          `(${(spent * 100 / Math.max(limit, 1)).toFixed(0)}%), wanted $${amountUsd.toFixed(2)} for ${signal.marketSlug}`
        );
      }
      return { ok: false, reason: 'bankroll' };
    }
    try {
      let result: OrderResult;
      if (decision.value.dryRun) result = { success: true, orderId: `dry_run_${Date.now()}` };
      else if (!trade?.tokenId) throw new Error('missing tokenId');
      else result = await this.tradingService.createMarketOrder({ tokenId: trade.tokenId, side: 'BUY', amount: amountUsd, price, orderType: this.config.orderType });
      const classification = classifySubmission(result);
      if (classification !== 'accepted') {
        if (classification === 'unknown') {
          // Mutation outcome is ambiguous: release local reservation but do NOT
          // retry; durable order reconciliation must query the venue first.
          console.warn(`[ExecutionEngine] order outcome UNKNOWN for ${signal.marketSlug} — reconciliation required; no retry`);
        }
        this.failed++;
        release();
        return { ok: false, reason: 'order', detail: classification };
      }
      // ---- depth-aware dry-run fill (P1-5): same fill engine as replay ----
      // When enabled, a dry-run order is priced through the live book with the
      // shared executeAgainstBook model: partial fills and executable VWAP are
      // recorded instead of assuming the limit ceiling fills in full.
      let auditPrice = signal.consensusPrice;
      let auditShares = amountUsd / signal.consensusPrice;
      let placedUsd = amountUsd;
      const depthAware = this.config.depthAwareFills ?? this.config.dryRun;
      if (depthAware && decision.value.dryRun && trade?.tokenId && this.deps.bookLookup) {
        const book = await this.deps.bookLookup(trade.tokenId);
        if (!book) {
          this.skipped.depthUnknown++;
          release();
          console.warn(`[ExecutionEngine] SKIP depth-unknown: no live book for ${trade.tokenId}`);
          return { ok: false, reason: 'depth_unknown' };
        }
        // P1 lens #1: market-quality gate on the live book BEFORE filling —
        // thin/churning markets (tennis/ITF) are rejected at execution, not
        // after the reservation. Record the book into the tracker too, so
        // features stay fresh for the next review pass.
        if (this.deps.quality) {
          this.deps.quality.recordBook(trade.tokenId, book);
          const q = this.deps.quality.assess(trade.tokenId, {});
          // Hard-block ONLY on book-integrity gates (spread/depth) — a thin
          // market with an insufficient tick history must still be allowed to
          // fire rather than being permanently locked out (the audit's
          // min_ticks self-block: fired=0 forever). min_ticks/stale are
          // advisory and logged, not fatal.
          const hardBlocked = q.reasons.filter((r) => r === 'spread' || r === 'depth');
          if (hardBlocked.length > 0) {
            this.skipped.quality++;
            release();
            console.warn(`[ExecutionEngine] SKIP quality: ${signal.marketSlug} ${hardBlocked.join(',')}`);
            return { ok: false, reason: 'quality', detail: hardBlocked.join(',') };
          }
          if (q.reasons.length > 0) {
                      console.warn(`[ExecutionEngine] quality advisory: ${signal.marketSlug} ${q.reasons.join(',')} — continuing`);
                    }
                  }
                  // Quantized fill size: use the exact-shares computed in evaluate()
        // (already tick-quantized) rather than a naive amountUsd/price division.
        const sizeForBook = computeExactSharesAndCost(amountUsd, price, tickSizeToEnum(this.deps.tickSizeFor(signal.conditionId))).shares;
        const fill = executeAgainstBook({ side: 'BUY', size: sizeForBook, maxPrice: price }, book);
        if (fill.verdict !== 'filled' || fill.executableSize <= 0) {
          this.skipped.noDepth++;
          release();
          const bestAsk = book.asks[0] ? book.asks[0].price : NaN;
          const bestAskSize = book.asks[0] ? book.asks[0].size : NaN;
          console.warn(`[ExecutionEngine] SKIP no-depth: ${signal.marketSlug} ceiling ${price.toFixed(3)} bestAsk=${Number.isFinite(bestAsk) ? bestAsk.toFixed(3) : 'none'} askSize=${Number.isFinite(bestAskSize) ? bestAskSize.toFixed(1) : 'none'} asks=${book.asks.length} want=${sizeForBook} verdict=${fill.verdict} fillable=${fill.executableSize.toFixed(2)}`);
          return { ok: false, reason: 'no_depth' };
        }
        auditPrice = fill.executableVwap;
        auditShares = fill.executableSize;
        placedUsd = fill.executableVwap * fill.executableSize;
      }
      this.deps.basketSpendAdd(category, placedUsd);
      // Idempotency: mark executed ONLY after a successful fill. Every record
      // carries the unique signalId so downstream audit/PnL reconciliation can
      // dedup by order (pnl-truthteller pattern: dedup by order id).
      if (signal.signalId) this.executedSignalIds.add(signal.signalId);
      // Audit pricePaid = the honest executable estimate: consensus when the
      // book is not used, otherwise the true depth-aware fill VWAP.
      this.deps.auditStore.recordFire({ conditionId: signal.conditionId, marketSlug: signal.marketSlug, outcome: signal.outcome, side: signal.side, pricePaid: auditPrice, size: auditShares, winRate: signal.winRate, basket: signal.basketName, wallets: signal.wallets, category: signal.category, signalId: signal.signalId });
      this.deps.onPositionOpened(trade?.tokenId, placedUsd, auditShares, auditPrice, signal);
      this.deps.onDedupFire(`${signal.conditionId}:${signal.outcome}`, Date.now());
      console.log(`[ExecutionEngine] PAPER FILL: ${signal.marketSlug} order=${result.orderId} shares=${auditShares.toFixed(2)} price=${auditPrice.toFixed(3)} usd=${placedUsd.toFixed(2)} dryRun=${decision.value.dryRun}`);
      if (trade?.tokenId) this.deps.onAntiSniperFire(trade.tokenId);
      return { ok: true, orderId: result.orderId };
    } catch {
      this.failed++;
      release();
      return { ok: false, reason: 'order' };
    }
  }
}