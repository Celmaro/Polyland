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
  auditStore: { recordFire: (params: Record<string, unknown>) => unknown };
}

export class ExecutionEngine {
  private readonly ledger: BankrollReservationLedger<string>;
  public failed = 0;
  constructor(
    private readonly tradingService: TradingService,
    private readonly riskManager: RiskManager | null,
    private readonly deps: ExecutionEngineDeps,
    private readonly config: ExecutionEngineConfig,
  ) { this.ledger = new BankrollReservationLedger((category) => deps.bankrollFor(category)); }

  async evaluate(signal: ConsensusSignal, trade: SmartMoneyTrade, basket: BasketConfig): Promise<PipelineDecision<ExecutionDecision>> {
    if (this.riskManager && (!this.riskManager.canTrade() || this.riskManager.isBasketKilled(basket.name))) return { accepted: false, reason: 'risk' };
    const category = basket.category;
    const spent = this.deps.basketSpendGet(category);
    let amount = Math.min(signal.totalSize * this.config.sizeScale * signal.consensusPrice, this.config.maxSizePerTrade);
    if (this.riskManager) amount = this.riskManager.sizeOrder(amount);
    amount = Math.min(amount, Math.max(0, this.deps.bankrollFor(category) - spent));
    const tick = tickSizeToEnum(this.deps.tickSizeFor(signal.conditionId));
    const price = quantizeBuyPrice(signal.consensusPrice * (1 + this.config.maxSlippage), tick);
    const exact = computeExactSharesAndCost(amount, price, tick);
    if (exact.costUsd < this.config.minTradeSize || exact.costUsd < 1) return { accepted: false, reason: 'min_size' };
    const fee = takerFeePerShare(signal.consensusPrice, this.deps.feeRateFor(signal.conditionId) || DEFAULT_FEE_RATE_BPS);
    const edge = signal.winRate - signal.consensusPrice - fee;
    const phase = this.deps.phaseEdge(signal);
    if (edge <= phase.minEdge || signal.winRate < phase.minProb) return { accepted: false, reason: 'edge' };
    if (!this.config.dryRun && trade.tokenId && !(await this.deps.liquidityCheck(trade.tokenId, exact.shares, price))) return { accepted: false, reason: 'liquidity' };
    return { accepted: true, value: { signal, amountUsd: exact.costUsd, price, dryRun: this.config.dryRun } };
  }

  async execute(decision: Extract<PipelineDecision<ExecutionDecision>, { accepted: true }>, trade?: SmartMoneyTrade, basket?: BasketConfig): Promise<{ ok: boolean; orderId?: string }> {
    const { signal, amountUsd, price } = decision.value;
    const category = basket?.category ?? signal.category;
    const release = this.ledger.reserve(category, amountUsd, this.deps.basketSpendGet(category));
    if (!release) { this.failed++; return { ok: false }; }
    try {
      let result: OrderResult;
      if (decision.value.dryRun) result = { success: true, orderId: `dry_run_${Date.now()}` };
      else if (!trade?.tokenId) throw new Error('missing tokenId');
      else result = await this.tradingService.createMarketOrder({ tokenId: trade.tokenId, side: 'BUY', amount: amountUsd, price, orderType: this.config.orderType });
      if (!result.success) { this.failed++; release(); return { ok: false }; }
      this.deps.basketSpendAdd(category, amountUsd);
      this.deps.auditStore.recordFire({ conditionId: signal.conditionId, marketSlug: signal.marketSlug, outcome: signal.outcome, side: signal.side, pricePaid: price, size: amountUsd / price, winRate: signal.winRate, basket: signal.basketName, wallets: signal.wallets });
      this.deps.onPositionOpened(trade?.tokenId, amountUsd, amountUsd / price, price, signal);
      this.deps.onDedupFire(`${signal.conditionId}:${signal.outcome}`, Date.now());
      if (trade?.tokenId) this.deps.onAntiSniperFire(trade.tokenId);
      return { ok: true, orderId: result.orderId };
    } catch { this.failed++; release(); return { ok: false }; }
  }
}
