/** Typed boundary for the post-consensus execution stage. */
import type { TradingService, OrderResult } from './trading-service.js';
import type { RiskManager } from './risk-manager.js';
import type { SmartMoneyTrade } from './smart-money-service.js';
import type { BasketConfig } from './basket-quorum-service.js';
import type { ConsensusSignal, ExecutionDecision, PipelineDecision, RejectReason } from './pipeline-types.js';
import { BankrollReservationLedger } from './bankroll-reservation.js';
import { computeExactSharesAndCost, quantizeBuyPrice, tickSizeToEnum } from '../utils/price-utils.js';
import { takerFeePerShare, DEFAULT_FEE_RATE_BPS } from '../utils/fee-math.js';

export interface ExecutionEngineConfig {
  dryRun: boolean; orderType: 'FOK' | 'FAK'; maxSlippage: number;
  minTradeSize: number; maxSizePerTrade: number; sizeScale: number;
  /** Absolute upper bound on entry price (0-1). Rejects buying near-certain
   * tickets (e.g. >0.85) where risk/reward is structurally bad. */
  maxEntryPrice?: number;
  /** Max age (ms) of the consensus quote before it is stale-cancelled. Default 30s. */
  maxQuoteAgeMs?: number;
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
  auditStore: { recordFire: (params: Record<string, unknown>) => unknown };
}

export class ExecutionEngine {
  private readonly ledger: BankrollReservationLedger<string>;
  public failed = 0;
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
    const tick = tickSizeToEnum(this.deps.tickSizeFor(signal.conditionId));
    const price = quantizeBuyPrice(signal.consensusPrice * (1 + this.config.maxSlippage), tick);
    let exact = computeExactSharesAndCost(amount, price, tick);
    // Sizing floor-clamp: sizing is proportional to the leader's share count,
    // so a thin leader can scale the copy below the minimum order notional.
    // Rather than reject a real consensus outright, clamp UP to minTradeSize
    // when the computed notional is above the $1 dust bound and the edge
    // (checked below) is real. Caps at maxSizePerTrade. This converts the
    // historical min_size rejections (audit: 1047) into executed paper trades.
    if (exact.costUsd < this.config.minTradeSize && exact.costUsd >= 1 && amount < this.config.maxSizePerTrade) {
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
    if (!this.config.dryRun && trade.tokenId && !(await this.deps.liquidityCheck(trade.tokenId, exact.shares, price))) return { accepted: false, reason: 'liquidity' };
    return { accepted: true, value: { signal, amountUsd: exact.costUsd, price, dryRun: this.config.dryRun } };
  }

  async execute(decision: Extract<PipelineDecision<ExecutionDecision>, { accepted: true }>, trade?: SmartMoneyTrade, basket?: BasketConfig): Promise<{ ok: boolean; orderId?: string }> {
    const { signal, amountUsd, price } = decision.value;
    const category = basket?.category ?? signal.category;
    // Stale-quote cancellation: never reserve/route on an expired quote
    // even if evaluate() predates this call (defense in depth).
    const maxQuoteAge = this.config.maxQuoteAgeMs ?? 30_000;
    if (signal.observedAt !== undefined && Date.now() - signal.observedAt > maxQuoteAge) {
      this.failed++;
      this.deps.onStaleQuoteSkip?.();
      console.warn(`[ExecutionEngine] SKIP stale quote: ${signal.marketSlug} age_ms=${Date.now() - signal.observedAt}`);
      return { ok: false };
    }
    const release = this.ledger.reserve(category, amountUsd, this.deps.basketSpendGet(category));
    if (!release) {
      // Bankroll saturation: make the invisible failure visible. The audit
      // (09-07) showed failed=52 vs executed=24 (68% rejection) with zero
      // operator-visible reason. Rate-limited to one line per 60s per category.
      this.failed++;
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
      return { ok: false };
    }
    try {
      let result: OrderResult;
      if (decision.value.dryRun) result = { success: true, orderId: `dry_run_${Date.now()}` };
      else if (!trade?.tokenId) throw new Error('missing tokenId');
      else result = await this.tradingService.createMarketOrder({ tokenId: trade.tokenId, side: 'BUY', amount: amountUsd, price, orderType: this.config.orderType });
      if (!result.success) { this.failed++; release(); return { ok: false }; }
      this.deps.basketSpendAdd(category, amountUsd);
      // Audit pricePaid = the CONSENSUS price, not the slippage-marked limit.
      // The limit is a BUY cost ceiling: recording it systematically understates
      // realized edge and biases the go-live gate. Consensus is the honest
      // executable estimate; replace with the true average fill once order
      // results carry it.
      this.deps.auditStore.recordFire({ conditionId: signal.conditionId, marketSlug: signal.marketSlug, outcome: signal.outcome, side: signal.side, pricePaid: signal.consensusPrice, size: amountUsd / signal.consensusPrice, winRate: signal.winRate, basket: signal.basketName, wallets: signal.wallets, category: signal.category });
      this.deps.onPositionOpened(trade?.tokenId, amountUsd, amountUsd / price, price, signal);
      this.deps.onDedupFire(`${signal.conditionId}:${signal.outcome}`, Date.now());
      if (trade?.tokenId) this.deps.onAntiSniperFire(trade.tokenId);
      return { ok: true, orderId: result.orderId };
    } catch { this.failed++; release(); return { ok: false }; }
  }
}
